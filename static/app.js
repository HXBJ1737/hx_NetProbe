/* NetProbe 前端: 数据加载 / 拓扑可视化 / 任务轮询 */
'use strict';

/* ================= 工具 ================= */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer = null;
function toast(msg, ok = true) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', !ok);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

async function fetchJSON(url, opts) {
  const r = await fetch(url, opts);
  let d;
  try { d = await r.json(); } catch { throw new Error(`HTTP ${r.status}`); }
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

function isPrivate(ip) {
  const p = String(ip || '').split('.').map(Number);
  if (p.length !== 4 || p.some(x => Number.isNaN(x))) return true;
  const [a, b] = p;
  return a === 10 || a === 127 || a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 169 && b === 254);
}

function shortIp(ip) {
  const m = String(ip || '').match(/(\d{1,3})$/);
  return '.' + (m ? m[1] : ip);
}

/* WGS-84 -> GCJ-02 (高德/国内瓦片坐标系纠偏) */
function wgs2gcj(lat, lon) {
  const a = 6378245.0, ee = 0.00669342162296594323;
  const tLat = (x, y) => {
    let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
    r += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
    r += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
    return r;
  };
  const tLon = (x, y) => {
    let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
    r += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
    r += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
    return r;
  };
  let dLat = tLat(lon - 105, lat - 35), dLon = tLon(lon - 105, lat - 35);
  const radLat = lat / 180 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sq = Math.sqrt(magic);
  dLat = (dLat * 180) / ((a * (1 - ee)) / (magic * sq) * Math.PI);
  dLon = (dLon * 180) / (a / sq * Math.cos(radLat) * Math.PI);
  return [lat + dLat, lon + dLon];
}

/* 经纬度 (Web Mercator) -> 全球像素坐标 */
function ll2px(lat, lon, Z) {
  const n = 2 ** Z, T = 256;
  const xf = (lon + 180) / 360 * n;
  const lr = lat * Math.PI / 180;
  const yf = (1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * n;
  return [xf * T, yf * T];
}

/* 全球像素 -> 经纬度 (Web Mercator 逆变换) */
function px2ll(px, py, Z) {
  const n = 2 ** Z;
  const lon = px / (n * 256) * 360 - 180;
  const lr = Math.atan(Math.sinh(Math.PI * (1 - 2 * py / (n * 256))));
  return [lr * 180 / Math.PI, lon];
}

/* 缩放时保持当前视野中心的地理位置不变 */
function zoomTo(nz) {
  nz = Math.min(17, Math.max(4, nz));
  if (nz === GEO.z) return;
  const [alat, alon] = wgs2gcj(GEO.lat, GEO.lon);
  const [ax, ay] = ll2px(alat, alon, GEO.z);
  const fx = (ax + GEO.ox) / (256 * 2 ** GEO.z);
  const fy = (ay + GEO.oy) / (256 * 2 ** GEO.z);
  GEO.z = nz;
  const [ax2, ay2] = ll2px(alat, alon, nz);
  GEO.ox = fx * 256 * 2 ** nz - ax2;
  GEO.oy = fy * 256 * 2 ** nz - ay2;
  drawGeoMap();
}

/* 按 GEO 状态渲染高德瓦片地图: 锚点 📍 + 可选 IP 参考点 ◉ + 平移偏移 */
function drawGeoMap() {
  const box = $('.tile-map');
  if (!box || GEO.lat == null) return;
  let layer = $('.tile-layer', box);
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'tile-layer';
    box.prepend(layer);
  }
  layer.style.transform = '';
  layer.innerHTML = '';

  const Z = GEO.z, T = 256;
  const [alat, alon] = wgs2gcj(GEO.lat, GEO.lon);
  const w = box.clientWidth || 760, h = box.clientHeight || 300;
  const [ax, ay] = ll2px(alat, alon, Z);
  const cx = ax + GEO.ox, cy = ay + GEO.oy;   /* 当前视野中心的全球像素 */

  let total = 0, failed = 0, settled = 0;
  const check = () => {
    if (settled === total && failed > total / 2 && box.isConnected) {
      box.outerHTML = `<div class="map-fallback">
        <div class="fb-icon">📍</div><div>地图瓦片加载失败</div>
        <div class="fb-coord">${esc(GEO.lat)}, ${esc(GEO.lon)}</div></div>`;
    }
  };
  for (let tx = Math.floor((cx - w / 2) / T); tx <= Math.floor((cx + w / 2) / T); tx++) {
    for (let ty = Math.floor((cy - h / 2) / T); ty <= Math.floor((cy + h / 2) / T); ty++) {
      if (ty < 0 || ty >= 2 ** Z) continue;
      total++;
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      img.referrerPolicy = 'no-referrer';
      img.style.left = Math.round(tx * T - (cx - w / 2)) + 'px';
      img.style.top = Math.round(ty * T - (cy - h / 2)) + 'px';
      const s = ((tx % 4) + 4) % 4 + 1;
      img.src = `https://webrd0${s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=${tx}&y=${ty}&z=${Z}`;
      img.onload = () => { settled++; check(); };
      img.onerror = () => { failed++; settled++; check(); };
      layer.appendChild(img);
    }
  }

  /* 主标记 📍: 锚点在当前视野中的屏幕位置 */
  const pin = document.createElement('div');
  pin.className = 'tile-pin';
  pin.title = GEO.precise ? '本机精确定位' : '公网 IP 定位 (城市级)';
  pin.style.left = Math.round(w / 2 - GEO.ox) + 'px';
  pin.style.top = Math.round(h / 2 - GEO.oy) + 'px';
  layer.appendChild(pin);

  /* 精确定位模式下, 同时标出公网 IP 的城市级参考点 (平移到视野内即显示) */
  if (GEO.precise && GEO.ip && GEO.ip.lat != null) {
    const [ilat, ilon] = wgs2gcj(GEO.ip.lat, GEO.ip.lon);
    const [ix, iy] = ll2px(ilat, ilon, Z);
    const sx = ix - (cx - w / 2), sy = iy - (cy - h / 2);
    if (sx > -30 && sx < w + 30 && sy > -30 && sy < h + 30) {
      const m = document.createElement('div');
      m.className = 'tile-pin2';
      m.title = '公网 IP 定位 (城市级参考点)';
      m.style.left = Math.round(sx) + 'px';
      m.style.top = Math.round(sy) + 'px';
      layer.appendChild(m);
    }
  }

  const attrib = $('.tile-attrib', box);
  if (attrib) attrib.textContent = (GEO.precise ? '📍 精确位置 · ◉ IP 参考 · ' : '高德瓦片 · ')
    + `z${Z} · 可拖动 / 滚轮缩放`;
}

/* 选择能同时容纳两个坐标点的缩放级别 (两点像素距离 < 240px) */
function fitZoom(lat1, lon1, lat2, lon2) {
  if (lat2 == null || lon2 == null) return 15;
  const R = 6371000, rad = Math.PI / 180;
  const dx = (lon2 - lon1) * rad * Math.cos(lat1 * rad) * R;
  const dy = (lat2 - lat1) * rad * R;
  const dist = Math.hypot(dx, dy);            // 米
  const mpp = z => 156543.03392 * Math.cos(lat1 * rad) / 2 ** z;  // 米/像素
  for (let z = 17; z >= 4; z--) {
    if (dist / mpp(z) < 240) return z;
  }
  return 4;
}

/* 浏览器精确定位 (GPS/WiFi, 需授权; 127.0.0.1 属安全上下文可用) */
function doPreciseLocate() {
  if (!navigator.geolocation) {
    toast('当前浏览器不支持精确定位, 请用 Chrome/Edge 打开本页面', false);
    return;
  }
  toast('正在请求定位权限, 请在弹窗中允许…');
  navigator.geolocation.getCurrentPosition(pos => {
    GEO.precise = {
      lat: pos.coords.latitude, lon: pos.coords.longitude,
      acc: pos.coords.accuracy,
    };
    GEO.lat = GEO.precise.lat;
    GEO.lon = GEO.precise.lon;
    GEO.z = fitZoom(GEO.precise.lat, GEO.precise.lon,
      GEO.ip && GEO.ip.lat, GEO.ip && GEO.ip.lon);
    renderPublic();
    toast(`精确定位成功 (±${Math.round(pos.coords.accuracy)} 米)`);
  }, err => {
    const why = err.code === 1 ? '未授权位置权限'
      : err.code === 2 ? '位置不可用 (尝试用 Chrome/Edge 打开)'
      : '定位超时';
    toast('精确定位失败: ' + why, false);
  }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
}

/* ================= 全局状态 ================= */
const S = {
  overview: null, pub: null, geo: {},
  scan: null, trace: null,
  chart: null,
  jobs: { scan: null, trace: null },   /* 运行中的任务 id */
};

/* 地图状态: 锚点(📍)/缩放/平移偏移/精确定位结果/IP 级参考点 */
const GEO = { lat: null, lon: null, z: 12, ox: 0, oy: 0, precise: null, ip: null };

const CATS = [
  { name: '本机', itemStyle: { color: '#22d3ee' } },
  { name: '网关', itemStyle: { color: '#f59e0b' } },
  { name: '在线设备', itemStyle: { color: '#34d399' } },
  { name: '缓存设备', itemStyle: { color: '#64748b' } },
  { name: '公网跃点', itemStyle: { color: '#a78bfa' } },
  { name: '追踪目标', itemStyle: { color: '#f87171' } },
];
const CAT = { LOCAL: 0, GW: 1, ALIVE: 2, CACHE: 3, HOP: 4, TARGET: 5 };

/* ================= 概览 ================= */
function primaryAdapter() {
  const ov = S.overview || {};
  return (ov.adapters || []).find(a => a.name === ov.primary) || null;
}

async function loadAll() {
  $('#btn-refresh').disabled = true;
  const [ov, pub] = await Promise.allSettled([
    fetchJSON('/api/overview'),
    fetchJSON('/api/public'),
  ]);
  if (ov.status === 'fulfilled') {
    S.overview = ov.value;
    renderOverview();
    renderAdaptersTable();
    renderRoutesTable();
    renderConnTable();
    updateChips();
    drawTopo();
  } else {
    toast('概览加载失败: ' + (ov.reason.message || ov.reason), false);
  }
  if (pub.status === 'fulfilled') {
    S.pub = pub.value;
  } else {
    S.pub = { error: String(pub.reason.message || pub.reason) };
  }
  renderPublic();
  $('#btn-refresh').disabled = false;
}

function updateChips() {
  const ov = S.overview || {};
  const conns = (ov.connections || []).length;
  const chips = [
    [(ov.neighbors || []).length, 'ARP 邻居'],
    [S.scan ? S.scan.alive_count : '--', '在线设备(扫描)'],
    [(ov.routes || []).length, '路由条目'],
    [conns, 'TCP 连接'],
  ];
  $('#stat-chips').innerHTML = chips.map(([v, l]) =>
    `<span class="chip"><b>${esc(v)}</b><span>${esc(l)}</span></span>`).join('');
}

function kvRows(pairs) {
  return '<dl class="kv">' + pairs.filter(([k]) => k).map(([k, v]) =>
    `<dt>${esc(k)}</dt><dd>${v === '' || v == null ? '--' : esc(v)}</dd>`).join('') + '</dl>';
}

function renderOverview() {
  const ov = S.overview, h = ov.host || {}, p = primaryAdapter() || {};
  const vendor = p.vendor || macVendor(p.mac);
  const activeN = (ov.adapters || []).filter(a => a.ipv4 && a.connected).length;

  const cards = [];
  cards.push(`<div class="card"><div class="card-title">主机信息</div>${kvRows([
    ['主机名', h.hostname],
    ['操作系统', `${h.os || ''} (${h.os_version || ''})`],
    ['开机时长', h.uptime_hours != null ? h.uptime_hours + ' 小时' : ''],
    ['DNS 后缀', h.dns_suffix],
    ['适配器', `${(ov.adapters || []).length} 个 / 活动 ${activeN} 个`],
  ])}</div>`);

  if (p.ipv4) {
    cards.push(`<div class="card"><div class="card-title">主网络接口${p.name ? ' · ' + esc(p.name.replace(/^(以太网适配器|无线局域网适配器)\s*/, '')) : ''}</div>${kvRows([
      ['IPv4', p.ipv4],
      ['子网掩码', p.mask],
      ['MAC', p.mac],
      ['厂商', vendor],
      ['IPv6', (p.ipv6 || [])[0] || ''],
      ['默认网关', p.gateway || ov.default_gateway],
      ['DHCP', p.dhcp],
      ['DNS', (p.dns || []).join(', ')],
    ])}</div>`);
  }

  if (ov.wifi && ov.wifi.ssid) {
    const w = ov.wifi;
    cards.push(`<div class="card"><div class="card-title">Wi-Fi 接入点</div>${kvRows([
      ['SSID', w.ssid],
      ['BSSID', w.bssid],
      ['信号', w.signal],
      ['信道', w.channel],
      ['认证', w.auth],
      ['状态', w.state],
    ])}</div>`);
  }
  $('#ov-cards').innerHTML = cards.join('');
}

function macVendor(mac) {
  const n = (S.overview && S.overview.neighbors) || [];
  const hit = n.find(x => x.mac && mac && x.mac.replace(/-/g, '') === mac.replace(/-/g, ''));
  return hit ? hit.vendor : '';
}

function renderAdaptersTable() {
  const ov = S.overview || {};
  const rows = (ov.adapters || []).map(a => `<tr${a.name === ov.primary ? ' style="color:#fff;font-weight:600"' : ''}>
    <td>${esc(a.name)}</td><td>${esc(a.ipv4 || '--')}</td><td>${esc(a.mask || '--')}</td>
    <td>${esc(a.mac || '--')}${a.mac && a.vendor ? ' · ' + esc(a.vendor) : ''}</td>
    <td>${esc((a.dns || [])[0] || '--')}${(a.dns || []).length > 1 ? ' +' + (a.dns.length - 1) : ''}</td>
    <td>${a.ipv4 ? (a.connected ? '已连接' : '异常') : '未连接'}</td></tr>`).join('');
  $('#adapters-table tbody').innerHTML = rows ||
    '<tr><td colspan="6" class="empty">未解析到适配器</td></tr>';
}

function renderPublic() {
  const p = S.pub || {};
  const pill = $('#pill-public'), txt = $('#geo-text'), map = $('#geo-map');
  $('#pill-local').textContent = '内网 ' + ((primaryAdapter() || {}).ipv4 || '--');

  if (p.error) {
    pill.textContent = '公网 --';
    txt.innerHTML = `⚠ ${esc(p.error)}`;
    return;
  }
  pill.textContent = '公网 ' + (p.ip || '--');
  $('#geo-src').textContent = '数据源: ' + (p.source || '');
  GEO.ip = { lat: p.lat, lon: p.lon };
  if (!GEO.precise) { GEO.lat = p.lat; GEO.lon = p.lon; }

  const lines = [
    ['公网 IP', `<b>${esc(p.ip)}</b>`],
    ['运营商', `<b>${esc(p.isp || '--')}</b>`],
    [' ASN', esc(p.asn || '--')],
    ['位置', `<b>${esc([p.country, p.region, p.city].filter(Boolean).join(' · '))}</b>`],
    ['时区', esc(p.timezone || '--')],
    ['经纬度', p.lat != null ? `${p.lat}, ${p.lon}` : '--'],
  ];
  if (GEO.precise) {
    lines.push(['本机精确定位',
      `<b>${GEO.precise.lat.toFixed(5)}, ${GEO.precise.lon.toFixed(5)}</b> (±${Math.round(GEO.precise.acc)} 米)`]);
  }
  txt.innerHTML = lines.map(([k, v]) => `${k}: ${v}`).join('<br>') +
    `<button class="btn" id="btn-precise">📍 定位到本机实际位置</button>` +
    (GEO.precise
      ? `<div class="geo-note">📍 为本机精确定位 · ◉ 为公网 IP 城市级参考点</div>`
      : `<div class="geo-note">IP 定位仅为城市级参考点; 点击按钮可获取本机精确位置 (需授权)</div>`);

  const wrap = $('#geo-map-wrap');
  const d = 0.12;
  if (GEO.lat != null && GEO.lon != null) {
    const inChina = GEO.lat > 3 && GEO.lat < 54 && GEO.lon > 73 && GEO.lon < 135;
    const osmEmbed = `https://www.openstreetmap.org/export/embed.html?bbox=${GEO.lon - d},${GEO.lat - d / 2},${GEO.lon + d},${GEO.lat + d / 2}&layer=mapnik&marker=${GEO.lat},${GEO.lon}`;
    /* 桌面端直达 ditu.amap.com, 避免 uri.amap.com 的 302 跳转 */
    const amapUrl = `https://ditu.amap.com/regeo?lng=${GEO.lon}&lat=${GEO.lat}&src=netprobe`;
    const osmUrl = `https://www.openstreetmap.org/?mlat=${GEO.lat}&mlon=${GEO.lon}#map=12/${GEO.lat}/${GEO.lon}`;
    const links = `<div class="map-links">
        <a class="btn primary" href="${amapUrl}" target="_blank" rel="noopener">在高德地图中查看</a>
        <a class="btn" href="${osmUrl}" target="_blank" rel="noopener">OpenStreetMap</a>
      </div>`;
    if (inChina) {
      /* 国内: 高德瓦片内嵌拼图 (免 key, GCJ-02 纠偏, 可拖动/缩放) */
      wrap.innerHTML = `<div class="tile-map">
          <div class="tile-zoom">
            <button data-dz="1" title="放大">＋</button>
            <button data-dz="-1" title="缩小">－</button>
            <button data-act="center" title="回到标记点">◎</button>
          </div>
          <div class="tile-attrib"></div></div>${links}`;
      drawGeoMap();
    } else if (p.map_osm) {
      wrap.innerHTML = `<iframe id="geo-map" title="地理位置地图" loading="lazy"
          src="${osmEmbed}"></iframe>${links}`;
    } else {
      wrap.innerHTML = `<div class="map-fallback">
          <div class="fb-icon">📍</div>
          <div>OpenStreetMap 当前网络不可达</div>
          <div class="fb-coord">${esc(GEO.lat)}, ${esc(GEO.lon)}</div>
          <div class="fb-links">
            <a class="btn primary" href="${amapUrl}" target="_blank" rel="noopener">在高德地图中查看</a>
            <a class="btn" href="${osmUrl}" target="_blank" rel="noopener">OpenStreetMap</a>
          </div></div>`;
    }
  }
}

/* ================= 表格: 路由 ================= */
function renderRoutesTable() {
  const q = $('#route-filter').value.trim().toLowerCase();
  const rs = ((S.overview || {}).routes || []).filter(r =>
    !q || [r.dest, r.mask, r.gateway, r.interface].join(' ').toLowerCase().includes(q));
  const badge = t => t === '默认路由'
    ? '<span class="badge def">默认路由</span>'
    : `<span class="badge grey">${esc(t)}</span>`;
  $('#routes-table tbody').innerHTML = rs.map(r => `<tr>
    <td>${esc(r.dest)}</td><td>${esc(r.mask)}</td>
    <td>${esc(r.gateway)}</td><td>${esc(r.interface)}</td>
    <td>${esc(r.metric)}</td><td>${badge(r.type)}</td></tr>`).join('') ||
    '<tr><td colspan="6" class="empty">无匹配路由</td></tr>';
  $('#route-count').textContent = `共 ${rs.length} 条`;
}

/* ================= 表格: 连接 ================= */
function renderConnTable() {
  const st = $('#conn-state').value;
  const q = $('#conn-q').value.trim().toLowerCase();
  const cs = ((S.overview || {}).connections || []).filter(c =>
    (st === 'ALL' || c.state === st) &&
    (!q || [c.local, c.remote, c.process, c.pid].join(' ').toLowerCase().includes(q)));
  const color = s => s === 'ESTABLISHED' ? 'pub' : (s === 'LISTENING' ? 'grey' : 'grey');
  $('#conn-table tbody').innerHTML = cs.slice(0, 500).map(c => `<tr>
    <td>${esc(c.proto)}</td><td>${esc(c.local)}</td><td>${esc(c.remote)}</td>
    <td><span class="badge ${color(c.state)}">${esc(c.state)}</span></td>
    <td>${esc(c.pid)}</td><td>${esc(c.process)}</td></tr>`).join('') ||
    '<tr><td colspan="6" class="empty">无匹配连接</td></tr>';
  $('#conn-count').textContent = `共 ${cs.length} 条 (显示前 500)`;
}

/* ================= 表格: 追踪 ================= */
function renderTraceTable() {
  const t = S.trace;
  const tb = $('#trace-table tbody');
  if (!t) return;
  $('#trace-note').textContent = t.running ? '追踪中…'
    : (t.done ? `目标 ${t.target} · ${t.hops.length} 跳` : '');
  if (!t.hops.length) {
    if (t.running) tb.innerHTML = '<tr><td colspan="7" class="empty">正在发起追踪…</td></tr>';
    return;
  }
  tb.innerHTML = t.hops.map(h => {
    const geo = h.ip && S.geo[h.ip];
    return `<tr>
      <td>${h.hop}</td>
      <td>${h.ip ? esc(h.ip) : '*'}</td>
      <td>${h.ip ? (isPrivate(h.ip)
        ? '<span class="badge priv">内网</span>'
        : '<span class="badge pub">公网</span>') : '--'}</td>
      <td>${h.rtt_min != null ? h.rtt_min + ' ms' : '--'}</td>
      <td>${h.rtt_avg != null ? h.rtt_avg + ' ms' : '--'}</td>
      <td>${geo ? esc(geo.loc + ' · ' + geo.isp) : (h.ip && !isPrivate(h.ip) ? '查询中…' : '')}</td>
      <td>${h.timeout ? '<span class="badge err">超时</span>' : '<span class="badge priv">应答</span>'}</td>
    </tr>`;
  }).join('');
}

/* ================= 拓扑图 ================= */
function ensureChart() {
  if (S.chart || !window.echarts) return;
  S.chart = echarts.init($('#topo-chart'));
  S.chart.on('click', params => {
    if (params.dataType === 'node' && params.data && params.data.value) {
      showNodeDetail(params.data);
    }
  });
  drawTopo();
}

function mkNode(id, label, x, y, size, cat, value, labelPos) {
  const big = cat === CAT.LOCAL || cat === CAT.GW || cat === CAT.TARGET;
  return {
    id, name: label, x, y, symbolSize: size, category: cat, value,
    label: {
      show: true, position: labelPos || 'bottom',
      fontSize: big ? 12 : 9, color: big ? '#f1f5f9' : '#9fb2cc',
      fontWeight: big ? 600 : 400, formatter: label,
    },
    itemStyle: { borderColor: '#0b1220', borderWidth: 1.5 },
  };
}

function topoData() {
  const nodes = [], links = [];
  const ov = S.overview || {};
  const gw = ov.default_gateway || '';
  const p = primaryAdapter() || {};
  const localIp = p.ipv4 || '(无 IPv4)';

  nodes.push(mkNode('local', '本机\n' + localIp, 0, -330, 54, CAT.LOCAL, {
    kind: '本机', ip: localIp, mac: p.mac,
    vendor: p.vendor || macVendor(p.mac) || undefined,
    extra: `${esc(ov.host && ov.host.hostname || '')}`,
  }));
  const gwN = (ov.neighbors || []).find(n => n.ip === gw);
  nodes.push(mkNode('gw', '网关\n' + (gw || '?'), 0, 0, 46, CAT.GW, {
    kind: '网关(默认路由)', ip: gw, mac: gwN && gwN.mac,
    vendor: gwN && gwN.vendor, priv: true,
  }));
  links.push({
    source: 'local', target: 'gw',
    lineStyle: { width: 3.5, color: '#22d3ee', curveness: 0 },
  });

  /* --- 局域网设备: 扫描在线 + ARP 缓存 --- */
  const devMap = new Map();
  (ov.neighbors || []).forEach(n => {
    if (n.ip !== gw && n.ip !== localIp) {
      devMap.set(n.ip, { ip: n.ip, mac: n.mac, vendor: n.vendor,
        arpType: n.type_label, alive: false, rtt: null });
    }
  });
  ((S.scan && S.scan.devices) || []).forEach(d => {
    if (d.role !== 'device') return;
    const e = devMap.get(d.ip) || { ip: d.ip, mac: d.mac, vendor: d.vendor, arpType: '-' };
    Object.assign(e, { mac: d.mac || e.mac, vendor: d.vendor || e.vendor,
      alive: true, rtt: d.rtt });
    devMap.set(d.ip, e);
  });

  const devsAll = [...devMap.values()].sort((a, b) =>
    String(a.ip).localeCompare(String(b.ip), undefined, { numeric: true }));
  /* 在线设备全部显示; 纯 ARP 缓存设备过多时截断, 用汇总节点代替 */
  const CACHE_MAX = 40;
  const aliveDevs = devsAll.filter(d => d.alive);
  const cacheDevs = devsAll.filter(d => !d.alive);
  const shownCache = cacheDevs.slice(0, CACHE_MAX);
  const cacheExtra = cacheDevs.length - shownCache.length;
  const devs = [...aliveDevs, ...shownCache];
  /* 设备过多时隐藏所有设备标签 (悬停 tooltip 查看详情), 保持图面可读 */
  const hideDevLabels = devs.length > 40;
  const R = 240 + Math.min(devs.length, 70) * 3.2;
  devs.forEach((d, i) => {
    /* 围绕网关的圆弧 (屏幕角度 5°..215°, 顶部 270° 让位给本机) */
    const t = devs.length === 1 ? 0.45 : i / (devs.length - 1);
    const ang = (5 + 210 * t) * Math.PI / 180;
    const id = 'dev:' + d.ip;
    const node = mkNode(id, shortIp(d.ip), Math.cos(ang) * R, Math.sin(ang) * R,
      d.alive ? 20 : 11, d.alive ? CAT.ALIVE : CAT.CACHE, {
        kind: d.alive ? '局域网设备 · 在线' : '局域网设备 · ARP 缓存',
        ip: d.ip, mac: d.mac, vendor: d.vendor, rtt: d.rtt,
        arp: d.arpType, priv: true,
      }, 'right');
    if (hideDevLabels && d.alive) node.label.show = false;
    nodes.push(node);
    links.push({
      source: id, target: 'gw',
      lineStyle: {
        width: d.alive ? 1.8 : 1, color: d.alive ? '#34d399' : '#3b4a63',
        type: d.alive ? 'solid' : 'dashed', curveness: 0,
      },
    });
  });
  if (cacheExtra > 0) {
    const ang = (5 + 210 * (devs.length ? 1 : 0.5)) * Math.PI / 180;
    nodes.push(mkNode('dev:more', `+${cacheExtra} 台缓存`, Math.cos(ang) * (R + 26),
      Math.sin(ang) * (R + 26), 14, CAT.CACHE,
      { kind: '未展示的 ARP 缓存设备', ip: `${cacheExtra} 台 (执行扫描可见在线状态)` }, 'right'));
    links.push({
      source: 'dev:more', target: 'gw',
      lineStyle: { width: 1, color: '#3b4a63', type: 'dashed', curveness: 0 },
    });
  }

  /* --- 追踪链路: 蛇形排布 --- */
  const t = S.trace;
  if (t && t.hops && t.hops.length) {
    const chain = t.hops.filter(h => h.ip && h.ip !== gw);
    const cols = 6, sx = 620, sy = -280, dx = 170, dy = 150;
    let prev = 'gw';
    let firstPublic = true;
    chain.forEach((h, i) => {
      const row = Math.floor(i / cols);
      const col = row % 2 ? cols - 1 - (i % cols) : i % cols;
      const x = sx + col * dx + (row % 2 ? 0 : 0);
      const y = sy + row * dy;
      const isTarget = t.done && i === chain.length - 1;
      const pub = !isPrivate(h.ip);
      let name = '跃点 ' + h.hop;
      if (isTarget) name = '目标\n' + (t.target || h.ip);
      else if (pub && firstPublic) { name = '公网出口'; firstPublic = false; }
      const id = 'hop:' + h.hop;
      const geo = S.geo[h.ip];
      nodes.push(mkNode(id, name + (isTarget || !pub || name.startsWith('公网') ? '' : '\n' + h.ip),
        x, y, isTarget ? 36 : 18, isTarget ? CAT.TARGET : CAT.HOP, {
          kind: isTarget ? '追踪目标' : '路由跃点 #' + h.hop,
          ip: h.ip, hop: h.hop, priv: !pub,
          rtt_avg: h.rtt_avg, rtt_min: h.rtt_min,
          geo: geo ? geo.loc + ' · ' + geo.isp : undefined,
        }));
      links.push({
        source: prev, target: id, symbol: ['none', 'arrow'], symbolSize: [6, 8],
        lineStyle: { width: 2, color: isTarget ? '#f87171' : '#a78bfa' },
        label: {
          show: h.rtt_avg != null, formatter: h.rtt_avg + ' ms',
          fontSize: 9, color: '#8fa3bd',
        },
      });
      prev = id;
    });
  }
  return { nodes, links };
}

function drawTopo() {
  if (!S.chart) return;
  const { nodes, links } = topoData();
  let zoom;
  try {
    const old = S.chart.getOption();
    if (old && old.series && old.series[0] && old.series[0].zoom) zoom = old.series[0].zoom;
  } catch { /* ignore */ }
  S.chart.setOption({
    backgroundColor: 'transparent',
    legend: [{
      data: CATS.map(c => c.name), bottom: 10, left: 14,
      textStyle: { color: '#8fa3bd', fontSize: 11 },
      itemWidth: 14, itemHeight: 9,
    }],
    series: [{
      type: 'graph', layout: 'none', roam: true, zoom: zoom ?? 0.9,
      categories: CATS, data: nodes, links,
      labelLayout: { hideOverlap: true },
      emphasis: { focus: 'adjacency' },
      lineStyle: { color: '#475569', curveness: 0.05 },
      tooltip: {
        confine: true, backgroundColor: 'rgba(13,21,38,.96)',
        borderColor: '#334155', textStyle: { color: '#e2e8f0', fontSize: 12 },
        formatter: p => {
          if (p.dataType !== 'node' || !p.data.value) return esc(p.name);
          const v = p.data.value, r = [`<b style="color:#22d3ee">${esc(v.kind)}</b>`];
          if (v.ip) r.push(`IP: <b>${esc(v.ip)}</b> ${v.priv === false ? '🌐 公网' : (v.priv ? '🏠 内网' : '')}`);
          if (v.mac) r.push(`MAC: ${esc(v.mac)}`);
          if (v.vendor) r.push(`厂商: ${esc(v.vendor)}`);
          if (v.rtt != null) r.push(`延迟: ${v.rtt} ms`);
          if (v.rtt_avg != null) r.push(`平均延迟: ${v.rtt_avg} ms`);
          if (v.geo) r.push(`归属: ${esc(v.geo)}`);
          if (v.arp) r.push(`ARP 记录: ${esc(v.arp)}`);
          return r.join('<br>');
        },
      },
    }],
  }, { replaceMerge: ['series'] });
}

function showNodeDetail(data) {
  const v = data.value || {};
  const el = $('#node-detail');
  el.innerHTML = `<button class="close" title="关闭">✕</button><h3>${esc(v.kind || '节点')}</h3>` +
    kvRows([
      ['IP', v.ip], ['MAC', v.mac], ['厂商', v.vendor],
      ['延迟', v.rtt_avg != null ? v.rtt_avg + ' ms' : (v.rtt != null ? v.rtt + ' ms' : '')],
      ['归属', v.geo], ['跃点', v.hop ? '#' + v.hop : ''],
      ['网络', v.priv === false ? '公网' : (v.priv ? '内网' : '')],
      ['ARP', v.arp],
    ]);
  el.hidden = false;
  $('.close', el).onclick = () => { el.hidden = true; };
}

/* ================= 后台任务 ================= */
function pollJob(id, onTick) {
  return new Promise((resolve, reject) => {
    const timer = setInterval(async () => {
      let job;
      try { job = await fetchJSON('/api/jobs/' + id); }
      catch { return; /* 网络抖动, 下次再试 */ }
      onTick && onTick(job);
      if (job.status === 'done' || job.status === 'cancelled') {
        clearInterval(timer); resolve(job);
      } else if (job.status === 'error') {
        clearInterval(timer); reject(new Error(job.error || '任务失败'));
      }
    }, 800);
  });
}

async function stopJob(kind) {
  const id = S.jobs[kind];
  if (!id) return;
  try {
    await fetchJSON(`/api/jobs/${id}/cancel`, { method: 'POST' });
    toast(kind === 'scan' ? '正在停止扫描…' : '正在停止追踪…');
  } catch {
    toast('任务可能已结束');
  }
}

function setProgress(sel, done, total, label) {
  const box = $(sel);
  if (total && done >= total) { box.hidden = true; return; }
  box.hidden = false;
  const pct = total ? Math.round(done / total * 100) : 0;
  $('.progress-bar', box).style.setProperty('--p', pct + '%');
  $('.progress-text', box).textContent = label || `${done}/${total} (${pct}%)`;
}

async function startScan() {
  $('#btn-scan').disabled = true;
  $('#btn-stop-scan').hidden = false;
  const box = $('#scan-progress');
  box.hidden = false;
  $('.progress-text', box).textContent = '准备扫描…';
  try {
    const { id } = await fetchJSON('/api/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'scan' }),
    });
    S.jobs.scan = id;
    const job = await pollJob(id, j => {
      const pr = j.progress || {};
      setProgress('#scan-progress', pr.done, pr.total,
        `正在探测 ${pr.done}/${pr.total} 个地址…`);
    });
    S.scan = job.result;
    box.hidden = true;
    /* 刷新 ARP 邻居 (扫描会填充新表项) */
    try {
      const nb = await fetchJSON('/api/neighbors');
      if (S.overview) S.overview.neighbors = nb.neighbors;
      renderAdaptersTable();
    } catch { /* ignore */ }
    updateChips();
    drawTopo();
    const r = S.scan;
    toast(job.status === 'cancelled'
      ? `已停止扫描: 已发现 ${r.alive_count} 台在线 (部分结果)`
      : `扫描完成: ${r.network} 中 ${r.alive_count} 台在线 / 共探测 ${r.scanned} 个地址`);
  } catch (e) {
    box.hidden = true;
    toast('扫描失败: ' + e.message, false);
  } finally {
    $('#btn-scan').disabled = false;
    $('#btn-stop-scan').hidden = true;
    S.jobs.scan = null;
  }
}

function traceTarget() {
  const v = ($('#trace-target2').value || $('#trace-target').value || '').trim();
  return v || '114.114.114.114';
}

async function startTrace() {
  const target = traceTarget();
  $('#trace-target').value = target;
  $('#trace-target2').value = target;
  ['#btn-trace', '#btn-trace-topo'].forEach(s => { $(s).disabled = true; });
  ['#btn-stop-trace', '#btn-stop-trace-topo'].forEach(s => { $(s).hidden = false; });
  S.trace = { target, hops: [], running: true, done: false };
  renderTraceTable();
  ensureChart();
  drawTopo();
  const box = $('#trace-progress');
  box.hidden = false;
  $('.progress-text', box).textContent = '追踪中…';
  try {
    const { id } = await fetchJSON('/api/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'trace', target }),
    });
    S.jobs.trace = id;
    const job = await pollJob(id, j => {
      if (j.result && j.result.hops) S.trace.hops = j.result.hops;
      const pr = j.progress || {};
      $('.progress-text', box).textContent = `已发现 ${pr.done} 跳…`;
      renderTraceTable();
      drawTopo();
    });
    S.trace = { target, hops: job.result.hops || [], running: false, done: job.status === 'done' };
    box.hidden = true;
    renderTraceTable();
    drawTopo();
    toast(job.status === 'cancelled'
      ? `已停止追踪: 已获得 ${S.trace.hops.length} 跳 (部分结果)`
      : `追踪完成: 目标 ${target}, 共 ${S.trace.hops.length} 跳`);
    await fetchHopGeo();
    renderTraceTable();
    drawTopo();
  } catch (e) {
    box.hidden = true;
    S.trace.running = false;
    toast('追踪失败: ' + e.message, false);
  } finally {
    ['#btn-trace', '#btn-trace-topo'].forEach(s => { $(s).disabled = false; });
    ['#btn-stop-trace', '#btn-stop-trace-topo'].forEach(s => { $(s).hidden = true; });
    S.jobs.trace = null;
  }
}

function clearTrace() {
  if (S.trace && S.trace.running) { toast('追踪进行中, 请先停止', false); return; }
  if (!S.trace) { toast('当前没有追踪链路'); return; }
  S.trace = null;
  S.geo = {};
  $('#trace-note').textContent = '';
  $('#trace-table tbody').innerHTML =
    '<tr><td colspan="7" class="empty">尚未发起追踪, 点击「开始追踪」(tracert 最多 20 跳, 约 10-40 秒)</td></tr>';
  drawTopo();
  toast('已清空追踪链路');
}

async function fetchHopGeo() {
  const ips = ((S.trace && S.trace.hops) || [])
    .filter(h => h.ip && !isPrivate(h.ip)).map(h => h.ip);
  if (!ips.length) { S.geo = {}; return; }
  try {
    const d = await fetchJSON('/api/geoips', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ips }),
    });
    S.geo = d.map || {};
  } catch { S.geo = {}; }
}

/* ================= 初始化 ================= */
function wireEvents() {
  $$('.tab').forEach(t => t.addEventListener('click', () => {
    $$('.tab').forEach(x => x.classList.toggle('active', x === t));
    $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + t.dataset.tab));
    if (t.dataset.tab === 'topo') { ensureChart(); S.chart && S.chart.resize(); }
  }));

  $('#btn-refresh').addEventListener('click', loadAll);
  $('#btn-scan').addEventListener('click', startScan);
  $('#btn-trace').addEventListener('click', startTrace);
  $('#btn-trace-topo').addEventListener('click', startTrace);
  $('#btn-stop-scan').addEventListener('click', () => stopJob('scan'));
  $('#btn-stop-trace').addEventListener('click', () => stopJob('trace'));
  $('#btn-stop-trace-topo').addEventListener('click', () => stopJob('trace'));
  $('#btn-clear-trace').addEventListener('click', clearTrace);
  $('#btn-clear-trace2').addEventListener('click', clearTrace);
  $('#btn-resetview').addEventListener('click', () => {
    if (!S.chart) return;
    S.chart.setOption({ series: [{ zoom: 0.9, center: ['50%', '50%'] }] });
    S.chart.dispatchAction({ type: 'graphRoam', zoom: 1 });
  });
  /* 两个目标输入框联动 */
  ['#trace-target', '#trace-target2'].forEach(s1 => {
    $(s1).addEventListener('input', () => {
      const other = s1 === '#trace-target' ? '#trace-target2' : '#trace-target';
      $(other).value = $(s1).value;
    });
  });

  $('#route-filter').addEventListener('input', renderRoutesTable);
  $('#conn-state').addEventListener('change', renderConnTable);
  $('#conn-q').addEventListener('input', renderConnTable);

  /* 地图交互 (委托: 地图随数据刷新会被重建) */
  document.addEventListener('click', e => {
    const zb = e.target.closest('.tile-zoom button');
    if (!zb) {
      if (e.target.closest('#btn-precise')) doPreciseLocate();
      return;
    }
    if (zb.dataset.act === 'center') {
      GEO.ox = 0; GEO.oy = 0;
      drawGeoMap();
    } else {
      zoomTo(GEO.z + Number(zb.dataset.dz));
    }
  });
  document.addEventListener('wheel', e => {
    if (!e.target.closest('.tile-map')) return;
    e.preventDefault();
    zoomTo(GEO.z + (e.deltaY < 0 ? 1 : -1));
  }, { passive: false });

  /* 地图拖动平移: 拖动中 transform 跟随指针, 松手后重绘补瓦片 */
  let drag = null;
  document.addEventListener('pointerdown', e => {
    const box = e.target.closest('.tile-map');
    if (!box || e.target.closest('.tile-zoom') || e.button !== 0) return;
    const layer = box.querySelector('.tile-layer');
    if (!layer) return;
    drag = { box, layer, x0: e.clientX, y0: e.clientY, ox: GEO.ox, oy: GEO.oy, moved: false };
    box.classList.add('dragging');
  });
  document.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    drag.layer.style.transform = `translate(${dx}px, ${dy}px)`;
  });
  const endDrag = e => {
    if (!drag) return;
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    drag.box.classList.remove('dragging');
    if (drag.moved) {
      GEO.ox = drag.ox - dx;   /* 内容随指针移动 = 视野中心反向偏移 */
      GEO.oy = drag.oy - dy;
      drawGeoMap();
    } else {
      drag.layer.style.transform = '';
    }
    drag = null;
  };
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);

  window.addEventListener('resize', () => S.chart && S.chart.resize());

  const clock = () => {
    $('#clock').textContent = new Date().toLocaleString('zh-CN', { hour12: false });
  };
  clock();
  setInterval(clock, 1000);
}

window.addEventListener('DOMContentLoaded', () => {
  wireEvents();
  loadAll();
  /* 若 ECharts 加载失败, 提示但不阻塞其它功能 */
  setTimeout(() => {
    if (!window.echarts) toast('ECharts 未能加载, 拓扑图不可用 (其它功能正常)', false);
  }, 4000);
});
