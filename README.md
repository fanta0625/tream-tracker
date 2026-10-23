# Team Tracker · 轻量团队工作追踪

按日期查看全员工作、跟踪事项进度与更新履历、按区间汇总，并导出 Markdown/Excel。单进程 + SQLite，无外部数据库、无前端构建步骤。

## 访问

默认监听 `3100`，启动后打开 http://localhost:3100。

需要登录。首次登录后请立即修改默认密码。

## 账号与角色

| 角色 | 权限 |
|---|---|
| 管理员 `admin` | 全部数据、成员管理、用户管理、角色分配、重置密码 |
| 主管 `manager` | 查看全部、创建/更新/归档任意事项；不能管理用户 |
| 成员 `member` | 查看全部日报/事项；只能创建和更新自己的事项 |

默认演示账号（**上线前必须改密码或停用**）：

| 账号 | 密码 | 角色 | 关联成员 |
|---|---|---|---|
| `admin` | `admin123` | 管理员 | - |
| `zhangsan` | `123456` | 成员 | 张三 |
| `lisi` | `123456` | 成员 | 李四 |
| `wangwu` | `123456` | 成员 | 王五 |
| `zhaoliu` | `123456` | 成员 | 赵六 |

## 功能

- **日报视图**：选择日期，按成员查看当天更新；未更新成员/事项也会列出。
- **事项进度**：状态（待开始/进行中/已搁置/被阻塞/已完成）+ 0~100% 进度。
- **更新履历**：每次记录日期、状态、进度、备注、**更新人**；自动计算“距上次更新 N 天”。
- **汇总视图**：任意日期区间，按成员统计更新条数、涉及事项、状态分布；支持最近 7 天/30 天/本月。
- **导出**：Markdown 日报/区间汇总；Excel（工作更新、事项总览、成员三个 Sheet）。
- **权限**：成员只能改自己的事项，主管/管理员可改全部；服务端强制校验。
- **用户管理**：管理员创建账号、关联成员、调整角色、重置密码、启用/停用。
- **事项编辑**：负责人可改标题/项目/描述/优先级/日期；主管/管理员还可转移负责人。
- **修改密码**：右上角「修改密码」，不依赖管理员重置。
- **演示数据**：4 名成员、8 个事项、跨三周履历，含“搁置 7 天后恢复”的示例。

## 启动 / 停止 / 备份

```bash
cd /path/to/team-tracker
./start.sh
./stop.sh
./backup.sh          # 备份到 backups/，保留 14 天
tail -f logs/server.log
```

默认端口 3100，可用 `PORT=3200 ./start.sh` 修改。

生产环境建议配置 crontab：

```cron
# 每天 2:00 备份
0 2 * * * cd /path/to/team-tracker && ./backup.sh >> logs/backup.log 2>&1
# 机器重启后自动启动
@reboot sleep 10 && cd /path/to/team-tracker && ./start.sh >> logs/startup.log 2>&1
```

查看：`crontab -l`。

## 从零初始化（正式使用）

当前库里是演示数据。正式使用可以：

```bash
cd /path/to/team-tracker
./stop.sh
mv data "data-demo-$(date +%Y%m%d)"
SEED_DEMO=0 INITIAL_ADMIN_PASSWORD='换成一个强密码' ./start.sh
```

这样只会创建管理员 `admin`，不创建演示成员/事项。登录后：

1. 「成员」页添加真实成员（姓名、职能）。
2. 「用户管理」创建账号，角色选“成员”，关联对应成员。
3. 修改管理员密码，停用/删除不需要的演示账号（当前没有删除接口，可停用）。

> 初始化后数据库不再重复写入演示数据；`SEED_DEMO=0` 只影响空库。

## 数据

- SQLite：`data/tracker.db`（WAL 模式）
- 会话密钥：`data/session.secret`（0600）
- 备份：`backups/tracker-YYYYmmdd-HHMMSS.db`，保留 14 天
- 重置：停止服务，删除 `data/tracker.db*` 和 `data/session.secret`，按上面的初始化命令启动

## 技术栈

- Node.js 24（内置 `node:sqlite`，无原生依赖）
- Express 4
- ExcelJS
- 认证：scrypt 密码哈希 + HMAC 签名 HttpOnly Cookie + 登录限流
- 前端：原生 HTML/CSS/JS，无构建步骤

## 主要 API

| 方法 | 路径 | 权限 |
|---|---|---|
| POST | `/api/auth/login` / `/api/auth/logout` | 公开 |
| GET | `/api/auth/me` | 登录 |
| POST | `/api/auth/password` | 登录（改自己密码） |
| GET | `/api/day?date=YYYY-MM-DD` | 登录 |
| GET | `/api/summary?from=&to=` | 登录 |
| GET | `/api/items?member_id=&status=&q=` | 登录 |
| GET | `/api/items/:id` | 登录 |
| POST | `/api/items` | 成员强制归自己；主管/管理员可指定 |
| POST | `/api/items/:id/updates` | 负责人/主管/管理员 |
| PATCH/DELETE | `/api/items/:id` | 负责人/主管/管理员 |
| GET | `/api/members` | 登录 |
| POST | `/api/members` | 管理员 |
| GET/POST/PATCH | `/api/users` | 管理员 |
| GET | `/api/export/markdown` / `xlsx` | 登录 |
