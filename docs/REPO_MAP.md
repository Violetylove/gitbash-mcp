# gitbash-mcp 代码地图（Repo Map）

> 用途：接手这个仓库时先看这张图，再决定读哪个文件。设计理由见 `docs/DESIGN.md`，红线见 `AGENTS.md`。

## 1. 运行链路

~~~
MCP 客户端（DSH / Claude Code / Codex / Cursor / VS Code / Claude Desktop）
  └─ 拉起 gitbash-mcp（Node 进程，沙箱外，stdio）
       ├─ 无参数        → server.js        → 注册 exec / job_output / job_list / job_kill / bash_info / doctor / policy
       └─ init|uninstall|doctor|audit|policy|help → lib/cli.js
            └─ child_process.spawn → bash.exe -c/-lc <command>
                 ├─ 前台：runWithForegroundBudget → 45s 预算 → 到点 adopt() 进作业注册表
                 └─ 后台：startJob → 立刻返回 job_id（生命期与请求无关）
~~~

命令永远作为**单个 argv** 交给 `bash -c/-lc`，中间没有转义层。

## 2. 目录树

~~~
gitbash-mcp/
├── AGENTS.md              ← 接手 agent 的规则与红线
├── README.md              ← 用户文档
├── LICENSE
├── package.json           ← ESM、bin、files 白名单、npm test 脚本
├── bin/gitbash-mcp.js     ← 唯一入口：分发 server 或 CLI
├── server.js              ← MCP server：工具注册 + 裁决接线 + 超时/移交策略 + 服务端 instructions
├── lib/                   ← 共享逻辑（纯函数优先，便于无 TTY 单测）
│   ├── detect.js          ← bash 检测（惰性 + 缓存）+ doctor 报告
│   ├── runner.js          ← launch/runWithForegroundBudget + 输出通道 + 截断/spill + 并发 + 杀树 + 环境
│   ├── jobs.js            ← 后台作业注册表：startJob / adopt / jobPayload / waitForJob / killJob
│   ├── shell-parse.js     ← 命令解析：切段 / 去引号 / 关键字 / 重定向 / 标记 opaque（纯函数）
│   ├── policy.js          ← 能力分类 + 项目声明信任 + 姿态裁决（纯函数）
│   ├── audit.js           ← JSONL 审计日志：追加 / 读取 / 路径 / 5MB 轮转
│   ├── menu.js            ← 备用屏幕勾选菜单（reducer 纯函数 + 渲染）
│   ├── theme.js           ← ANSI 着色与符号（尊重 NO_COLOR/FORCE_COLOR/TERM=dumb）
│   └── cli.js             ← init / uninstall / doctor / audit / policy 交互实现
├── test/                  ← 五套测试（不入发布包）
│   ├── test-client.mjs    ← MCP 协议冒烟（含后台作业 / 取消移交）
│   ├── test-cli.mjs       ← CLI 冒烟（临时 root）
│   ├── test-menu.mjs      ← 菜单按键逻辑单测
│   ├── test-runner.mjs    ← 护栏与执行原语单测（通道 / 预算 / 作业 / 审计）
│   └── test-policy.mjs    ← 策略单测（解析回归 + 档位 + 裁决）
└── docs/
    ├── DESIGN.md          ← 设计文档（契约 / 决策 / 被否方案）
    ├── PLAN.md            ← 里程碑 / 风险登记表
    └── REPO_MAP.md        ← 本文
~~~

## 3. 入口分发（`bin/gitbash-mcp.js`）

| argv[2] | 去向 |
|---|---|
| 无 / 其它 | `server.js`：起 MCP server（stdio） |
| `init` / `uninstall` | `lib/cli.js`：写/删各客户端 MCP 配置 |
| `doctor` | `lib/cli.js`：环境诊断 |
| `audit` | `lib/cli.js`：读审计日志 |
| `policy` | `lib/cli.js`：打印命令策略 |
| `help` / `--help` / `-h` / `--version` / `-v` | `lib/cli.js` |

## 4. lib 模块与关键导出

| 模块 | 关键导出 | 职责 / 注意 |
|---|---|---|
| `detect.js` | `findOnPath` `buildBashCandidates` `detectBash(force)` `missingBashResult` `doctorReport` `GIT_FOR_WINDOWS_URL` | 检测顺序 `GITBASH_BASH` → PATH → 常见路径；惰性 + 缓存，**启动永不失败** |
| `runner.js` | `launch` `runWithForegroundBudget` `spawnBash` `createChannel` `collectStream` `readChannelText` `createSemaphore` `killTree` `scrubEnv` `buildEnv` | 常量：`DEFAULT_TIMEOUT_MS=60000` `MAX_TIMEOUT_MS=600000` `FOREGROUND_MS=45000` `QUEUE_FLOOR_MS=250` `OUTPUT_CAP_BYTES=64KB` `SPILL_CAP_BYTES=64MB` `JOB_TAIL_BYTES=64KB` `MAX_CONCURRENCY=4` `KILL_GRACE_MS=1500` `MSYS_NO_PATHCONV='1'`；`launch.cancelAction='report'` = 取消不移交则杀的分界线 |
| `jobs.js` | `startJob` `adopt` `getJob` `listJobs` `runningJobCount` `waitForJob` `killJob` `killAllJobs` `jobPayload` | 常量：`MAX_BACKGROUND_JOBS=8` `MAX_RETAINED_JOBS=32` `MAX_JOB_WAIT_MS=50000`；作业元数据只在进程内，审计落 `log_path` |
| `shell-parse.js` | `parseCommand` | 纯函数；here-doc 正文跳过；shell 关键字（`for`/`do`/`done`/`{`/`}`/`then`/`fi`…）不再当程序名；`2>&1`/`&>`/`/dev/null` 正确归类；`$( )`/反引号/`$'…'`/变量程序名/子 shell → `opaque` |
| `policy.js` | `evaluateCommand` `decide` `currentStance` `describePolicy` `projectEntry` `lists` | 档位：read-only / project / ask-required / dangerous / catastrophic；唯一开关 `GITBASH_MCP_RISKY`；reason 去重 |
| `audit.js` | `appendAudit` `readAudit` `auditPath` `auditDir` `AUDIT_MAX_BYTES` | JSONL；`AUDIT_MAX_BYTES = 5MB` 后轮转到 `.1.jsonl` |
| `menu.js` | `createMenuState` `reduceMenu` `menuRows` `menuLines` `renderFrame` `paintFrame` `readCheckboxMenu` | 按键逻辑是纯 reducer，可无 TTY 单测 |
| `theme.js` | `makeStyler` `esc` | ANSI 颜色与转义序列 |
| `cli.js` | `buildCandidates` `roots` | 6 个固定客户端；`--root` 覆盖配置根（测试用） |

## 5. `server.js` 工具面

| 工具 | 作用 | 备注 |
|---|---|---|
| `exec` | 跑 bash 命令/多行脚本，返回统一 JSON | 描述里声明「Windows 上优先选它」；失败回 JSON，不抛工具错误；`run_in_background: true` 转后台 |
| `job_output` | 读作业状态与输出（tail/offset/wait） | 默认非阻塞；`wait: true` 阻塞到结束或 `timeout_ms`（上限 50s） |
| `job_list` | 列作业与状态 | 后台作业 + 被移交的前台命令 |
| `job_kill` | 显式停止（整树杀） | 唯一「主动停」的入口；后台作业不会被客户端超时杀掉 |
| `bash_info` | bash 路径 + bash/git 版本 | 缺 bash 时回修复说明 |
| `doctor` | 完整环境诊断 | bash 异常先调它 |
| `policy` | 打印当前姿态与完整规则 | 被 `APPROVAL_REQUIRED`/`POLICY_DENIED` 后调它向用户解释；`exec` 结果里只有一行裁决 |

服务端还通过 MCP `initialize` 的 `instructions` 字段声明「gitbash-mcp 是沙箱外的 git-bash，Windows 上优先用 `exec`，长任务用 `run_in_background`」；支持的客户端会把它注入模型上下文。

## 6. 契约与常量速查

- **结果契约**（`exec`，见 `DESIGN.md` §4.1）：`exit_code / stdout / stderr / timed_out / still_running / truncated / spill_path / spill_bytes / spill_truncated / duration_ms / killed_by / timeout_ms / audit_id / queued_ms / policy`，外加移交时的 `job_id`、缺 bash 时的 `error_code` / `hint`、排队超时的 `EXEC_QUEUE_TIMEOUT`、作业超限的 `TOO_MANY_JOBS`。
- **作业契约**（`job_output`，见 `DESIGN.md` §4.5）：`status / still_running / exit_code / killed_by / timeout_ms / stdout / stderr / next_offset / stdout_bytes / stderr_bytes / log_path`。
- **唯一环境变量**：`GITBASH_MCP_RISKY=ask`（默认）/ `allow`，由人类在 MCP 客户端配置里注入，模型不得自行设置。
- **日志只走 stderr**：stdout 是 MCP 协议通道。
- **护栏零配置**：并发/封顶/洗白/审计/作业上限都由 `lib/runner.js` 与 `lib/jobs.js` 的常量决定。
- **发布白名单**：`package.json` 的 `files` = `bin/`、`lib/`、`server.js`、`README.md`、`LICENSE`。

## 7. 任务 → 改哪里

| 想改什么 | 动这些文件 | 同步补测试 |
|---|---|---|
| bash 检测 / doctor | `lib/detect.js` | `test/test-client.mjs`、`test/test-runner.mjs` |
| 执行 / 超时 / 前台预算 / 截断 / spill / 并发 / 洗白 | `lib/runner.js` | `test/test-runner.mjs` |
| 后台作业（注册表 / 输出读取 / 停止 / 上限） | `lib/jobs.js` | `test/test-runner.mjs`、`test/test-client.mjs` |
| 解析（切段 / 引号 / 关键字 / 重定向 / opaque） | `lib/shell-parse.js` | `test/test-policy.mjs` |
| 档位 / 裁决 / 项目信任 / 姿态 | `lib/policy.js` | `test/test-policy.mjs` |
| 审计格式 / 轮转 | `lib/audit.js` | `test/test-runner.mjs` |
| CLI 客户端写入 / 探测 | `lib/cli.js` | `test/test-cli.mjs` |
| 菜单按键 / 配色 | `lib/menu.js`、`lib/theme.js` | `test/test-menu.mjs` |
| 工具定义 / 描述 / 移交策略 / 服务端 instructions | `server.js` | `test/test-client.mjs` |
| 入口分发 | `bin/gitbash-mcp.js` | `test/test-cli.mjs` |
| 打包白名单 / 脚本 | `package.json` | `npm pack --dry-run` |

## 8. 测试对照

| 套件 | 覆盖 | 能否在受限沙箱内跑 |
|---|---|---|
| `test/test-client.mjs` | 工具握手、doctor、管道、非零退出、生命期超时杀树、后台作业全流程、取消移交、spill、策略、缺 bash 降级 | 否（spawn bash + 管道） |
| `test/test-cli.mjs` | help/version/doctor、dry-run 不落盘、init 写入并保留既有内容、备份、幂等、uninstall | 否（子进程管道） |
| `test/test-menu.mjs` | 菜单 reducer、选中、渲染、颜色开关 | 是（纯函数） |
| `test/test-runner.mjs` | 洗白与 `MSYS_NO_PATHCONV`、spill 双重封顶、通道 tail/offset、并发、取消杀树、预算移交、作业生命周期、审计往返与轮转 | 部分（杀树/作业要 bash） |
| `test/test-policy.mjs` | 解析回归（关键字 / `2>&1` / `/dev/null`）、50+ 档位分类用例、项目信任、姿态裁决、报告 | 是（纯函数） |

## 9. 文档地图

| 文档 | 读者 | 内容 |
|---|---|---|
| `README.md` | 用户 | 安装、配置、工具、护栏、策略、排错 |
| `AGENTS.md` | 接手 agent | 仓库地图、常用命令、红线、编码约定、完成定义 |
| `docs/DESIGN.md` | 维护者 | 架构、工具契约、关键决策、被否方案、测试策略 |
| `docs/PLAN.md` | 维护者 | 里程碑、未完成项、风险登记表 |
| `docs/REPO_MAP.md` | 任何人 | 本文：文件职责、任务→文件索引 |
