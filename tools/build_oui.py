#!/usr/bin/env python3
"""从 IEEE 官方 OUI 数据库生成 data/oui.json (MAC 前缀 -> 厂商)。

用法: python tools/build_oui.py
来源: https://standards-oui.ieee.org/oui/oui.csv
"""
import csv
import json
import os
import re
import urllib.request

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(HERE, 'data', 'oui.json')
URL = 'https://standards-oui.ieee.org/oui/oui.csv'


def clean(name: str) -> str:
    # 去掉重复空白; 截断超长公司名
    name = re.sub(r'\s+', ' ', name).strip()
    return name[:60]


def main():
    print(f'下载 {URL} ...')
    req = urllib.request.Request(URL, headers={'User-Agent': 'NetProbe/1.0'})
    with urllib.request.urlopen(req, timeout=60) as resp:
        text = resp.read().decode('utf-8', 'replace')

    db = {}
    for row in csv.reader(text.splitlines()):
        # 列: Registry, Assignment, Organization Name, Organization Address
        if len(row) >= 3 and row[0] == 'MA-L' and re.fullmatch(r'[0-9A-Fa-f]{6}', row[1] or ''):
            db[row[1].upper()] = clean(row[2])

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(db, f, ensure_ascii=False, separators=(',', ':'))
    print(f'完成: {len(db)} 条 OUI -> {OUT}')


if __name__ == '__main__':
    main()
