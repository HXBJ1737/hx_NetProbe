"""ARP 邻居表: 解析 arp -a。"""
import re

from .utils import fmt_mac, norm_mac, run_cmd
from . import oui

_ROW = re.compile(
    r'((?:\d{1,3}\.){3}\d{1,3})\s+((?:[0-9a-fA-F]{2}[-:]){5}[0-9a-fA-F]{2})\s+(\S+)')


def collect():
    """返回 {interface_ip, ip, mac, type, vendor} 列表。"""
    text = run_cmd(['arp', '-a'])
    neighbors, iface = [], ''
    seen = set()
    for line in text.splitlines():
        s = line.strip()
        if s.startswith('接口') or s.lower().startswith('interface'):
            # 形如 “接口: 192.168.1.20 --- 0x2”
            m = re.search(r'((?:\d{1,3}\.){3}\d{1,3})', s)
            iface = m.group(1) if m else ''
            continue
        m = _ROW.match(s)
        if not m:
            continue
        ip, mac, typ = m.group(1), fmt_mac(m.group(2)), m.group(3)
        key = (ip, norm_mac(mac))
        if key in seen:
            continue
        seen.add(key)
        neighbors.append({
            'interface': iface,
            'ip': ip,
            'mac': mac,
            'type': 'static' if ('静' in typ) else 'dynamic',
            'type_label': '静态' if ('静' in typ) else '动态',
            'vendor': oui.lookup(mac) or '未知',
        })
    return {'neighbors': neighbors}


def mac_map():
    """ip -> mac 的便捷映射。"""
    return {n['ip']: n['mac'] for n in collect()['neighbors']}
