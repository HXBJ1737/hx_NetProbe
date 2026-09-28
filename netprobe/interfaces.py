"""网卡信息: 解析 ipconfig /all 与 netsh wlan show interfaces。"""
import platform
import re

from . import oui
from .utils import IPV4_RE, run_cmd

# 标签 -> (中文, 英文); 匹配时会去掉点号和空格再比较
_LABELS = {
    'desc':       ('描述', 'Description'),
    'mac':        ('物理地址', 'PhysicalAddress'),
    'ipv4':       ('IPv4地址', 'IPv4Address'),
    'mask':       ('子网掩码', 'SubnetMask'),
    'gw':         ('默认网关', 'DefaultGateway'),
    'dhcp':       ('DHCP已启用', 'DHCPEnabled'),
    'dns':        ('DNS服务器', 'DNSServers'),
    'state':      ('媒体状态', 'MediaState'),
    'dns_suffix': ('连接特定的DNS后缀', 'ConnectionspecificDNSSuffix'),
    'host':       ('主机名', 'HostName'),
    'primary_dns_suffix': ('主DNS后缀', 'PrimaryDNSSuffix'),
}


def _norm_key(s: str) -> str:
    return re.sub(r'[.\s]', '', s)


def _label_map():
    m = {}
    for key, aliases in _LABELS.items():
        for a in aliases:
            m[_norm_key(a)] = key
    return m


_KV_RE = re.compile(r'^\s*(.+?)\s*(?:\.+\s*)?:\s*(.*)$')


def _parse_ipconfig(text: str):
    """返回 (host_info, adapters)。按“行首无缩进且以冒号结尾”切分适配器块。"""
    labels = _label_map()
    host, adapters, current = {}, [], None

    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue
        # 新适配器块: 行首无空格且以冒号结尾, 如 “以太网适配器 以太网:”
        if not raw[0].isspace() and line.endswith(':') and (
                '适配器' in line or 'adapter' in line.lower()):
            current = {
                'name': line[:-1].strip(),
                'desc': '', 'mac': '', 'ipv4': '', 'mask': '',
                'gateway': '', 'dns': [], 'dhcp': '', 'state': '',
                'ipv6': [], 'connected': True,
            }
            adapters.append(current)
            continue

        # DNS 服务器等标签的换行续写: 整行只有一个缩进 IP、无冒号
        stripped = line.strip()
        if (current is not None and current['dns'] and raw[:1].isspace()
                and IPV4_RE.fullmatch(stripped)
                and stripped not in current['dns']):
            current['dns'].append(stripped)
            continue

        m = _KV_RE.match(line)
        if not m:
            continue
        key = labels.get(_norm_key(m.group(1)))
        val = m.group(2).strip()

        if current is None:
            # 顶部主机信息块
            if key == 'host':
                host['hostname'] = val
            elif key == 'primary_dns_suffix':
                host['dns_suffix'] = val
            continue

        if key == 'desc':
            current['desc'] = val
        elif key == 'mac':
            current['mac'] = val
        elif key == 'ipv4':
            ips = IPV4_RE.findall(val)
            if ips:
                current['ipv4'] = ips[0]
        elif key == 'mask':
            current['mask'] = val
        elif key == 'gw':
            ips = IPV4_RE.findall(val)
            if ips:
                current['gateway'] = ips[0]
        elif key == 'dhcp':
            current['dhcp'] = val
        elif key == 'dns':
            current['dns'] = IPV4_RE.findall(val)
        elif key == 'state':
            current['state'] = val
            if '断开' in val or 'disconnect' in val.lower():
                current['connected'] = False
        elif 'IPv6' in m.group(1) and val:
            # 本地链接 IPv6 地址 / 临时 IPv6 地址 等
            addr = val.split('(')[0].strip().split()[0] if val.split('(')[0].strip() else ''
            if addr:
                current['ipv6'].append(addr)

    return host, adapters


def _parse_wifi(text: str):
    """解析 netsh wlan show interfaces, 返回已连接 WLAN 的信息 (没有则 None)。"""
    if not text.strip():
        return None
    fields, result = {}, None
    section_done = False
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        sep = '：' if '：' in line else (':' if ':' in line else None)
        if sep is None:
            continue
        k, v = line.split(sep, 1)
        k, v = k.strip(), v.strip()
        if k in ('名称', 'Name'):
            # 新接口块开始
            if result:
                section_done = True
            fields = {'name': v}
            continue
        if section_done:
            continue
        fields.setdefault(k, v)
        if k in ('状态', 'State') and ('已连接' in v or 'connected' in v.lower()):
            result = fields
    if not result and fields.get('状态', fields.get('State', '')):
        s = fields.get('状态', fields.get('State', ''))
        if '已连接' in s or 'connected' in s.lower():
            result = fields
    if not result:
        return None

    def pick(*keys):
        for k in keys:
            if k in fields and fields[k]:
                return fields[k]
        return ''

    return {
        'name': pick('名称', 'Name'),
        'ssid': pick('SSID'),
        'bssid': pick('BSSID'),
        'signal': pick('信号', 'Signal'),
        'channel': pick('信道', 'Channel'),
        'auth': pick('身份验证', 'Authentication'),
        'radio': pick('无线电类型', 'Radio type'),
        'state': pick('状态', 'State'),
    }


def collect():
    host, adapters = _parse_ipconfig(run_cmd(['ipconfig', '/all']))
    host['hostname'] = host.get('hostname') or platform.node()
    host['os'] = platform.system() + ' ' + platform.release()
    host['os_version'] = platform.version()

    try:
        import ctypes
        ms = ctypes.windll.kernel32.GetTickCount64()
        host['uptime_hours'] = round(ms / 3_600_000, 1)
    except Exception:
        pass

    # 主接口: 有 IPv4 且有默认网关的优先; 其次有 IPv4 的
    primary = None
    for a in adapters:
        if a['ipv4'] and a['gateway'] and a['connected']:
            primary = a
            break
    if primary is None:
        for a in adapters:
            if a['ipv4']:
                primary = a
                break

    for a in adapters:
        if a['mac']:
            a['vendor'] = oui.lookup(a['mac']) or ''

    return {
        'host': host,
        'adapters': adapters,
        'primary': primary['name'] if primary else None,
        'default_gateway': primary['gateway'] if primary else '',
        'wifi': _parse_wifi(run_cmd(['netsh', 'wlan', 'show', 'interfaces'], timeout=15)),
    }
