# AGENTS.md — gitbash-mcp

面向接手本仓库的 agent。先读 `docs/DESIGN.md`，再动手。

## 仓库地图

~~~
agent-git-bash/
├── AGENTS.md
├── README.md
├── LICENSE
├── package.json          ← ESM、bin 指向 bin/gitbash-mcp.js、files 白名单
├── bin/gitbash-mcp.js    ← 入口分发：无参=起 MCP server；init/uninstall/doctor=CLI
├── server.js             ← MCP server（工具注册）
├── lib/
│   ├── detect.js         ← bash 检测 + doctor 报告（server 与 CLI 共用）
│   ├── runner.js         ← spawn + 输出截断/spill
│   ├── menu.js           ← 备用屏幕勾选菜单（纯 reducer，可单测）
│   ├── theme.js          ← ANSI 着色与转义序列（尊重 NO_COLOR）
│   ├── audit.js          ← JSONL 审计日志（追加/读取/路径）
│   ├── policy.js         ← 命令策略引擎（三档 + 单一人同意开关）
│   └── cli.js            ← init / uninstall / doctor 交互实现
├── test-client.mjs       ← 服务端协议冒烟
├── test-cli.mjs          ← CLI 冒烟（临时 root，不碰真实配置）
├── test-menu.mjs         ← 菜单按键逻辑单测（无需 TTY）
├── test-runner.mjs       ← 护栏单测：洗白 / 封顶 / 并发 / 取消杀树 / 审计
├── test-policy.mjs       ← 策略单测：档位分类 / 姿态裁决 / 报告
├── .gitignore
└── docs/
    ├── DESIGN.md
    ├── PLAN.md
    └── NPM_PUBLISH.md      ← 本地文件，不入库（gitignore）
~~~

## 常用命令

| 命令 | 作用 |
|---|---|
| `node bin/gitbash-mcp.js` | 前台起 MCP server（stdio） |
| `node test-client.mjs` | 服务端协议冒烟（必须能 spawn bash） |
| `node test-cli.mjs` | CLI 冒烟（临时 root，不碰真实配置） |
| `node test-menu.mjs` | 菜单按键逻辑单测（无需 TTY） |
| `node test-runner.mjs` | 护栏单测（洗白 / 封顶 / 并发 / 取消 / 审计） |
| `node bin/gitbash-mcp.js audit` | 查看审计日志 |
| `node bin/gitbash-mcp.js policy` | 查看命令策略 |
| `node test-policy.mjs` | 策略单测（档位 / 裁决 / 报告） |
| `node bin/gitbash-mcp.js init --dry-run` | 预览会写哪些客户端配置 |
| `npm pack --dry-run` | 检查发布内容（只含 `bin/`、`lib/`、`server.js`、`package.json`、`README.md`、`LICENSE`） |
| `npm i -g .` | 从本地仓库全局安装（发布前自测） |

## 红线（改代码前必读）

1. **绝不尝试在受限沙箱内跑 bash**：MSYS2 的 signal pipe 会被 WRITE_RESTRICTED 令牌掐死（Win32 error 5）。
2. **`exec` 的结果契约不可破坏**：`exit_code / stdout / stderr / timed_out / truncated / spill_path`
   （外加缺 bash 时的 `error_code` / `hint`）。命令失败回 JSON，不抛工具错误。
3. **启动永不失败**：bash 探测必须惰性 + 缓存；缺 bash 时服务照常起，由 `exec` / `doctor` 报错。
4. **`command` 作为单个 argv** 传给 `bash -c/-lc`，不要引入引号转义层。
5. **超时杀整棵树**：`taskkill /pid <pid> /T /F`，只杀父进程会留 MSYS2 孤儿。
6. **护栏必须零配置**：并发/封顶/洗白/审计都由代码常量决定。**唯一存在的环境变量**是 `GITBASH_MCP_RISKY`（`ask` 默认 / `allow`），它是人类的同意开关，由 MCP 客户端配置注入——不要为其它目的新增配置项。
7. **只支持全局安装**：不提供 npx/bunx 方式；`package.json` 的 `files` 白名单必须保持精简。

## 安全边界（对外说明必须包含）

本进程在沙箱外运行，权限 = 启动它的 agent 进程的完整用户权限；无文件沙箱。

## 编码约定

- 纯 JS + ESM（`"type": "module"`），Node >= 18，同时兼容 Bun。**不用 TypeScript**：
  避免构建步骤，保持 `bin` 能被 Node 直接执行。
- 共享逻辑放 `lib/`：`detect.js`（检测）、`runner.js`（子进程+护栏）、`policy.js`（策略）、`audit.js`（审计）、
  `menu.js` / `theme.js`（交互）、`cli.js`（CLI）；`server.js` 只保留工具注册与裁决接线。
- 菜单按键逻辑必须是**纯函数**（`reduceMenu`），以便无 TTY 单测；渲染与终端交互分开。
- 日志只走 stderr（stdout 是 MCP 协议通道，绝不能打印日志）。

## 完成定义（Definition of Done）

- [ ] 五套测试全绿：`test-client` / `test-cli` / `test-menu` / `test-runner` / `test-policy`
- [ ] `npm pack --dry-run` 只列出源码（`bin/`、`lib/`、`server.js`、`package.json`、`README.md`、`LICENSE`），不含 `docs/` 与测试文件
- [ ] `gitbash-mcp init --dry-run` 能正确预览各客户端配置
- [ ] 缺 bash 时服务仍能启动并给出 `BASH_NOT_FOUND` + 修复指引
- [ ] README / DESIGN / PLAN 与代码同步