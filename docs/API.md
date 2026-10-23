# Team Tracker API

除公开接口外，请求需要携带登录后的 `tt_session` Cookie（HttpOnly）。接口返回 JSON，导出接口返回文件。

Base URL：`http://<host>:3100`

## 认证

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/api/auth/login` | 公开 | 用户名或邮箱 + 密码登录 |
| POST | `/api/auth/logout` | 公开 | 清除登录 Cookie |
| POST | `/api/auth/register/send-code` | 公开 | 发送注册邮箱验证码 |
| POST | `/api/auth/register` | 公开 | 邮箱注册，注册后为待审核 |
| POST | `/api/auth/forgot/send-code` | 公开 | 发送重置密码验证码 |
| POST | `/api/auth/forgot/reset` | 公开 | 验证码重置密码 |
| GET | `/api/auth/me` | 登录 | 当前用户、角色、分组、组长组 |
| POST | `/api/auth/password` | 登录 | 修改自己的密码 |

## 日报与更新记录

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/api/day?date=YYYY-MM-DD` | 登录 |
| GET | `/api/summary?from=&to=` | 登录 |
| GET | `/api/items?member_id=&status=&q=` | 登录 |
| GET | `/api/items/:id` | 登录 |
| POST | `/api/items` | 组员强制归自己；组长/管理员可指定负责人 |
| PATCH/DELETE | `/api/items/:id` | 负责人/组长/管理员 |
| POST | `/api/items/:id/updates` | 负责人/组长/管理员 |
| GET | `/api/updates/:id` | 登录 |
| PATCH/DELETE | `/api/updates/:id` | 更新作者/事项负责人/组长/管理员 |

## 成员、用户、分组

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/api/members` | 登录 |
| POST | `/api/members` | 管理员 |
| GET/POST/PATCH | `/api/users` | 管理员 |
| GET | `/api/groups` | 登录（只返回自己所在/负责的组） |
| POST | `/api/groups` | 管理员 |
| PATCH | `/api/groups/:id` | 管理员 |
| POST | `/api/groups/:id/members` | 管理员 |
| DELETE | `/api/groups/:id/members/:userId` | 管理员 |

## 邮件与注册审核

| 方法 | 路径 | 权限 |
|---|---|---|
| GET/PUT | `/api/admin/mail` | 管理员 |
| POST | `/api/admin/mail/test` | 管理员 |
| GET | `/api/admin/registrations` | 管理员 |
| POST | `/api/admin/registrations/:id/approve` | 管理员 |
| POST | `/api/admin/registrations/:id/reject` | 管理员 |

## 项目与报告

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/api/projects` | 登录（只返回自己组内项目） |
| POST | `/api/projects` | 管理员；或所负责组的组长 |
| GET | `/api/projects/:id` | 项目可见者 |
| PATCH/DELETE | `/api/projects/:id` | 管理员；或所负责组的组长 |
| GET | `/api/projects/:id/reports` | 项目可见者（按报告可见性过滤） |
| POST | `/api/projects/:id/reports` | 项目组员/组长/管理员 |
| GET | `/api/reports/:id` | 报告可见者 |
| PATCH/DELETE | `/api/reports/:id` | 报告作者/管理员 |
| GET | `/api/reports/public` | 登录（公开报告） |

## 导出

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/api/projects/:id/reports/export?format=markdown\|xlsx` | 项目可见者 |
| GET | `/api/export/markdown?date=` 或 `?from=&to=` | 登录 |
| GET | `/api/export/xlsx?date=` 或 `?from=&to=` | 登录 |

## 权限说明

- 管理员：全部数据、用户/分组/邮件/审核、全部项目与报告。
- 组长：全量事项编辑；在自己负责的组创建/管理项目；查看本组报告（不含组员的「仅自己」报告）。
- 组员：查看本组项目，写自己的日报/周报；只能修改自己的事项/报告。
- 报告可见性：`private` 仅作者+管理员；`group` 同组可见；`public` 所有登录用户可见。
