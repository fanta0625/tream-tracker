# Team Tracker · 轻量团队工作追踪

按项目写日报/周报，按日期查看全员工作、跟踪事项进度与更新履历、按区间汇总，并导出 Markdown/Excel。支持邮箱注册、管理员审核、多组管理、组长创建项目和报告可见性。单进程 + SQLite，无外部数据库、无前端构建步骤。

## 访问

默认监听 `3100`，启动后打开 http://localhost:3100。

需要登录。首次登录后请立即修改默认密码。

## 账号与角色

| 角色 | 权限 |
|---|---|
| 管理员 `admin` | 全部数据、用户/成员/分组管理、邮件设置、注册审核、项目/报告管理、角色分配、重置密码 |
| 组长 `leader` | 查看全部、创建/更新/归档任意事项；在自己带的组创建/管理项目、查看本组报告；不能管理用户/分组 |
| 组员 `member` | 查看本组项目、写日报/周报；查看同组/公开报告；只能创建和更新自己的事项/报告 |

默认演示账号（**上线前必须改密码或停用**）：

| 账号 | 密码 | 角色 | 关联成员 |
|---|---|---|---|
| `admin` | `admin123` | 管理员 | - |
| `zhangsan` | `123456` | 成员 | 张三 |
| `lisi` | `123456` | 成员 | 李四 |
| `wangwu` | `123456` | 成员 | 王五 |
| `zhaoliu` | `123456` | 成员 | 赵六 |

## 邮箱注册与分组

- 管理员先在「邮件设置」里配置 SMTP（QQ、163、Gmail、企业邮箱或自定义），并发送测试邮件。
  - QQ/163 填邮箱授权码，不是登录密码；Gmail 填应用专用密码。
  - SMTP 密码加密保存，接口不回传明文。
  - 也支持环境变量 `SMTP_HOST`、`SMTP_PORT`、`SMTP_USER`、`SMTP_PASS`、`SMTP_FROM`；后台保存后优先使用数据库配置。
- 注册页输入邮箱 → 收 6 位验证码 → 设置密码 → 提交后进入「待审核」。
- 管理员在「用户管理」的待审核列表里通过或拒绝；通过后自动创建成员档案。
- 管理员在「分组」页新建组、指定组长、添加成员。
- 一个用户可以属于多个组，也可以担任多个组的组长。
- 被指定为组长后，该用户自动获得「组长」角色。
- 组员可以在本组项目下写日报/周报。

## 项目与日报/周报

- 项目归属于一个组；组长可以给自己带的组创建项目，管理员可以给任意组创建项目。
- 组员进入本组项目后可以写日报/周报；一个用户在同一项目、同一天/同一周只能有一份，可编辑。
- 日报字段：今日完成、进行中、问题/风险、明日计划。
- 周报字段：本周完成、问题/风险、下周计划。
- 每条报告由作者选择可见性：
  - `仅自己`：仅作者和管理员可见
  - `同组可见`：项目所在组成员和组长可见（默认）
  - `所有登录用户`：所有登录用户可见
- 管理员可以审计全部报告；组长看不到组员的「仅自己」报告。
- 「项目」页的「公开报告」可以查看最近 30 天所有公开报告。
- 项目报告支持按项目、类型、日期范围导出 Markdown / Excel。

## 功能

- **项目日报/周报**：组长建项目，组员在项目下写日报/周报，支持可见性和导出。
- **日报视图**：选择日期，按成员查看当天更新；未更新成员/事项也会列出。
- **事项进度**：状态（待开始/进行中/已搁置/被阻塞/已完成）+ 0~100% 进度。
- **更新履历**：每次记录日期、状态、进度、备注、**更新人**；自动计算“距上次更新 N 天”。
- **汇总视图**：任意日期区间，按成员统计更新条数、涉及事项、状态分布；支持最近 7 天/30 天/本月。
- **导出**：Markdown 日报/区间汇总；Excel（工作更新、事项总览、成员三个 Sheet）。
- **权限**：成员只能改自己的事项，组长/管理员可改全部；服务端强制校验。
- **用户管理**：管理员创建账号、关联成员、调整角色、重置密码、启用/停用；审核邮箱注册。
- **邮件设置**：管理员配置 SMTP，支持 QQ/163/Gmail/企业邮箱，密码加密保存，可发送测试邮件。
- **分组管理**：管理员新建组、指定组长、添加/移除成员；一个用户可属于多个组。
- **事项编辑**：负责人可改标题/项目/描述/优先级/日期；组长/管理员还可转移负责人。
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

1. 「邮件设置」配置 SMTP（也可以让用户先由管理员创建账号）。
2. 用户在注册页用邮箱自助注册，管理员在「用户管理」审核通过。
3. 「分组」页新建组、指定组长、添加成员。
4. 「项目」页由组长/管理员创建项目。
5. 组员进入项目写日报/周报；按需设置可见性。
6. 修改管理员密码，停用不需要的演示账号（当前没有删除接口，可停用）。

> 初始化后数据库不再重复写入演示数据；`SEED_DEMO=0` 只影响空库。

## 数据

- SQLite：`data/tracker.db`（WAL 模式）
- 会话密钥：`data/session.secret`（0600）
- 备份：`backups/tracker-YYYYmmdd-HHMMSS.db` + `backups/session-secret-YYYYmmdd-HHMMSS`，保留 14 天
  - 备份包含 `session.secret`，因为 SMTP 密码加密依赖它；恢复时两者要一起恢复。
- 重置：停止服务，删除 `data/tracker.db*` 和 `data/session.secret`，按上面的初始化命令启动

## 技术栈

- Node.js 24（内置 `node:sqlite`，无原生依赖）
- Express 4
- ExcelJS
- 认证：scrypt 密码哈希 + HMAC 签名 HttpOnly Cookie + 登录限流
- 邮件：Nodemailer（SMTP）
- 前端：原生 HTML/CSS/JS，无构建步骤

## 主要 API

| 方法 | 路径 | 权限 |
|---|---|---|
| POST | `/api/auth/login` / `/api/auth/logout` | 公开 |
| POST | `/api/auth/register/send-code` / `/api/auth/register` | 公开（邮箱注册） |
| GET | `/api/auth/me` | 登录 |
| POST | `/api/auth/password` | 登录（改自己密码） |
| GET | `/api/day?date=YYYY-MM-DD` | 登录 |
| GET | `/api/summary?from=&to=` | 登录 |
| GET | `/api/items?member_id=&status=&q=` | 登录 |
| GET | `/api/items/:id` | 登录 |
| POST | `/api/items` | 成员强制归自己；组长/管理员可指定 |
| POST | `/api/items/:id/updates` | 负责人/组长/管理员 |
| PATCH/DELETE | `/api/items/:id` | 负责人/组长/管理员 |
| GET | `/api/members` | 登录 |
| POST | `/api/members` | 管理员 |
| GET/POST/PATCH | `/api/users` | 管理员 |
| GET/POST | `/api/groups` | 登录 / 管理员 |
| PATCH | `/api/groups/:id` | 管理员 |
| POST/DELETE | `/api/groups/:id/members` | 管理员 |
| GET/PUT | `/api/admin/mail` | 管理员 |
| POST | `/api/admin/mail/test` | 管理员 |
| GET | `/api/admin/registrations` | 管理员 |
| POST | `/api/admin/registrations/:id/approve` / `reject` | 管理员 |
| GET/POST | `/api/projects` | 登录 / 组长或管理员创建 |
| GET/PATCH/DELETE | `/api/projects/:id` | 项目可见者 / 组长或管理员 |
| GET/POST | `/api/projects/:id/reports` | 项目可见者 / 组员、组长、管理员 |
| GET/PATCH/DELETE | `/api/reports/:id` | 作者或管理员 |
| GET | `/api/reports/public` | 登录（公开报告） |
| GET | `/api/projects/:id/reports/export` | 项目可见者 |
| GET | `/api/export/markdown` / `xlsx` | 登录 |
