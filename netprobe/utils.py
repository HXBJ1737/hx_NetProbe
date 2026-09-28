"""公共工具: 命令执行 / 编码解码 / 常量正则。"""
import os
import re
import subprocess

IPV4_RE = re.compile(r'(?<![\d.])((?:\d{1,3}\.){3}\d{1,3})(?![\d.])')

_SYS = os.environ.get('SystemRoot', r'C:\Windows')
PING = os.path.join(_SYS, 'System32', 'ping.exe')
if not os.path.exists(PING):
    PING = 'ping'

CREATE_FLAGS = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0


def decode_bytes(data: bytes) -> str:
    """中文 Windows 控制台输出为 GBK, 先按 UTF-8 再按 GBK 解码。"""
    if not data:
        return ''
    for enc in ('utf-8', 'gbk'):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode('utf-8', 'replace')


def run_cmd(args, timeout=30) -> str:
    """执行系统命令, 返回 stdout+stderr 文本; 失败/超时返回空串。"""
    try:
        p = subprocess.run(args, capture_output=True, timeout=timeout,
                           creationflags=CREATE_FLAGS)
    except (subprocess.TimeoutExpired, OSError):
        return ''
    return decode_bytes(p.stdout) + decode_bytes(p.stderr)


def norm_mac(mac: str) -> str:
    """把 AA-BB-CC-DD-EE-FF / aa:bb:cc 统一为 AABBCCDDEEFF。"""
    return re.sub(r'[^0-9a-fA-F]', '', mac or '').upper()


def fmt_mac(mac: str) -> str:
    """把任意 MAC 格式化为 AA-BB-CC-DD-EE-FF。"""
    h = norm_mac(mac)
    return '-'.join(h[i:i + 2] for i in range(0, 12, 2)) if len(h) == 12 else mac


def is_private_ip(ip: str) -> bool:
    """判断是否为内网/保留 IPv4 地址。"""
    import ipaddress
    try:
        return ipaddress.ip_address(ip).is_private
    except ValueError:
        return False
