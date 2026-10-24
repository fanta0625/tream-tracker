# 部署、备份和恢复

## 生产部署

1. 创建专用系统用户 `team-tracker`，把应用放到 `/opt/team-tracker`，数据目录放到 `/var/lib/team-tracker`，只授权服务用户访问。
2. 运行 `npm ci`，参考下面配置创建 `/etc/team-tracker.env`（权限 0600），按实际域名与目录替换。
3. 在可信交互终端导出同样的 `DATA_DIR`，运行 `npm run init`，保存临时密码。首次初始化不要通过 journal、CI 或重定向日志执行。
4. 使用 `deploy/nginx.conf.example` 配置域名证书和反向代理，仅对外开放 80/443，覆盖转发头。
5. 安装 `deploy/team-tracker.service` 到 systemd，执行 daemon-reload 后启动服务。服务模板直接运行已初始化的 `src/server.js`，不会把首次临时密码输出到 journal。
6. 用真实 HTTPS 地址验证登录、首次改密、项目报告、导出与退出；配置 SMTP 后在管理页面发送测试邮件。

```ini
DATA_DIR=/var/lib/team-tracker
BACKUP_DIR=/var/backups/team-tracker
HOST=127.0.0.1
PORT=3100
TRUSTED_PROXIES=127.0.0.1
PUBLIC_ORIGIN=https://tracker.example.com
REQUEST_LOG=1
```

环境文件由 systemd 加载；直接执行 npm 或 shell 脚本时需自行导出环境变量。`start.sh` 适用于简易部署；正式部署建议使用 systemd 自动重启和 SIGTERM 优雅退出。

请求日志只包含请求 ID、方法、路径、状态码、耗时，不记录请求体、Cookie、验证码和密码。管理员可查询 `/api/admin/metrics`；`/api/health` 执行数据库查询。systemd 日志使用 journald 的容量/保留策略；使用 `start.sh` 时参考 `deploy/logrotate.conf`。

## 备份与异机副本

```bash
DATA_DIR=/var/lib/team-tracker BACKUP_DIR=/var/backups/team-tracker node scripts/backup.js
node scripts/backup.js verify /var/backups/team-tracker/snapshot-...
```

每份快照包含 `tracker.db`、`session.secret`、SHA-256 校验清单。SQLite 使用在线 `VACUUM INTO` 获取一致数据库；密钥必须随库备份。默认保留 14 天，可用 `BACKUP_RETENTION_DAYS` 调整。

设置 `BACKUP_MIRROR_DIR` 可把完整快照复制到已挂载的异机备份目录；复制失败返回非零退出状态。该配置不会自行安装远程挂载、加密或凭据。异机介质需单独设置权限、加密和保留策略。

计划任务建议每天运行并检查退出状态；定期验证最新快照。备份不是恢复验收，至少每次升级前执行一次下面的演练。

## 恢复演练与切换

```bash
node scripts/backup.js restore /var/backups/team-tracker/snapshot-... /var/lib/team-tracker-restore
DATA_DIR=/var/lib/team-tracker-restore COOKIE_SECURE=0 HOST=127.0.0.1 PORT=3200 node server.js
```

恢复工具先验证文件校验和、SQLite 完整性与外键，只允许恢复到空目录，不覆盖运行中的数据库。验证账号、项目、报告、导出及 SMTP 配置解密，再停止正式服务、修改 `DATA_DIR`、启动并检查。保留旧目录用于回退。

代码回滚与数据库回滚需成对规划：旧代码不一定理解新 schema；升级前保存快照，若需回退数据库，明确回退后会丢失备份时间之后的修改。

## 管理员密码恢复

在服务器本机的受信任终端停止服务后执行：

```bash
DATA_DIR=/var/lib/team-tracker node scripts/recover-admin.js admin
```

只允许重置已有管理员，生成随机临时密码，撤销旧会话，恢复账号为启用状态并强制再次改密。需要本机数据目录权限；不提供未登录的远程恢复接口，不删除正式数据库。

## 升级和试运行验收

- 升级前备份并验证；升级后检查 `schema_migrations` 版本和服务健康。
- 用管理员、组长、组员三种账号验证权限；尝试离组、归档和双窗口同时修改。
- 实际使用一轮日报/周报，收集错误率、429 次数、请求耗时、导出耗时与内存。
- 同一办公室共享 IP 时重点关注 429；当前成功登录会返还账号/IP 登录额度，但 API 总量限制仍存在。修改限额前先定位来源，避免直接取消保护。
- 验证真实 SMTP 到达、HTTPS 证书续期、机器重启自动恢复、异机快照及恢复流程。
