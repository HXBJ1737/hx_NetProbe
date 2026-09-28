"""局域网扫描: 并发 ping 探活 + ARP 表取 MAC + OUI 识别厂商。"""
import ipaddress
import re
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from . import arp, oui
from .utils import CREATE_FLAGS, PING, decode_bytes

_RTT_RE = re.compile(r'(?:时间|time)[=<](\d+)')
MAX_HOSTS = 1024  # 超大子网时的扫描上限, 避免误扫企业大网


def _ping(ip):
    """返回 (ip, 是否在线, rtt_ms)。"""
    try:
        p = subprocess.run([PING, '-n', '1', '-w', '200', '-4', ip],
                           capture_output=True, timeout=4,
                           creationflags=CREATE_FLAGS)
        if p.returncode != 0:
            return ip, False, None
        m = _RTT_RE.search(decode_bytes(p.stdout))
        return ip, True, (int(m.group(1)) if m else None)
    except Exception:
        return ip, False, None


def run(ip, mask, gateway, local_ip, on_progress=None, cancelled=None):
    """扫描 ip/mask 所在子网, 返回在线设备列表等信息。cancelled 触发时提前收尾。"""
    net = ipaddress.ip_network(f'{ip}/{mask}', strict=False)
    hosts = [str(h) for h in net.hosts()]
    capped = False
    if len(hosts) > MAX_HOSTS:
        hosts = hosts[:MAX_HOSTS]
        capped = True

    alive = {}
    done = 0
    ex = ThreadPoolExecutor(max_workers=min(64, len(hosts) or 1))
    try:
        futures = [ex.submit(_ping, h) for h in hosts]
        for fut in as_completed(futures):
            if cancelled and cancelled():
                break
            hip, ok, rtt = fut.result()
            done += 1
            if ok:
                alive[hip] = rtt
            if on_progress and (done % 8 == 0 or done == len(hosts)):
                on_progress(done, len(hosts))
    finally:
        ex.shutdown(wait=False, cancel_futures=True)  # 取消排队中的探测

    time.sleep(0.6)  # 等待 ARP 表完成更新
    macs = arp.mac_map()

    devices = []
    for hip in sorted(alive, key=lambda s: ipaddress.ip_address(s)):
        mac = macs.get(hip, '')
        if hip == local_ip:
            role = 'local'
        elif hip == gateway:
            role = 'gateway'
        else:
            role = 'device'
        devices.append({
            'ip': hip, 'mac': mac,
            'vendor': (oui.lookup(mac) or '未知') if mac else '',
            'rtt': alive[hip], 'role': role,
        })

    return {
        'network': str(net),
        'scanned': len(hosts), 'capped': capped,
        'alive_count': len(devices),
        'devices': devices,
        'gateway': gateway, 'local': local_ip,
        'cancelled': bool(cancelled and cancelled()),
    }
