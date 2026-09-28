"""路由追踪: 流式运行 tracert, 每解析出一个完整跃点立即回调。"""
import re
import subprocess
import time

from .utils import CREATE_FLAGS, decode_bytes

# 完整跃点行: 序号 + 若干延迟/星号 + 目标 IP
_HOP_IP_RE = re.compile(r'^\s*(\d{1,2})\s+(.*?)\s*((?:\d{1,3}\.){3}\d{1,3})\s*$')
# 全超时跃点行: 序号 + 三个以上星号
_HOP_TIMEOUT_RE = re.compile(r'^\s*(\d{1,2})\s+(?:\*\s*){3,}')
_RTT_RE = re.compile(r'(\d+)\s*(?:ms|毫秒)')

MAX_HOPS = 20


def run_trace(target, on_hop, deadline=90, cancelled=None):
    """运行 tracert -d -4, 每得到一个跃点调用 on_hop(hop)。

    hop: {hop, ip, timeout, rtt_min, rtt_avg}
    cancelled 为可选的取消回调, 触发后杀掉 tracert 并返回已收集的跃点。
    返回全部跃点列表; 无法启动/无结果时抛 RuntimeError。
    """
    args = ['tracert', '-d', '-4', '-w', '400', '-h', str(MAX_HOPS), target]
    try:
        p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             creationflags=CREATE_FLAGS)
    except OSError as e:
        raise RuntimeError(f'无法启动 tracert: {e}')

    hops, emitted, last_text = [], set(), ['']
    start = time.time()

    def feed(segment: bytes):
        text = decode_bytes(segment).strip()
        if not text:
            return
        last_text[0] = text
        hop = None
        m = _HOP_IP_RE.match(text)
        if m:
            n = int(m.group(1))
            rtts = [int(x) for x in _RTT_RE.findall(m.group(2))]
            hop = {'hop': n, 'ip': m.group(3), 'timeout': False,
                   'rtt_min': min(rtts) if rtts else None,
                   'rtt_avg': round(sum(rtts) / len(rtts), 1) if rtts else None}
        else:
            m = _HOP_TIMEOUT_RE.match(text)
            if m:
                hop = {'hop': int(m.group(1)), 'ip': None, 'timeout': True,
                       'rtt_min': None, 'rtt_avg': None}
        if hop and hop['hop'] not in emitted:
            emitted.add(hop['hop'])
            hops.append(hop)
            try:
                on_hop(hop)
            except Exception:
                pass

    # 逐字节读取, 兼容 tracert 用 \r 刷新同行的输出习惯
    buf = b''
    while True:
        if time.time() - start > deadline or (cancelled and cancelled()):
            p.kill()
            break
        ch = p.stdout.read(1)
        if not ch:
            break
        if ch in (b'\r', b'\n'):
            if buf.strip():
                feed(buf)
            buf = b''
        else:
            buf += ch
    if buf.strip():
        feed(buf)
    p.wait()

    if cancelled and cancelled():
        return hops  # 用户取消, 保留已获得的跃点
    if not hops:
        err = decode_bytes(p.stderr.read() or b'').strip()
        raise RuntimeError(err.splitlines()[0] if err else '追踪失败: 未获得任何跃点')
    return hops
