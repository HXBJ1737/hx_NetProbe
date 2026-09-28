"""路由表: 解析 route print -4 的 IPv4 活动路由。"""
from .utils import IPV4_RE, run_cmd


def _is_ipv4(s: str) -> bool:
    import ipaddress
    try:
        return ipaddress.ip_address(s).version == 4
    except ValueError:
        return False


def _classify(dest: str, mask: str, gw: str) -> str:
    on_link = ('链路' in gw) or ('on-link' in gw.lower())
    if dest == '0.0.0.0' and mask == '0.0.0.0':
        return '默认路由'
    if dest.startswith('127.'):
        return '回环'
    if dest.startswith('224.') or dest.startswith('239.'):
        return '组播'
    if dest == '255.255.255.255':
        return '受限广播'
    if on_link:
        return '在链路上' if mask != '255.255.255.255' else '主机路由'
    return '网关路由'


def collect():
    text = run_cmd(['route', 'print', '-4'])
    routes = []
    in_active = False
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        if '活动路由' in s or 'Active Routes' in s:
            in_active = True
            continue
        if in_active and set(s) >= {'='}:  # 分隔线, 段结束
            break
        if not in_active:
            continue
        parts = s.split()
        if len(parts) >= 5 and _is_ipv4(parts[0]) and _is_ipv4(parts[1]):
            dest, mask, gw, iface, metric = parts[0], parts[1], parts[2], parts[3], parts[4]
            routes.append({
                'dest': dest, 'mask': mask, 'gateway': gw,
                'interface': iface if _is_ipv4(iface) else '-',
                'metric': metric if metric.isdigit() else '-',
                'on_link': ('链路' in gw) or ('on-link' in gw.lower()),
                'type': _classify(dest, mask, gw),
            })

    default_gw = ''
    for r in routes:
        if r['dest'] == '0.0.0.0' and r['mask'] == '0.0.0.0':
            default_gw = r['gateway']
            break
    return {'routes': routes, 'default_gateway': default_gw}
