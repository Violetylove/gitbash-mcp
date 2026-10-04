# AGENTS.md — gitbash-mcp

面向接手本仓库的 agent。先读 `docs/REPO_MAP.md`（文件职责 + 任务→文件索引）和 `docs/DESIGN.md`（设计与契约），再动手。

## 仓库地图

~~~
gitbash-mcp/
├── AGENTS.md
├── README.md
├── LICENSE
├── package.json          ← ESM、bin 指向 bin/gitbash-mcp.js、files 白名单
├── bin/gitbash-mcp.js    ← 入口分发：无参=起 MCP server；init/uninstall/doctor/audit/policy=CLI
├── server.js             ← MCP 组装、连接与退出清理
├── lib/
│   ├── mcp/              ← MCP 协议与会话适配
│   │   ├── tools/        ← exec.js / jobs.js / diagnostics.js / approval.js
│   │   ├── server.js     ← MCP 会话组装
│   │   ├── responses.js  ← MCP content 响应格式
│   │   ├── workspace.js  ← roots 解析与默认 cwd 缓存
│   │   └── instructions.js ← initialize 模型指引
│   ├── execution/        ← 命令执行
│   │   ├── service.js    ← 执行流程、并发调度、移交、调用审计
│   │   ├── preflight.js  ← 工作目录预检与错误结果
│   │   ├── runner.js     ← 进程、输出通道、时限、环境、杀树
│   │   └── results.js    ← 基础执行结果与 hint
│   ├── policy/           ← 风险分类与授权
│   │   ├── index.js      ← 能力分类、项目入口、姿态、路径转换
│   │   ├── authorization.js ← 策略裁决与执行授权接口
│   │   └── shell-parse.js ← 命令结构解析
│   ├── approval/         ← 单次人类审批
│   │   ├── service.js    ← 状态、取消、单次决策、审计
│   │   ├── windows.js    ← WPF 宿主与私有 JSONL 管道
│   │   └── windows.ps1   ← 多请求 WPF 窗口；WinForms 备选
│   ├── jobs/             ← 后台作业
│   │   ├── registry.js   ← 注册表、后台启动、前台移交
│   │   └── service.js    ← 查询、等待和停止
│   ├── environment/      ← Bash 环境
│   │   ├── detect.js     ← 惰性探测与 doctor
│   │   └── diagnostics.js ← Bash 信息
│   ├── audit/
│   │   └── index.js      ← JSONL 审计与轮转
│   └── cli/              ← 客户端配置与终端交互
│       ├── index.js      ← init / uninstall / doctor / audit / policy
│       ├── menu.js       ← 菜单 reducer 与渲染
│       └── theme.js      ← ANSI 样式
├── test/                 ← 六套测试（不入发布包）：client / cli / menu / runner / policy / approval，见 REPO_MAP §5
├── .gitignore
└── docs/
    ├── DESIGN.md
    ├── PROGRESS.md
    └── REPO_MAP.md         ← 代码地图：文件职责 / 任务→文件索引
~~~

## 常用命令

| 命令 | 作用 |
|---|---|
| `node bin/gitbash-mcp.js` | 前台起 MCP server（stdio） |
| `npm test` | 六套测试：client / cli / menu / runner / policy / approval（完整套件需要在沙箱外 spawn bash） |
| `node bin/gitbash-mcp.js audit` / `policy` / `doctor` | 审计日志 / 命令策略 / 环境诊断 |
| `node bin/gitbash-mcp.js init --dry-run` | 预览会写哪些客户端配置 |
| `npm pack --dry-run` | 检查发布内容（只含 `bin/`、`lib/`、`server.js`、`package.json`、`README.md`、`LICENSE`） |
| `npm i -g .` | 从本地仓库全局安装。npm 对本地目录走 **link** 语义：全局 `node_modules/gitbash-mcp` 变成指向本仓库的软链接、依赖用仓库的 `node_modules`——仓库不能删/挪。要自包含副本：`npm pack` 后装 tgz；要发布版：`npm i -g gitbash-mcp@latest` |

## 红线（改代码前必读）

1. **绝不尝试在受限沙箱内跑 bash**：MSYS2 的 signal pipe 会被 WRITE_RESTRICTED 令牌掐死（Win32 error 5）。
2. **`exec` 的结果契约不可破坏**：`exit_code / stdout / stderr / timed_out / still_running / truncated /
   spill_path / spill_bytes / spill_truncated / duration_ms / killed_by / timeout_ms / queued_ms / audit_id / policy / warnings`
   （外加移交时的 `job_id`、审批时的 `approval_id`，以及缺 bash / 排队超时 / 作业超限 / 旧式 `//c` / 策略拦截 / 审批结局 / 会话关闭时的
   `error_code` + `hint`；完整列表见 DESIGN §4.1）。命令失败回 JSON，不抛工具错误。
   `exec` 不接受 `env` 参数：策略只判读命令文本，环境变量必须写在命令里接受判读。
3. **启动永不失败**：bash 探测必须惰性 + 缓存；缺 bash 时服务照常起，由 `exec` / `doctor` 报错。
4. **`command` 作为单个 argv** 传给 `bash -c/-lc`，不要引入引号转义层。
5. **长任务的四条不变量（DESIGN §5.1）**：① 授权完成后 `run_in_background` 必须毫秒级返回 `job_id`，作业生命期不挂在发起它的请求上；
   ② 取消（客户端超时与用户按停止在协议上不可区分）与前台预算到点都**移交**进程句柄，绝不杀进程丢成果；
   ③ 移交同时**清零继承的 `timeout_ms`**，否则「没被杀」的承诺会在 15 秒后变成谎言；
   ④ 杀整棵树只由 `timeout_ms` 在等待期内到点、`job_kill`、server 退出触发；`taskkill /pid <pid> /T /F`（只杀父进程会留 MSYS2 孤儿）。
   前台预算常量是 `FOREGROUND_MS`，必须明显小于 MCP 客户端默认的 60s 请求超时。
6. **护栏必须零配置**：并发/封顶/洗白/审计/作业上限都由代码常量决定。**风险姿态开关**是 `GITBASH_MCP_RISKY`（`ask` 默认 / `allow`），由 MCP 客户端启动配置注入；Bash 探测支持现有 `GITBASH_BASH`。不要为资源护栏新增配置项。
7. **只支持全局安装**：不提供 npx/bunx 方式；`package.json` 的 `files` 白名单必须保持精简。

## 安全边界（对外说明必须包含）

本进程在沙箱外运行，权限 = 启动它的 agent 进程的完整用户权限；无文件沙箱。

## 编码约定

- 纯 JS + ESM（`"type": "module"`），Node >= 18，兼容 Bun。**不用 TypeScript**：不要构建步骤，`bin` 必须能被 Node 直接执行。
- 逻辑按职责放 `lib/`；MCP 参数与响应适配放 `lib/mcp/tools/`，执行流程放 `execution/service.js`，授权判断放 `policy/authorization.js`。
  `server.js` 只保留组装、连接和退出清理；服务返回普通对象，执行原语不依赖 MCP SDK。逐文件职责见 `docs/REPO_MAP.md`。
- **一条命令只有一条执行路径**：新命令一律走 `execution/runner.js` 的 `launch()`；前台与后台的差别只是「等多久、到点怎么办」
  （`runWithForegroundBudget` / `jobs.startJob`）。别为「转后台」再起一个进程。
- **不改写调用方的命令文本**：写法必然失败时（如转换关闭下的 `cmd //c`）前置拒绝并给出改法——解析器只给出去引号后的词、
  没有原文 span，改写会破坏引号与转义。
- **完成判定只看直接子进程（shell）退出**，管道只多等 `EXIT_DRAIN_MS`；别退回「等 stdio 全部关闭」（DESIGN §5.1）。
- **两条并发路径语义固定**：`MAX_CONCURRENCY` 只管前台，后台由 `MAX_BACKGROUND_JOBS` 管；所有返回体都带 `queued_ms`。
- 菜单按键逻辑必须是**纯函数**（`reduceMenu`），渲染与终端交互分开，便于无 TTY 单测。
- **策略不得退回正则黑名单**：只做能力分类，判读不了就归 `opaque` → ask；改 `policy/shell-parse.js` / `policy/index.js`
  必须同步补 `test/test-policy.mjs`（解析器 + 档位 + 姿态裁决）。
- 用模板改文件时的转义约定：反引号会终止模板串、`$`+`{` 会插值（`String.raw` 也挡不住）。先用 read 取出旧文本拼 `old_string`，
  再按行数组拼 `new_string`，不要在模板里内联整段文件。
- 日志只走 stderr（stdout 是 MCP 协议通道）。`exec` 描述与 `instructions` 里的「Windows 上优先用它」是采纳率手段；
  `instructions` 属于 `initialize` 返回值，别塞进 `registerTool`；改措辞要同步 `test/test-client.mjs` 与 README。
- 审批不设人类等待超时；只有私有本机窗口能批准，MCP 只提供查询与取消。窗口不能执行命令，命令文本只能作为 JSON 数据传递。
- 需要审批的 exec 保持原调用等待，批准后返回执行结果，拒绝或关窗返回原因；等待不占执行并发、不计入执行时限。请求取消只解除等待，保留已受理审批；查询用于中断恢复，不新增 approval_wait。
- 关闭窗口撤销全部待审批；客户端断开、server 退出清理窗口与审批。批准绑定原请求且只能消费一次，运行后仍沿用作业契约。
- 每条审批独立返回；待审批清空后自动关闭窗口，不等待已批准的执行完成。新请求重新开窗，旧窗口回调不得影响新窗口。

## 完成定义（Definition of Done）

- [ ] 六套测试全绿：client / cli / menu / runner / policy / approval
- [ ] 长任务不变量有测试钉住：后台毫秒级返回句柄、取消移交（`job_list` 能找回）、预算到点移交、`job_kill` 能停
- [ ] `npm pack --dry-run` 只列出源码（`bin/`、`lib/`、`server.js`、`package.json`、`README.md`、`LICENSE`），不含 `docs/` 与测试文件
- [ ] `gitbash-mcp init --dry-run` 能正确预览各客户端配置
- [ ] 缺 bash 时服务仍能启动并给出 `BASH_NOT_FOUND` + 修复指引
- [ ] README / DESIGN / PROGRESS / REPO_MAP 与代码同步
