#!/usr/bin/env python3
"""NetProbe — 网络结构可视化服务 (纯 Python 标准库, 零第三方依赖).

用法:
    python app.py [--host 127.0.0.1] [--port 8765] [--no-open]
"""
import argparse
import json
import os
import re
import threading
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from netprobe import arp, connections, interfaces, jobs, publicip, routes, scan, trace

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, 'static')
JM = jobs.JobManager()

DEFAULT_TRACE_TARGET = '114.114.114.114'
_TARGET_RE = re.compile(r'^[A-Za-z0-9._\-]{1,253}$')

_MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2', '.map': 'application/json',
}


def _collect_overview():
    """并发采集本机网络全景信息。"""
    with ThreadPoolExecutor(max_workers=4) as ex:
        f_if = ex.submit(interfaces.collect)
        f_rt = ex.submit(routes.collect)
        f_ar = ex.submit(arp.collect)
        f_cn = ex.submit(connections.collect)
        info, rt, ar, cn = f_if.result(), f_rt.result(), f_ar.result(), f_cn.result()
    data = dict(info)
    data['routes'] = rt['routes']
    data['neighbors'] = ar['neighbors']
    data['connections'] = cn['connections']
    data['connection_total'] = cn['total']
    if not data.get('default_gateway'):
        data['default_gateway'] = rt['default_gateway']
    return data


def _primary_adapter():
    info = interfaces.collect()
    for a in info['adapters']:
        if a['name'] == info.get('primary'):
            return info, a
    return info, None


def _scan_runner(job):
    info, primary = _primary_adapter()
    if not primary or not primary.get('ipv4'):
        raise RuntimeError('未找到带 IPv4 地址的可用网络接口, 无法扫描')

    def prog(done, total):
        job['progress'] = {'done': done, 'total': total}

    job['result'] = scan.run(
        primary['ipv4'], primary.get('mask') or '255.255.255.0',
        info.get('default_gateway') or primary.get('gateway') or '',
        primary['ipv4'], prog, cancelled=lambda: job.get('cancelled'))


def _trace_runner(job):
    target = job['params'].get('target') or DEFAULT_TRACE_TARGET
    hops = []

    def on_hop(hop):
        hops.append(hop)
        job['result'] = {'target': target, 'hops': list(hops)}
        job['progress'] = {'done': len(hops), 'total': trace.MAX_HOPS}

    trace.run_trace(target, on_hop, cancelled=lambda: job.get('cancelled'))
    job['result'] = {'target': target, 'hops': hops}
    job['progress'] = {'done': len(hops), 'total': len(hops)}


class Handler(BaseHTTPRequestHandler):
    server_version = 'NetProbe/1.0'

    def log_message(self, fmt, *args):  # 安静模式, 不刷屏
        pass

    # ---------- 响应辅助 ----------
    def _json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def _static(self, path):
        name = 'index.html' if path in ('', '/') else path.lstrip('/')
        root = os.path.realpath(STATIC_DIR)
        full = os.path.realpath(os.path.join(STATIC_DIR, name))
        if not full.startswith(root + os.sep) or not os.path.isfile(full):
            self.send_error(404, 'Not Found')
            return
        ext = os.path.splitext(full)[1].lower()
        with open(full, 'rb') as f:
            data = f.read()
        self.send_response(200)
        self.send_header('Content-Type', _MIME.get(ext, 'application/octet-stream'))
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    # ---------- 路由 ----------
    def do_GET(self):
        path = urlparse(self.path).path
        try:
            if path == '/api/health':
                return self._json({'ok': True, 'time': time.time()})
            if path == '/api/overview':
                return self._json(_collect_overview())
            if path == '/api/public':
                return self._json(publicip.collect())
            if path == '/api/routes':
                return self._json(routes.collect())
            if path == '/api/neighbors':
                return self._json(arp.collect())
            if path == '/api/connections':
                return self._json(connections.collect())
            m = re.match(r'^/api/jobs/([0-9a-f]+)$', path)
            if m:
                job = JM.get(m.group(1))
                if not job:
                    return self._json({'error': '任务不存在或已过期'}, 404)
                return self._json(job)
            return self._static(path)
        except Exception as e:  # noqa: BLE001
            return self._json({'error': f'{type(e).__name__}: {e}'}, 500)

    def do_POST(self):
        path = urlparse(self.path).path
        m = re.match(r'^/api/jobs/([0-9a-f]+)/cancel$', path)
        if m:
            ok = JM.cancel(m.group(1))
            return self._json({'ok': ok, 'message': None if ok else '任务不存在或已结束'}, 200 if ok else 409)
        if path == '/api/geoips':
            try:
                length = int(self.headers.get('Content-Length') or 0)
                body = json.loads(self.rfile.read(length).decode('utf-8')) if length else {}
            except (ValueError, UnicodeDecodeError):
                return self._json({'error': '请求体不是合法 JSON'}, 400)
            ips = []
            for ip in (body.get('ips') or [])[:100]:
                ip = str(ip).strip()
                if re.fullmatch(r'(?:\d{1,3}\.){3}\d{1,3}', ip) and ip not in ips:
                    ips.append(ip)
            if not ips:
                return self._json({'map': {}})
            return self._json({'map': publicip.geo_batch(ips)})
        if path != '/api/jobs':
            return self._json({'error': 'not found'}, 404)
        try:
            length = int(self.headers.get('Content-Length') or 0)
            body = json.loads(self.rfile.read(length).decode('utf-8')) if length else {}
        except (ValueError, UnicodeDecodeError):
            return self._json({'error': '请求体不是合法 JSON'}, 400)

        jtype = body.get('type')
        if jtype == 'scan':
            job = JM.create('scan', _scan_runner)
        elif jtype == 'trace':
            target = str(body.get('target') or DEFAULT_TRACE_TARGET).strip()
            if not _TARGET_RE.match(target):
                return self._json({'error': '目标只允许 IP 或域名字符'}, 400)
            job = JM.create('trace', _trace_runner, {'target': target})
        else:
            return self._json({'error': 'type 必须是 scan 或 trace'}, 400)
        return self._json({'id': job['id'], 'type': job['type']})


def main():
    ap = argparse.ArgumentParser(description='NetProbe 网络结构可视化服务')
    ap.add_argument('--host', default='127.0.0.1',
                    help='监听地址, 默认 127.0.0.1 (仅本机)')
    ap.add_argument('--port', type=int, default=8765, help='端口, 默认 8765')
    ap.add_argument('--no-open', action='store_true', help='启动后不自动打开浏览器')
    args = ap.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f'http://{"127.0.0.1" if args.host == "0.0.0.0" else args.host}:{args.port}'
    print('=' * 56)
    print('  NetProbe · 网络结构可视化')
    print(f'  服务已启动: {url}   (Ctrl+C 退出)')
    print('=' * 56)
    if not args.no_open:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n服务已停止。')


if __name__ == '__main__':
    main()
