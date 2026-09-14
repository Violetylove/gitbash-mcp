# AGENTS.md — gitbash-mcp

面向接手本仓库的 agent。先读 `docs/REPO_MAP.md`（文件职责 + 任务→文件索引）和 `docs/DESIGN.md`（契约与决策），再动手。

## 仓库地图

~~~
gitbash-mcp/
├── AGENTS.md
├── README.md
├── LICENSE
├── package.json          ← ESM、bin 指向 bin/gitbash-mcp.js、files 白名单
├── bin/gitbash-mcp.js    ← 入口分发：无参=起 MCP server；init/uninstall/doctor/audit/policy=CLI
├── server.js             ← MCP server（工具注册 + 超时/移交策略）
├── lib/
│   ├── detect.js         ← bash 检测 + doctor 报告（server 与 CLI 共用）
│   ├── runner.js         ← launch/前台预算 + 输出通道 + 截断/spill + 并发 + 杀树 + 环境
│   ├── jobs.js           ← 后台作业注册表（startJob / adopt / jobPayload / killJob）
│   ├── shell-parse.js    ← 命令解析（纯函数：切段 / 去引号 / 关键字 / 重定向 / 标记 opaque）
│   ├── policy.js         ← 能力分类 + 项目声明信任（纯函数，单一人类同意开关）
│   ├── menu.js           ← 备用屏幕勾选菜单（纯 reducer，可单测）
│   ├── theme.js          ← ANSI 着色与转义序列（尊重 NO_COLOR）
│   ├── audit.js          ← JSONL 审计日志（追加/读取/路径）
│   └── cli.js            ← init / uninstall / doctor 交互实现
├── test/                 ← 五套测试（不入发布包）：client / cli / menu / runner / policy，见 REPO_MAP §8
├── .gitignore
└── docs/
    ├── DESIGN.md
    ├── PLAN.md
    └── REPO_MAP.md         ← 代码地图：文件职责 / 任务→文件索引
~~~

## 常用命令

| 命令 | 作用 |
|---|---|
| `node bin/gitbash-mcp.js` | 前台起 MCP server（stdio） |
| `npm test` | 五套测试：client / cli / menu / runner / policy（都必须能 spawn bash） |
| `node bin/gitbash-mcp.js audit` / `policy` / `doctor` | 审计日志 / 命令策略 / 环境诊断 |
| `node bin/gitbash-mcp.js init --dry-run` | 预览会写哪些客户端配置 |
| `npm pack --dry-run` | 检查发布内容（只含 `bin/`、`lib/`、`server.js`、`package.json`、`README.md`、`LICENSE`） |
| `npm i -g .` | 从本地仓库全局安装。npm 对本地目录走 **link** 语义：全局 `node_modules/gitbash-mcp` 变成指向本仓库的软链接、依赖用仓库的 `node_modules`——仓库不能删/挪。要自包含副本：`npm pack` 后装 tgz；要发布版：`npm i -g gitbash-mcp@latest` |

## 红线（改代码前必读）

1. **绝不尝试在受限沙箱内跑 bash**：MSYS2 的 signal pipe 会被 WRITE_RESTRICTED 令牌掐死（Win32 error 5）。
2. **`exec` 的结果契约不可破坏**：`exit_code / stdout / stderr / timed_out / still_running / truncated /
   spill_path / spill_bytes / spill_truncated / duration_ms / killed_by / timeout_ms / queued_ms / audit_id / policy / warnings`
   （外加移交时的 `job_id`、缺 bash / 排队超时 / 作业超限 / 旧式 `//c` 时的 `error_code` + `hint`）。命令失败回 JSON，不抛工具错误。
3. **启动永不失败**：bash 探测必须惰性 + 缓存；缺 bash 时服务照常起，由 `exec` / `doctor` 报错。
4. **`command` 作为单个 argv** 传给 `bash -c/-lc`，不要引入引号转义层。
5. **长任务的四条不变量（DESIGN §5.10）**：① `run_in_background` 必须毫秒级返回 `job_id`，作业生命期不挂在发起它的请求上；
   ② 取消（客户端超时与用户按停止在协议上不可区分）与前台预算到点都**移交**进程句柄，绝不杀进程丢成果；
   ③ 移交同时**清零继承的 `timeout_ms`**，否则「没被杀」的承诺会在 15 秒后变成谎言；
   ④ 杀整棵树只由 `timeout_ms` 在等待期内到点、`job_kill`、server 退出触发；`taskkill /pid <pid> /T /F`（只杀父进程会留 MSYS2 孤儿）。
   前台预算常量是 `FOREGROUND_MS`，必须明显小于 MCP 客户端默认的 60s 请求超时。
6. **护栏必须零配置**：并发/封顶/洗白/审计/作业上限都由代码常量决定。**唯一存在的环境变量**是 `GITBASH_MCP_RISKY`（`ask` 默认 / `allow`），它是人类的同意开关，由 MCP 客户端配置注入——不要为其它目的新增配置项。
7. **只支持全局安装**：不提供 npx/bunx 方式；`package.json` 的 `files` 白名单必须保持精简。

## 安全边界（对外说明必须包含）

本进程在沙箱外运行，权限 = 启动它的 agent 进程的完整用户权限；无文件沙箱。

## 编码约定

- 纯 JS + ESM（`"type": "module"`），Node >= 18，兼容 Bun。**不用 TypeScript**：不要构建步骤，`bin` 必须能被 Node 直接执行。
- 共享逻辑放 `lib/`（`detect` / `runner` / `jobs` / `shell-parse` / `policy` / `audit` / `menu` / `theme` / `cli`），
  `server.js` 只保留工具注册与裁决接线；逐文件职责见 `docs/REPO_MAP.md`。
- **一条命令只有一条执行路径**：新命令一律走 `runner.js` 的 `launch()`；前台与后台的差别只是「等多久、到点怎么办」
  （`runWithForegroundBudget` / `jobs.startJob`）。别为「转后台」再起一个进程。
- **不改写调用方的命令文本**：写法必然失败时（如转换关闭下的 `cmd //c`）前置拒绝并给出改法——解析器只给出去引号后的词、
  没有原文 span，改写会破坏引号与转义。
- **完成判定只看直接子进程（shell）退出**，管道只多等 `EXIT_DRAIN_MS`；别退回「等 stdio 全部关闭」（DESIGN §5.16）。
- **两条并发路径语义固定**：`MAX_CONCURRENCY` 只管前台，后台由 `MAX_BACKGROUND_JOBS` 管；所有返回体都带 `queued_ms`。
- 菜单按键逻辑必须是**纯函数**（`reduceMenu`），渲染与终端交互分开，便于无 TTY 单测。
- **策略不得退回正则黑名单**：只做能力分类，判读不了就归 `opaque` → ask；改 `shell-parse.js` / `policy.js`
  必须同步补 `test/test-policy.mjs`（解析器 + 档位 + 姿态裁决）。
- 用模板改文件时的转义约定：反引号会终止模板串、`$`+`{` 会插值（`String.raw` 也挡不住）。先用 read 取出旧文本拼 `old_string`，
  再按行数组拼 `new_string`，不要在模板里内联整段文件。
- 日志只走 stderr（stdout 是 MCP 协议通道）。`exec` 描述与 `instructions` 里的「Windows 上优先用它」是采纳率手段；
  `instructions` 属于 `initialize` 返回值，别塞进 `registerTool`；改措辞要同步 `test/test-client.mjs` 与 README。

## 完成定义（Definition of Done）

- [ ] 五套测试全绿：`test/test-client` / `test/test-cli` / `test/test-menu` / `test/test-runner` / `test/test-policy`
- [ ] 长任务不变量有测试钉住：后台毫秒级返回句柄、取消移交（`job_list` 能找回）、预算到点移交、`job_kill` 能停
- [ ] `npm pack --dry-run` 只列出源码（`bin/`、`lib/`、`server.js`、`package.json`、`README.md`、`LICENSE`），不含 `docs/` 与测试文件
- [ ] `gitbash-mcp init --dry-run` 能正确预览各客户端配置
- [ ] 缺 bash 时服务仍能启动并给出 `BASH_NOT_FOUND` + 修复指引
- [ ] README / DESIGN / PLAN / REPO_MAP 与代码同步