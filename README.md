# gitbash-mcp

把 **git-bash (MSYS2)** 交给 AI agent 用的 MCP server（DSH / Claude Code / Codex / Cursor / VS Code / Claude Desktop）。
它在 agent 的沙箱**之外**运行，所以管道、`$(...)`、子进程、Docker 全部可用；长任务可以转成后台作业，不会被客户端超时打断。

- 工具：`exec`、`job_output`、`job_list`、`job_kill`、`bash_info`、`doctor`、`policy`
- 运行时：Node >= 18（兼容 Bun）
- 协议：MCP stdio

## 为什么需要它

Windows 上 DSH 的沙箱用 WRITE_RESTRICTED 受限令牌跑命令。MSYS2 启动要建 signal pipe，受限令牌下直接失败
（实测 `couldn't create signal pipe, Win32 error 5`）；捕获子进程输出也会 `EPERM`。
**沙箱内跑 git-bash 无解**，所以这个 MCP 以独立进程活在沙箱外。

## 三个执行环境（先读，能省掉大量误诊）

同一个 agent 会话里通常有三个能力不同的执行环境，**同一个网络目标在不同环境里的结论可能不一致**：

| 环境 | 文件沙箱 | Windows 命名管道 | 网络路径 |
|---|---|---|---|
| **git-bash 桥（本 server）** | 沙箱**外**，可写任意路径 | **可访问**（Docker 可用） | 走宿主网络 |
| 宿主沙箱内的 shell（如 pwsh） | 受限（workspace-write） | **打不开** → `docker` 不可用 | 走宿主网络 |
| Docker daemon | — | — | **有独立代理配置**（如 `http.docker.internal:3128`） |

**推论（实测踩过）**：`docker manifest inspect`（客户端直连）与 `docker pull`（daemon 侧拉取）走的是两条网络路径，
会给出**互相矛盾**的答案。用前者断言「镜像不存在 / Docker Hub 不可达」是错的——它只能证明**客户端**连不上。

## 安装

只支持全局安装：

~~~powershell
npm i -g gitbash-mcp
# 或
bun add -g gitbash-mcp
~~~

不支持 npx / bunx：多一层包装，在 Windows 上以 stdio 启动不稳定。

## 部署到 MCP 客户端

**用 `init`**（推荐），它会把「绝对 runtime + 脚本路径」写进客户端配置：

~~~powershell
gitbash-mcp init          # 交互式勾选
gitbash-mcp init --yes    # 免交互，配置所有已检测到的客户端
gitbash-mcp init --dry-run
gitbash-mcp uninstall     # 反向移除，只删自己的条目
~~~

| 客户端 | 写入位置 | 格式 |
|---|---|---|
| DSH | `$DSH_HOME/cordis.patch.yml` | YAML insert |
| Claude Code | `~/.claude.json` | `mcpServers` |
| Codex CLI | `~/.codex/config.toml` | `[mcp_servers.gitbash]` |
| Claude Desktop | `%APPDATA%/Claude/claude_desktop_config.json` | `mcpServers` |
| Cursor | `~/.cursor/mcp.json` | `mcpServers` |
| VS Code | `<cwd>/.vscode/mcp.json` | `servers` |

- 默认写**绝对路径**（`node <...>/bin/gitbash-mcp.js`）。npm / bun 的全局 shim 目录常常不在 GUI 客户端的
  PATH 上，写裸命令 `gitbash-mcp` 会启不起来；只有你确认 shim 在 PATH 上时才用 `--runtime name`。
- 写入前备份 `*.bak`，重复运行幂等；`--target a,b` 精确指定，`--no-tui` 走编号输入。
- 探测依据直接显示在菜单里（PATH 可执行文件 → 配置目录 → 配置文件）。
- **配置完重启对应的客户端。**

## 工具

### `exec`：跑命令

| 参数 | 必填 | 说明 |
|---|---|---|
| `command` | 是 | bash 命令或多行脚本 |
| `cwd` | | 工作目录（Windows 路径）。省略时优先用客户端声明的 workspace root（MCP roots），否则用 server 进程的工作目录 |
| `timeout_ms` | | **进程生命期**上限（前台默认 60000ms，后台默认不限制；上限 600000ms），到点杀整棵进程树 |
| `login` | | `bash -lc`（读 profile） |
| `env` | | 追加环境变量；值为 `""` 表示**删除**该变量（如 `{"MSYS_NO_PATHCONV": ""}`） |
| `run_in_background` | | `true` = 转后台作业，立刻返回 `job_id` |

返回一段 JSON，常用字段：

| 字段 | 含义 |
|---|---|
| `exit_code` | 退出码；spawn 失败或被杀为 `-1`；已移交后台时为 `null` |
| `stdout` / `stderr` | 单流最多 64KB；超出部分转存到 `spill_path` 指向的文件 |
| `timed_out` | 前台等待没等到结束（配合 `still_running` 区分「被杀」还是「转后台」） |
| `still_running` | `true` = 命令还活着，用 `job_id` 取回 |
| `killed_by` | `timeout`（生命期到点）/ `kill`（`job_kill`）/ `null` |
| `timeout_ms` | **本次调用实际生效的生命期**；命令被移交后台后为 `0`（见下） |
| `duration_ms` / `queued_ms` | 实际耗时 / 因并发上限排队的时间 |
| `audit_id` | 这次调用的审计记录 id |
| `policy` | 一行裁决：`"allow"` 或 `"allow-risky (...)"` |
| `hint` | 超时、转后台、排队超时、缺 bash 时的下一步建议 |
| `warnings` | 只在可疑写法时出现，例如 `//FI` 这类旧式路径转义（见下） |

- **命令失败也是这个结构**（非零退出 / 超时 / spawn 失败都返回 JSON，不抛工具错误）
- 每次调用都是新进程，状态不保留（用 `cd` 或传 `cwd`）

### ⚠️ 从 2.3 升级：`//c` 写法要改成 `/c`

本 server **默认关掉 MSYS 路径转换**（`MSYS_NO_PATHCONV=1`），这样 `/bin/sh` 这类参数不再被改写成
Windows 路径，`docker run --rm --entrypoint /bin/sh …` 才能正常工作。副作用是 MSYS 的 `//x` 转义一起失效：

| 写法 | 2.3（转换开启） | 现在（转换关闭） |
|---|---|---|
| `cmd /c echo hi` | ✗ 参数被改写成 `C:/` | ✓ 正常 |
| `cmd //c echo hi` | ✓ 正常 | ✗ 被**拒绝执行**（见下） |
| `tasklist //FI "…"` | ✓ | ✗ 报「无效参数」，结果里附一行 `warnings` |

`cmd //c` 如果照直跑会**静默挂死**（cmd 收到 `//c` 后打印 banner 并等 stdin），所以工具直接拒绝它，
返回 `error_code: PATHCONV_ESCAPE` 并在 `hint` 里给出正确写法与逃生口。两种恢复方式：

- 单次调用改回旧行为：`exec { command: "cmd //c …", env: {"MSYS_NO_PATHCONV": ""} }`
- 或者照新规则写：`cmd /c …`（把这行加进你的提示词/脚本即可）

### 长任务：前台 45 秒封顶 + 后台作业

**一次前台调用最多等 45 秒**。超过时命令**不会被杀**，而是转成后台作业继续跑，返回体带上 `job_id`：

~~~jsonc
{ "timed_out": true, "still_running": true, "job_id": "job-...", "exit_code": null, "timeout_ms": 0, "hint": "..." }
~~~

为什么是 45 秒：MCP 客户端自己有一道请求超时（官方 SDK 默认 **60 秒**），到点它会取消请求。
45 秒让本 server 总是先返回结构化结果，调用方不必去猜 `MCP error -32001: Request timed out` 背后到底发生了什么。

移交之后命令**不再有生命期**（`timeout_ms` 变成 `0`）：`timeout_ms` 的语义是「**调用方愿意等多久**」，
而调用方已经不等了，剩下的时间不该继续倒计时把成果销毁。命令会一直跑到自己结束。

要跑长任务就直接说：

| 工具 | 作用 |
|---|---|
| `exec {run_in_background: true}` | 毫秒级返回 `job_id`；命令**不再绑定**在发起它的那次请求上 |
| `job_output {job_id, wait?, timeout_ms?, offset_bytes?}` | 读输出：默认非阻塞，返回状态 + 每条流尾部 64KB；`wait: true` 阻塞到结束或超时；`offset_bytes` 接着上次字节偏移读增量 |
| `job_list` | 列出本 server 起的作业、状态、退出码 |
| `job_kill {job_id}` | 显式停止（杀整棵树） |

**什么会杀进程树**：只有 `timeout_ms` 在**前台等待期内**到点、`job_kill`，以及 server 退出。
**取消一次调用不等于丢掉成果**：客户端超时和用户打断在协议上是同一个信号，无法区分，所以 server 选择
「提升为作业继续跑」——成果可以用 `job_list` 找回，要停就显式 `job_kill`。

**持久性（重要）**：作业活在 **server 进程内**，客户端重启即丢失句柄；但审计日志会记下作业的起止、退出码和
输出文件路径（`%TEMP%\gitbash-mcp\`，保留 24 小时），结果还能从盘上捞回来。需要跨重启的可靠后台执行，请用
`schtasks` 或系统服务。

### 其他工具

- `bash_info` — 报 bash 路径与 bash/git 版本
- `doctor` — 完整环境诊断，**bash 异常先调它**
- `policy` — 打印当前姿态与完整规则；被拦住后调它才能向用户解释清楚

## 典型用法

agent 侧的调用长这样：

~~~text
# 普通命令
exec { command: "git status --porcelain" }

# 写 workspace 之外（沙箱内的 shell 做不到）
exec { command: "cd /c/Users/me/winter-install/anaconda && ./conda.exe install -y numpy" }

# 长任务：先拿句柄，再按需读（全程不受客户端超时影响）
exec        { command: "docker pull postgres:17.9", run_in_background: true }   -> job-xxxx
job_output  { job_id: "job-xxxx", wait: true, timeout_ms: 30000 }               # 等到结束，收退出码
job_output  { job_id: "job-xxxx", offset_bytes: 65536 }                         # 接着上次的字节偏移读增量
job_kill    { job_id: "job-xxxx" }                                             # 显式停止

# 大输出：内存只留 64KB，全文在返回的 spill_path 指向的文件里
exec { command: "for i in $(seq 1 20000); do echo line-$i; done" }
~~~

## 命令策略

不是黑名单，是**能力分类**：命令被切成若干段逐段判定，只有每段都可读、或由项目自己声明、且没有不可判读构造时才自动放行。
唯一开关 `GITBASH_MCP_RISKY` 写在 MCP 客户端配置里（模型改不了，改完要重启服务器）。

| 判定 | 默认 `ask` | `allow` |
|---|---|---|
| read-only / project | 放行 | 放行 |
| mutating / unknown / opaque | 拦住，让你决定（`APPROVAL_REQUIRED`） | 放行 + 审计 |
| catastrophic | 拒绝（`POLICY_DENIED`） | 放行 + 审计 |

被拦住时模型会拿到三条路：① 你自己在终端跑 ② 换更安全的写法 ③ 改配置加 `GITBASH_MCP_RISKY=allow` 并重启。
放行时结果里只有**一行** `policy` 结论，完整规则清单按需查：命令行 `gitbash-mcp policy`，或让模型调 `policy` 工具。

## 护栏（零配置）

- **并发上限 4**：超出排队并在结果里报 `queued_ms`；排队时间**不计入**命令的 `timeout_ms`，
  若排队吃掉了整个前台预算，返回 `error_code: EXEC_QUEUE_TIMEOUT` 而不是让你干等
- **后台作业上限 8**：超出返回 `error_code: TOO_MANY_JOBS`
- **输出封顶**：内存单流 64KB，转存文件另有 64MB 上限、24 小时清理
- **环境洗白**：清掉凭据形状变量（`*_TOKEN` / `*_API_KEY` / `AWS_*` / `*PASSWORD*`），保留 `SSH_AUTH_SOCK`
- **审计**：每次调用一行 JSONL，`gitbash-mcp audit` 查看

> 这些是「降低误伤」的护栏，**不是安全边界**——挡不住 `r''m`、`$IFS`、`base64 -d|bash` 这类蓄意绕过。
> 真正的隔离只能在 OS 层做（低权限账户 / 容器 / VM）。

## 安全边界

本进程在沙箱外运行，权限 = 启动它的 agent 进程的**完整用户权限**，没有文件沙箱；模型可以无门槛调用 `exec`。
这不是缺陷，而是此类 MCP 桥的既有模型——使用前请知悉。

## 故障排查：`BASH_NOT_FOUND`

缺 bash 不会让服务崩：它照常启动，每次 `exec` 返回带修复指引的 JSON。修复二选一，然后重启客户端：

1. 装 Git for Windows（自带 git-bash）：https://git-scm.com/download/win
2. 设 `GITBASH_BASH` 指向你的 bash.exe，例如 `C:/Program Files/Git/bin/bash.exe`

检测顺序：`GITBASH_BASH`（文件必须存在）→ PATH 上的 `bash` → 常见安装路径
（Program Files、`%LOCALAPPDATA%\Programs\Git`、scoop shims、`C:\msys64`、`C:\cygwin64`）。

## 相关文档

- `docs/DESIGN.md` — 架构与完整契约（结果字段、决策记录、被否方案）
- `docs/REPO_MAP.md` — 代码地图：文件职责、任务→文件索引
- `docs/PLAN.md` — 里程碑与风险登记
- `AGENTS.md` — 维护者须知：红线、常用命令、编码约定
