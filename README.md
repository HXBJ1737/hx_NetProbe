# NetProbe · 网络结构可视化

一个零依赖的本地网络环境探测与可视化工程：检测当前所处网络的 **IP 信息、地理位置、局域网拓扑、路由关系**，并以交互式拓扑图 + 数据表格呈现。

后端为 **纯 Python 标准库**（无需 pip 安装任何包），前端为原生 JS + ECharts。

## 功能

| 能力 | 说明 | 数据来源 |
|------|------|----------|
| IP 信息 | 主机名、各适配器 IPv4/IPv6、子网掩码、MAC、DHCP、DNS、网关 | `ipconfig /all` |
| 地理位置 | 公网出口 IP、运营商/ASN、国家-省-市、经纬度 + 地图 | ip-api.com（中文）/ ipinfo.io |
| Wi-Fi 环境 | SSID、BSSID、信号强度、信道、认证方式 | `netsh wlan show interfaces` |
| 局域网拓扑 | 并发 ping 探活 + ARP 表取 MAC + IEEE OUI 识别设备厂商 | `ping` + `arp -a` |
| 路由关系 | 完整 IPv4 活动路由表（默认/链路/回环/组播分类） | `route print -4` |
| 路由追踪 | tracert 实时逐跳绘制到拓扑图，含每跳延迟与**归属地/运营商** | `tracert -d -4` |
| 活动连接 | TCP 连接列表并关联进程名/PID | `netstat -ano` + `tasklist` |

## 快速开始

```bash
python app.py            # 默认 http://127.0.0.1:8765, 自动打开浏览器
run.bat                  # Windows 双击 equivalent
python app.py --port 9000 --no-open
python app.py --host 0.0.0.0   # 允许局域网内其它设备访问页面 (注意安全)
```

## 界面

- **总览** — 主机/接口/公网出口/ Wi-Fi 卡片、全部适配器表、公网定位地图（国内坐标自动用高德瓦片内嵌拼图，免 key、GCJ-02 纠偏，支持滚轮/按钮缩放；「定位到本机实际位置」用浏览器 Geolocation 获取精确坐标并与 IP 城市级参考点同框对比；瓦片不可达时回退 OpenStreetMap / 坐标卡片）
- **网络拓扑** — 本机 ⇄ 网关 ⇄ 局域网设备（绿色实线=扫描在线，灰色虚线=ARP 缓存）；
  「扫描局域网」后设备点亮；路由追踪的公网链路蛇形排布在右侧，逐跳实时生长，
  边上标注 RTT；点击节点查看详情（MAC/厂商/归属地等）；扫描/追踪均可随时「停止」保留部分结果，
  「清空链路」可移除已绘制的追踪目标
- **路由追踪** — 目标输入 + 进度 + 逐跳表格（内/公网、最小/平均延迟、归属地/运营商），支持中途停止
- **路由表 / 活动连接** — 可筛选的数据表格

## 目录结构

```
hx-network/
├── app.py                  # HTTP 服务 + API 路由 (标准库)
├── run.bat                 # Windows 启动脚本
├── netprobe/               # 采集模块
│   ├── utils.py            # 命令执行 / GBK 解码
│   ├── interfaces.py       # ipconfig /all + netsh wlan 解析
│   ├── routes.py           # route print -4 解析
│   ├── arp.py              # arp -a 邻居表
│   ├── connections.py      # netstat + tasklist 进程关联
│   ├── publicip.py         # 公网 IP / 地理 / 批量归属地
│   ├── trace.py            # tracert 流式逐跳解析
│   ├── scan.py             # 局域网并发 ping 扫描
│   ├── oui.py              # MAC 厂商查询
│   └── jobs.py             # 后台任务管理
├── static/                 # 前端 (index.html / app.js / style.css / vendor/echarts)
├── data/oui.json           # IEEE OUI 数据库 (4 万条, tools/build_oui.py 生成)
└── tools/build_oui.py      # 重新生成 OUI 数据库
```

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/overview` | 主机/适配器/路由/邻居/连接 全景（并发采集） |
| GET | `/api/public` | 公网 IP 与地理信息 |
| GET | `/api/routes` `/api/neighbors` `/api/connections` | 各专项数据 |
| POST | `/api/jobs` | `{type:"scan"}` 或 `{type:"trace", target:"1.1.1.1"}` 创建后台任务 |
| POST | `/api/jobs/<id>/cancel` | 取消运行中的任务, 保留部分结果 |
| GET | `/api/jobs/<id>` | 轮询任务进度与实时结果 |
| POST | `/api/geoips` | `{ips:[...]}` 批量查询公网 IP 归属地 |

## 注意事项

- 服务默认只监听 `127.0.0.1`，探测命令均在本机执行；`--host 0.0.0.0` 会把页面暴露给局域网，请自行评估。
- 局域网扫描只向**本机所在子网**发送单次 ICMP ping（300ms 超时，最多 1024 地址），属于常规局域网发现行为。
- tracert 依赖沿途路由器响应 ICMP TTL 超时，公网中间跳显示 `*`（超时）属正常现象。
- 公网定位来自第三方免费接口（ip-api.com），精度为运营商级，仅供参考。
- MAC 厂商识别基于 IEEE OUI 数据库（`tools/build_oui.py` 可重新生成）。
- ECharts 已内置本地副本（static/vendor），离线可用；若缺失自动回退 CDN。
