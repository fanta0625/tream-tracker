# 开发与目录约定

## 目录职责

```text
team-tracker/
├── src/                    # Node.js 服务端源码
│   ├── server.js           # HTTP 服务组装、路由挂载、启动和退出
│   ├── config.js           # 仓库根目录、数据/备份目录及运行配置
│   ├── db.js               # SQLite 连接、事务、身份数据和业务服务组装
│   ├── auth.js             # 会话与接口认证
│   ├── security.js         # 密码、签名、密钥与加密
│   ├── network-security.js # HTTPS、可信代理、跨站请求防护
│   ├── rate-limit.js       # 限流器
│   ├── mailer.js           # SMTP 发送
│   ├── routes/             # HTTP 参数、权限入口和响应
│   ├── services/           # 业务规则、查询和导出
│   └── lib/                # 数据迁移、参数校验、观测等公共组件
├── public/                 # 唯一的静态资源根目录
│   ├── *.html              # 页面入口
│   ├── js/                 # 浏览器脚本
│   └── css/                # 样式
├── scripts/                # 初始化、开发、备份、恢复、检查及基准工具
├── tests/
│   ├── integration/        # Node.js 业务、HTTP、恢复与 SMTP 集成测试
│   └── browser/            # Playwright 流程测试及隔离启动器
├── deploy/                 # Nginx、systemd、日志轮转配置模板
├── docs/                   # API、开发、验收及运维文档
├── .github/workflows/      # 持续集成
└── package.json            # 统一命令和依赖声明
```

根目录的 `server.js`、`initialize.js`、`dev.js` 和三个 Shell 脚本仅作为旧命令的兼容入口，不再承载业务实现。新工具直接引用 `src/` 或 `scripts/`，不要引用兼容入口作为业务模块。

`data/`、`backups/`、`logs/`、`node_modules/`、`test-results/` 和 `playwright-report/` 是被 Git 忽略的运行产物。本次目录整理不迁移或清空真实数据。默认数据和备份仍位于仓库根目录；显式 `DATA_DIR`、`BACKUP_DIR` 的相对路径仍相对于进程工作目录解析。静态目录由 `src/config.js` 定位，不依赖启动时的工作目录。

## 开发命令

```bash
npm ci
npm run dev           # 回环地址 HTTP 开发模式，自动初始化并监听代码变化
npm run init          # 只初始化；临时管理员密码只在可信终端查看
npm start             # 正式启动，先初始化；HTTPS 代理配置见运维手册
npm run check         # JavaScript 语法检查
npm test              # 集成测试，使用临时数据库
npx playwright install chromium
npm run test:e2e      # 真实浏览器流程
npm run verify        # 顺序执行语法、集成及浏览器检查
npm run backup
npm run benchmark
```

## 修改边界

- 路由负责 HTTP 层，业务规则放在 `src/services/`；服务工厂通过注入的数据访问方法复用事务与权限逻辑。
- 数据结构变更新增编号迁移，放入 `src/lib/migrations.js`，不要改写已应用迁移的含义。
- 浏览器脚本不能引用服务端模块。当前保持无构建的经典脚本方式，公共状态和工具在 `public/js/app.js`，脚本顺序由 HTML 明确管理。
- `public/` 内只存可公开分发的前端文件；数据库、密钥、环境配置和备份不得放入该目录。
- 业务/API 改动补充集成测试；用户操作流程改动补充浏览器测试。测试数据库和邮件接收器必须隔离，不能使用生产数据或真实收件人。
- 新增脚本基于自身位置或 `src/config.js` 定位源码；子进程显式设置工作目录。部署文件改动同步更新运维手册。

本次只调整目录和引用，不改变数据库结构或业务接口。HTTP 静态资源路径改为 `/js/*.js`、`/css/*.css`，页面引用已同步；部署后刷新旧页面以加载新路径。
