"""MAC 厂商 (OUI) 查询。

优先加载构建期生成的 data/oui.json (来自 IEEE 官方 OUI 数据库),
不可用时退回到内置的常见厂商小表。
"""
import json
import os
import threading

from .utils import norm_mac

_DATA_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          'data', 'oui.json')

# 常见网络设备厂商的兜底小表 (OUI 前缀 -> 厂商)
_FALLBACK = {
    '00E04C': 'Realtek', '000C29': 'VMware', '005056': 'VMware',
    '00155D': 'Microsoft(Hyper-V)', '002243': 'Lambda?', '020000': '私有/随机',
    '001A2B': 'Ayecom', '00163E': 'Xensource', '080027': 'PCS Systemvirt/ VirtualBox',
    '525400': 'QEMU/KVM', 'B827EB': 'Raspberry Pi', 'DCA632': 'Raspberry Pi',
    'E45F01': 'Raspberry Pi', '00059A': 'SUN', '001B21': 'Intel? (示例)',
}

_lock = threading.Lock()
_db = None


def _load():
    global _db
    with _lock:
        if _db is not None:
            return
        db = {}
        try:
            with open(_DATA_FILE, 'r', encoding='utf-8') as f:
                db = json.load(f)
        except (OSError, ValueError):
            pass
        if not db:
            db = _FALLBACK
        _db = db


def lookup(mac: str):
    """返回厂商名; 未知返回 None。"""
    if not mac:
        return None
    _load()
    return _db.get(norm_mac(mac)[:6])
