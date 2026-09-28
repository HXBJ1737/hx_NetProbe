"""活动连接: 解析 netstat -ano 并关联进程名。"""
import csv
import io
import re

from .utils import run_cmd

_TCP = re.compile(r'^\s*TCP\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s*$')
_UDP = re.compile(r'^\s*UDP\s+(\S+)\s+(\S+)\s*(\d+)\s*$')
_MAX_ROWS = 2000


def _process_map():
    text = run_cmd(['tasklist', '/fo', 'csv', '/nh'], timeout=30)
    m = {}
    try:
        for row in csv.reader(io.StringIO(text)):
            if len(row) >= 2 and row[1].isdigit():
                m[int(row[1])] = row[0]
    except csv.Error:
        pass
    return m


def collect():
    procs = _process_map()
    conns = []
    for line in run_cmd(['netstat', '-ano', '-p', 'tcp']).splitlines():
        m = _TCP.match(line)
        if m:
            local, remote, state, pid = m.groups()
            conns.append({'proto': 'TCP', 'local': local, 'remote': remote,
                          'state': state, 'pid': int(pid)})
            continue
        m = _UDP.match(line)
        if m:
            local, remote, pid = m.groups()
            conns.append({'proto': 'UDP', 'local': local,
                          'remote': remote if re.search(r'\d', remote) else '*:*',
                          'state': '-', 'pid': int(pid)})

    for c in conns:
        c['process'] = procs.get(c['pid'], '未知')

    order = {'ESTABLISHED': 0, 'CLOSE_WAIT': 1, 'SYN_SENT': 2, 'LISTENING': 3}
    conns.sort(key=lambda c: (order.get(c['state'], 9), -c['pid']))
    return {'connections': conns[:_MAX_ROWS], 'total': len(conns)}
