"""公网 IP 与地理位置 (ip-api.com 中文接口优先, ipinfo.io 兜底)。"""
import json
import urllib.request
from concurrent.futures import ThreadPoolExecutor


def _get_json(url, timeout=8):
    req = urllib.request.Request(url, headers={'User-Agent': 'NetProbe/1.0'})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode('utf-8'))


def _check_osm():
    """探测 OpenStreetMap 是否可达 (大陆网络常不可达, 决定地图展示方式)。"""
    try:
        req = urllib.request.Request('https://www.openstreetmap.org/',
                                     headers={'User-Agent': 'NetProbe/1.0'})
        with urllib.request.urlopen(req, timeout=3):
            return True
    except Exception:
        return False


def collect():
    with ThreadPoolExecutor(max_workers=2) as ex:
        f_geo = ex.submit(_geo)
        f_osm = ex.submit(_check_osm)
        result = f_geo.result()
        result['map_osm'] = f_osm.result()
    return result


def _geo():
    try:
        d = _get_json('http://ip-api.com/json/?fields=status,message,country,'
                      'regionName,city,isp,org,as,query,lat,lon,timezone&lang=zh-CN')
        if d.get('status') == 'success':
            return {
                'ip': d.get('query', ''),
                'country': d.get('country', ''),
                'region': d.get('regionName', ''),
                'city': d.get('city', ''),
                'isp': d.get('isp', ''),
                'org': d.get('org', ''),
                'asn': d.get('as', ''),
                'lat': d.get('lat'),
                'lon': d.get('lon'),
                'timezone': d.get('timezone', ''),
                'source': 'ip-api.com',
            }
    except Exception:
        pass

    try:
        d = _get_json('https://ipinfo.io/json')
        lat, lon = None, None
        if d.get('loc') and ',' in d['loc']:
            lat_s, lon_s = d['loc'].split(',', 1)
            lat, lon = float(lat_s), float(lon_s)
        return {
            'ip': d.get('ip', ''),
            'country': d.get('country', ''),
            'region': d.get('region', ''),
            'city': d.get('city', ''),
            'isp': d.get('org', ''),
            'org': d.get('org', ''),
            'asn': '',
            'lat': lat, 'lon': lon,
            'timezone': d.get('timezone', ''),
            'source': 'ipinfo.io',
        }
    except Exception:
        return {'error': '无法获取公网信息 (设备可能离线或接口不可达)'}


def geo_batch(ips):
    """批量查询多个公网 IP 的归属地 (ip-api.com batch 接口, 单次最多 100 个)。"""
    out = {}
    try:
        url = ('http://ip-api.com/batch?fields=status,query,country,'
               'regionName,city,isp&lang=zh-CN')
        req = urllib.request.Request(
            url, data=json.dumps(ips[:100]).encode('utf-8'),
            headers={'Content-Type': 'application/json', 'User-Agent': 'NetProbe/1.0'})
        with urllib.request.urlopen(req, timeout=10) as resp:
            for item in json.loads(resp.read().decode('utf-8')):
                if item.get('status') == 'success':
                    loc = ' '.join(x for x in (item.get('country'),
                                               item.get('regionName'),
                                               item.get('city')) if x)
                    out[item['query']] = {'loc': loc, 'isp': item.get('isp', '')}
    except Exception:
        pass
    return out
