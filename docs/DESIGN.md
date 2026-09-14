# gitbash-mcp 设计文档

> 状态：2.5.0（Node 运行时 + 全局安装 + 后台作业与超时契约）。决策记录见 §5、§7；被否方案见 §7。

## 1. 背景与限制（实测）

DSH 的 Windows 沙箱（`@deepseek-ai/dsh-sandbox-windows-acl`）用 **WRITE_RESTRICTED 受限令牌**执行命令，后果：
新建命名管道失败（Node `spawn` 默认 `stdio:'pipe'` → `spawn EPERM`），而 MSYS2 启动即需创建 signal pipe
（`couldn't create signal pipe, Win32 error 5`）。**沙箱内跑 git-bash 无解**，执行进程必须在沙箱外。

## 2. 目标 / 非目标

目标：`exec`（跑命令）、**后台作业**（`job_output` / `job_list` / `job_kill`）、`doctor`（环境诊断）、**永不因环境问题启动失败**、
超时整树杀 + 截断/spill、通过 **npm 全局安装**分发（无自带运行时）。

非目标：DSH skill 打包、原生 executor 插件、沙箱内执行、
**单文件 exe**（内嵌运行时 108MB，全局安装不需要）、**npx/bunx 安装方式**。

## 3. 架构

~~~
MCP 客户端（DSH / Claude Code / Codex）
  └─ cross-spawn 拉起全局命令 gitbash-mcp（.cmd shim 由 cross-spawn 处理）
       └─► gitbash-mcp（Node 进程，沙箱外）
             └─ child_process.spawn → bash.exe -c/-lc <command>
~~~

传输：MCP stdio（官方 SDK `McpServer` + `StdioServerTransport`）；校验 `zod`；ESM；Node >= 18（兼容 Bun）。

代码结构：`bin/gitbash-mcp.js` 是唯一入口（无参 → 起 MCP server；`init`/`uninstall`/`doctor` → CLI）；
`server.js` 只做工具注册，`lib/detect.js`（bash 检测 / doctor）与 `lib/runner.js`（spawn / 截断 / 前台预算）被两者共用，
`lib/jobs.js` 是 server 进程内的后台作业注册表，`lib/cli.js` 是零依赖（`node:readline`）的客户端配置写入器。
逐文件职责与「任务→改哪里」见 `docs/REPO_MAP.md`。

关键结构：**一条命令只有一条执行路径**。`lib/runner.js` 的 `launch()` 起进程并挂上两个「输出通道」（内存封顶 + spill 全文），
前台 `exec` 与后台作业都是它的调用方；`runWithForegroundBudget()` 只决定「等多久、到点怎么办」。
因此「前台调用超时 → 转后台」不是新起一条命令，而是把同一个句柄交给 `lib/jobs.js`（§5.10）。

## 4. 工具契约

除下面七个工具外，服务端还在 MCP `initialize` 的 `instructions` 字段里声明「本服务是沙箱外的 git-bash；
Windows 上优先用 `exec`，长任务用 `run_in_background`，把原生 PowerShell 留给 Windows 专有能力」——支持的客户端会把它注入模型上下文，
这是最通用的采纳手段（`exec` 的描述里也重复了一句，覆盖不读 `instructions` 的客户端）。

### 4.1 `exec`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `command` | string | 是 | bash 命令或多行脚本，作为**单个 argv** 传给 `bash -c/-lc` |
| `cwd` | string | | 工作目录（Windows 路径）；省略时用 `roots/list` 的第一个 workspace root，取不到再用 server 进程 cwd |
| `timeout_ms` | int | | **进程生命期**：前台默认 60000，后台默认 0（无限），上限 600000；到点整树杀 |
| `login` | bool | | `bash -lc`（读 profile） |
| `env` | object | | 追加环境变量；值为 `""` = 删除该变量（撤销默认） |
| `run_in_background` | bool | | `true` = 转后台作业，毫秒级返回 `job_id`（§4.5） |

~~~jsonc
{
  "exit_code": 0,        // spawn 失败或超时为 -1；已移交后台时为 null
  "stdout": "...",       // 超过 64KB 截断（截断时保留开头 64KB）
  "stderr": "",
  "timed_out": false,    // true = 前台等待没等到结束（见 still_running 区分是被杀还是转后台）
  "still_running": false,// true = 命令还活着，用 job_id 取回
  "truncated": false,
  "spill_path": null,     // 有截断时指向 %TEMP%\gitbash-mcp\ 的全量日志
  "spill_bytes": 0,       // 已写入 spill 的字节数
  "spill_truncated": false, // spill 文件本身是否封顶截断
  "duration_ms": 123,      // 实际耗时
  "killed_by": null,       // 'timeout' | 'kill' | null（取消不再杀进程，见 §5.10）
  "timeout_ms": 60000,     // 本次调用实际生效的生命期；被移交后台后为 0（§5.11）
  "queued_ms": 0,          // 因并发上限而排队的时间
  "audit_id": "...",       // 该次调用的审计记录 id
  "job_id": "job-...",     // 仅在命令被移交后台时出现
  "policy": "allow",       // 一行裁决：'allow' | 'allow-risky (tier, stance=..., see the policy tool)'
  "hint": "...",           // 超时 / 转后台 / 排队超时 / 缺 bash 时的下一步建议
  "warnings": ["..."],     // 可疑写法（旧式 //FI 转义），见 §5.15
  "error_code": "APPROVAL_REQUIRED", // 被策略拦住时：APPROVAL_REQUIRED | POLICY_DENIED
  "error_code": "PATHCONV_ESCAPE",   // 旧式 //c：拒绝执行而不是挂死，见 §5.15
  "category": "dangerous",
  "matched_rules": ["recursive delete"],
  "error_code": "EXEC_QUEUE_TIMEOUT", // 排队吃掉整个前台预算（没启动）
  "error_code": "TOO_MANY_JOBS",      // 后台作业已达上限
  "error_code": "BASH_NOT_FOUND"      // 仅缺 bash 时出现
}
~~~

- 命令失败（非零退出 / 超时 / spawn 失败）→ 返回 JSON，**不抛 MCP 错误**
- 参数错误（command 为空）→ 抛 MCP 错误
- `policy` 永远是**一行字符串**：明细（规则清单、命中原因）按需查 `policy` 工具或 `gitbash-mcp policy`（§5.12）
- 环境默认值：`GIT_PAGER=cat`、`NO_COLOR=1`、`MSYS_NO_PATHCONV=1`（§5.13）

### 4.2 `bash_info`
返回 bash 路径、bash/git 版本、HOME/PWD/MSYSTEM；缺 bash 时返回修复说明。

### 4.3 `doctor`
纯文本诊断：platform、runtime、execPath、`GITBASH_BASH` 值及有效性、命中的 bash 及来源、
PATH 上的 git、**逐条候选路径命中情况**、缺 bash 时的修复步骤。

### 4.4 `policy`
纯文本打印当前姿态（`GITBASH_MCP_RISKY`）与完整规则清单。被 `APPROVAL_REQUIRED` / `POLICY_DENIED`
拦住后，模型调它才能准确向用户解释「拦了什么、为什么、三条出路」。

### 4.5 后台作业：`job_output` / `job_list` / `job_kill`

| 工具 | 参数 | 说明 |
|---|---|---|
| `job_output` | `job_id`；`wait?`；`timeout_ms?`（默认 30000，上限 50000）；`offset_bytes?`；`tail_bytes?`（默认/上限 65536） | 默认非阻塞：状态 + 每条流尾部 64KB。`wait: true` 阻塞到作业结束或超时。`offset_bytes` 按 **stdout** 字节偏移读增量（`stderr` 恒按尾部返回），响应的 `next_offset` 就是下次该传的值 |
| `job_list` | — | 本 server 起的作业（后台 + 被移交的前台）与状态、退出码、字节数 |
| `job_kill` | `job_id` | 杀整棵进程树（`taskkill /T /F`），`killed_by: "kill"` |

`job_output` 返回体：`job_id` `status`(`running`/`exited`/`killed`/`timeout`) `still_running` `mode` `command` `cwd` `pid`
`started_at` `ended_at` `duration_ms` `exit_code` `timed_out` `killed_by` `timeout_ms` `audit_id` `policy`
`stdout` `stderr` `stdout_offset` `stderr_offset` `next_offset` `stdout_bytes` `stderr_bytes` `log_path` `log_truncated`。
未知 `job_id` → `error_code: JOB_NOT_FOUND`（结构化结果，不是工具错误）。作业元数据只在 server 进程内，
审计日志另记 `job_id` / `command` / `exit_code` / `log_path`，输出文件在 `%TEMP%\gitbash-mcp\`（24h 内可捞）。

后台**启动**的返回体：`job_id` `status` `still_running` `pid` `started_at` `timeout_ms` `queued_ms`（恒 0，见 §5.7）
`command` `cwd` `audit_id` `policy`，可疑写法时附 `warnings`。

### 4.6 CLI（`init` / `uninstall` / `doctor`）

`gitbash-mcp init` 探测本机已安装的客户端并交互式写入 MCP 配置：

| 客户端 | 写入位置 | 格式 |
|---|---|---|
| DSH | `$DSH_HOME/cordis.patch.yml` | YAML insert 行 |
| Claude Code | `~/.claude.json` | `mcpServers` |
| Codex CLI | `~/.codex/config.toml` | `[mcp_servers.gitbash]` |
| Claude Desktop | `%APPDATA%/Claude/claude_desktop_config.json` | `mcpServers` |
| Cursor | `~/.cursor/mcp.json` | `mcpServers` |
| VS Code | `<cwd>/.vscode/mcp.json` | `servers` |

交互：`lib/menu.js` 的原位勾选菜单（`↑/↓`/`k`/`j` 移动，`空格` 切换，`a`/`n` 全选/全不选，`1-9` 跳转，`回车` 确认，`q`/`Esc`/`Ctrl-C` 取消），
非 TTY 或 `--no-tui` 回退编号输入；按键逻辑是纯函数 `reduceMenu`（帧内容 `menuRows`/`renderFrame`），由 `test/test-menu.mjs` 单测覆盖。
观感：备用屏幕 + 整帧重绘 + ANSI 着色（`lib/theme.js`，尊重 `NO_COLOR`/`FORCE_COLOR`/`TERM=dumb`），支持 resize。

写入语义（重要）：JSON 类目标是**按键合并后整文件重写**（已有键保留但格式被规范化）；
TOML/YAML 类是**先删除我们自己的段/块，再追加到文件末尾**。两类写入前都备份 `*.bak`，重复运行幂等。

探测：`configPath` 与 `detected` 实时计算——目标是**配置文件/目录存在**，或 **PATH 上存在对应可执行文件**
（`claude`、`codex`、`cursor`、`code`）。列表按「已探测在前」稳定排序，未探测的标注 `(not detected)` 但仍可选中。
受支持客户端**固定 6 项**：格式与位置各不相同，无法从文件系统推导。
其他开关：`--dry-run` 只预览；`--target a,b` 精确指定；`--yes` 免交互；`--runtime auto|node|bun|name`；`--root DIR` 覆盖配置根（测试用）。

## 5. 关键设计决策

### 5.1 惰性检测，启动永不失败
探测在首次调用时进行并缓存，不在模块顶层抛错。否则进程退出 → MCP 启动失败 → 工具不注册 →
模型看不到任何东西，无法提示用户。现在缺 bash 时服务照常起，由 `exec` / `doctor` 报修复步骤。

### 5.2 检测顺序
`GITBASH_BASH`（仅当文件存在）→ PATH 中的 `bash`（自实现 PATH + PATHEXT 查找）→ 常见安装路径
（Program Files、Program Files (x86)、`%LOCALAPPDATA%\Programs\Git`、scoop shims、`C:\msys64`、`C:\cygwin64`）。
`GITBASH_BASH` 设了但文件不存在时明确报出，不静默回退。

### 5.3 参数与引号
`command` 作为**一个 argv 元素**传给 `bash -c`，bash 自己解析，中间无转义层。

### 5.4 超时、前台预算与进程树

三件事必须分开看（这是 v2 用户反馈的核心，见 §5.10/§5.11）：

| 概念 | 常量 | 含义 |
|---|---|---|
| 进程生命期 | `DEFAULT_TIMEOUT_MS` / `MAX_TIMEOUT_MS` | `timeout_ms`；到点 `taskkill /pid <pid> /T /F` 整树强杀，`killed_by: "timeout"`。前台默认 60s，后台默认无限 |
| 前台等待预算 | `FOREGROUND_MS = 45000` | 一次 MCP 请求最多等多久。到点**不杀**，把句柄交给作业注册表 |
| 排队上限 | `QUEUE_FLOOR_MS = 250` | 并发闸门若吃掉整个预算，干脆不启动，返回 `EXEC_QUEUE_TIMEOUT` |

杀完整树后仍给 1.5s（`KILL_GRACE_MS`）有界宽限结算，不等孤儿进程占着的管道（§5.16）。
**取消不杀进程**：`notifications/cancelled`（客户端请求超时与用户按停止都走这条路）被当成「移交」而非「丢弃」（§5.10）。

### 5.5 输出编码与截断
UTF-8 解码；单流内存上限 64KB，超出后完整流转存 `%TEMP%\gitbash-mcp\`，返回 `truncated` + `spill_path`。
spill 写入完成后才 resolve，另有 5 秒强制兜底，保证调用永不悬挂。固定 `GIT_PAGER=cat`、`NO_COLOR=1`。

### 5.6 安全边界
进程在沙箱外运行，权限 = 启动它的 agent 进程的完整用户权限；无文件沙箱。
模型可无门槛调用 `exec`——这是 MCP 桥的既有模型，不在本工程内自造审批/降权。

### 5.7 护栏（P0，零配置）

git-bash 无法在受限令牌下运行，所以这个 MCP 天然没有沙箱。P0 的目标不是"防住攻击者"（做不到），
而是**修掉自身缺陷 + 把危险留给人类决定 + 全程可审计**：

| 机制 | 实现 | 常量 |
|---|---|---|
| 生命期到点杀树 | 单条命令的 `timeout_ms` → `taskkill /T /F`；杀掉后给 1.5s 宽限，等不到管道关闭也结算（§5.16） | `KILL_GRACE_MS = 1500` |
| 完成判定 | 以**直接子进程（shell）退出**为准，管道只多等一个短排水窗口 | `EXIT_DRAIN_MS = 250` |
| 并发上限（前台） | `createSemaphore` FIFO 排队，结果报 `queued_ms`；排队时间不计入 `timeout_ms`（生命期计时从 spawn 开始） | `MAX_CONCURRENCY = 4` |
| 后台作业上限 | 同时在跑的后台作业数；后台**不占**前台名额（它不阻塞调用方），两者之和就是进程总数上限 | `MAX_BACKGROUND_JOBS = 8` |
| 输出封顶 | 内存 64KB + spill 文件封顶 | `OUTPUT_CAP_BYTES = 64KB`、`SPILL_CAP_BYTES = 64MB` |
| 环境洗白 | spawn 前清掉凭据形状变量（`*_TOKEN`/`*_API_KEY`/`AWS_*`/`*PASSWORD*`），保留 `SSH_AUTH_SOCK` | — |
| 审计 | 每次调用追加 JSONL，`gitbash-mcp audit` 读取；作业另记 start/finish 两行（含 `log_path`） | — |

> 关键教训（实测）：`taskkill /T /F` 本身有效，但**被杀的 MSYS2 孙进程可能继续持有 stdio 管道**，
> 把 `close` 事件拖到子进程自然结束。因此杀完后必须在有界宽限内直接结算，不能只等 `close`。

这些是"降低误伤"的护栏，**不是安全边界**（分类器再细也挡不住蓄意绕过：`r''m`、`$IFS`、`base64 -d|bash` 等）。真正的隔离只能在 OS 层。

### 5.8 命令策略（P1，单开关，能力分类 / 模型 D）

不做正则黑名单，做**能力分类**（`lib/shell-parse.js` 解析 + `lib/policy.js` 裁决，两者都是纯函数）：

1. **解析** `parseCommand`：去引号与转义、按 `&& || ; | & 换行` 切段、记录重定向目标；here-doc 正文整体跳过（它是数据）；
   `$( )`、反引号、`$'…'`、变量当程序名、`( )` 子 shell、未闭合引号 → 标记 `opaque`。
   **shell 关键字是语法不是程序**：`{`/`}`/`!`/`if`/`then`/`else`/`while`/`do` 丢弃后继续判定其后的命令
   （`{ rm -rf /; }` 仍是 catastrophic），`for`/`case`/`function`/`in`/`done`/`fi` 这类无命令的语法直接跳过；
   重定向按 `n>`/`n>>`/`&>`/`n>&m`/`n>&-` 识别，fd 复用、关闭与 `/dev/null` 都不算文件写入。
2. **逐段判定能力**：`read-only`（内置 ~85 个程序 + 27 个 git 只读子命令）/ `project` / `mutating` / `unknown` / `opaque` / `catastrophic`。
3. **汇总裁决**：`catastrophic` → deny；`opaque`/`mutating`/`unknown` → ask-required；全部 read-only 或 project → allow；
   `GITBASH_MCP_RISKY=allow` 时全部放行并标注 `allow-risky`。

**项目声明的信任**（替代白名单文件）：`projectEntry(cwd)` 向上最多 6 层找 `package.json` scripts、`Makefile` 目标、
`justfile` recipe，只匹配 `npm run <name>` / `make <target>` / `just <recipe>`；项目改脚本就等于改自己的白名单。

**结构化优先于正则**：`rm -rf`/`-fr`/`--recursive` 靠提取 flag 与目标判定。早期逐行 `^rm` 匹配漏掉多行脚本里的
`rm -rf /`，here-doc 正文也曾被当成命令——两个 bug 都由 `test/test-policy.mjs` 钉住。

**不实现 in-band 批准码**：模型拥有同一个 shell，它能跑任何它能提交的批准命令。唯一不可伪造的同意通道是 MCP 启动配置。

### 5.9 分发：全局安装，不做 exe
`bin: { gitbash-mcp: bin/gitbash-mcp.js }`，shebang `#!/usr/bin/env node`，用户 `npm i -g gitbash-mcp`。
`bun build --compile` 会内嵌整个 Bun 运行时（实测 108.82MB），全局安装只需用户已有的 Node（约 14MB）。
已核实 `cross-spawn/lib/parse.js`：非 `.exe/.com` 扩展名会经 `cmd.exe /d /s /c` 包装，因此全局 `.cmd` shim 可直接作为客户端的 `command`。

### 5.10 后台作业：为什么必须由 server 自己做，以及取消为什么不再杀进程

MCP server 是**跨调用长期存活的独立进程**（stdio，一个会话一个进程），所以「job 注册表 + 轮询/停止接口」
完全可以在 server 内实现，不需要客户端配合——这一点是本设计的出发点：

1. **`run_in_background: true` 立即返回 `job_id`**：请求毫秒级结束，客户端那 ~60s 的请求超时无从触发；
   作业生命期**不绑定**在发起它的请求上（`startJob` 不接 `signal`）。
2. **取消 = 移交，不是丢弃**：客户端超时与用户按「停止」在协议上不可区分（都是 `notifications/cancelled`），
   而「成果消失」是更坏的误判。所以 `runWithForegroundBudget` 用 `cancelAction: 'report'`，收到取消时把同一个进程句柄
   `adopt()` 进注册表继续跑，`job_list` 能找回，`job_kill` 能停。代价是「按停止」不再立即断掉命令——刻意取舍。
3. **前台预算到点也移交**（§5.11）。三条路径（正常结束 / 生命期超时 / 预算或取消）都产出结构化结果，调用方不用猜。
4. **移交即清零时限**：`timeout_ms` 的语义是「调用方愿意等多久」，调用方已经不等了。早期保留时限时，
   默认配置下的窗口只有 15 秒（45s 软期限 vs 60s 默认时限）——调用方收到「没被杀」的承诺，15 秒后进程被销毁、输出为空。
   现在移交把生命期设为 0，命令跑到自然结束；停止只由 `job_kill` / server 退出触发。

作业输出复用 `launch()` 的输出通道（内存留头部、spill 留全文）；注册表只保留最近 `MAX_RETAINED_JOBS = 32` 条已完成记录；
server 退出时 `killAllJobs()`，不留孤儿 bash 树。

### 5.11 前台预算 45s：把「客户端超时」变成非事件

实测（本机 DSH + 官方 SDK 客户端）：任何超过 **~60 秒**的 `exec` 调用都会以 `MCP error -32001: Request timed out`
告终，**`timeout_ms` 完全不生效**——那道超时属于客户端，server 改不了。

因此 server 不假装能端到端尊重一个 10 分钟的 `timeout_ms`，而是自设软期限：`FOREGROUND_MS = 45000`，
留出 15s 余量（进程启动 + 结果序列化 + 传输），保证本 server 的 JSON 总是**先**到。更长的等待走
`run_in_background: true` 或 `job_output {wait: true}`——它们的等待发生在「已经返回过的请求」之外。
软期限只约束**这次调用等多久**，不继承成进程生命期：到点移交时 `timeout_ms` 归零（§5.10.4）。

### 5.12 `policy` 只回一行

早期每次结果都带完整 `policy` 对象（`decision`/`tier`/`stance`/`reason`/`matched_rules[]`），长会话里是纯上下文开销。
现在 `exec` 只回一行：`"allow"` 或 `"allow-risky (dangerous, stance=allow, see the policy tool)"`，明细按需走 `policy` 工具；
被拦住时仍返回完整 `category`/`reason`/`matched_rules`，因为那条路径要能向用户解释清楚。

### 5.13 默认 `MSYS_NO_PATHCONV=1`

MSYS2 会把看起来像 unix 路径的**参数**改写成 Windows 路径再交给原生程序：`--entrypoint /bin/sh` 实测变成
`exec: "C:/…/usr/bin/sh": no such file or directory`。转换只对原生程序生效，所以默认关掉它利大于弊；
恢复旧行为：`env: {"MSYS_NO_PATHCONV": ""}`（空值 = 删除变量）。附带影响见 §5.15。

### 5.14 省略 `cwd` 时用客户端的 workspace root

stdio server 的进程 cwd 是「客户端恰好从哪儿拉起它」（实测就是 DSH 的安装目录），作为默认工作目录毫无意义。
所以省略 `cwd` 时先问客户端要 roots（MCP 标准 `roots/list`，2s 超时、结果缓存），取第一个存在的 root；
客户端不实现 roots 就退回进程 cwd，行为与旧版一致。

### 5.15 `//x` 转义的迁移（默认关闭路径转换的代价）

MSYS 的 `//x` 转义（`//c` 表示字面量 `/c`）只在转换**开启**时才有意义。实测：

| 写法 | 转换开启（旧） | 转换关闭（默认） |
|---|---|---|
| `cmd /c …` | ✗ 被改写成 `C:/` | ✓ |
| `cmd //c …` | ✓ | ✗ **静默挂死**（cmd 打印 banner 后等 stdin） |
| `tasklist //FI …` | ✓ | ✗ 报「无效参数」（响亮失败） |

两种写法在一个全局 env 下无法共存（实测 `MSYS2_ARG_CONV_EXCL` 只支持**参数前缀**，`node:/bin` 无效，
做不到「只对 docker 关转换」）。选择默认关闭，并对**唯一会挂死**的形态前置拒绝：

- cmd 家族 + 转义在开关位（第一个参数）→ `error_code: PATHCONV_ESCAPE`，附正确写法与逃生口，**不执行**；
- 其它程序 + 同形态 → 结果里多一行 `warnings`（它们会自己报错，不必拦）；
- 数据位（`cmd /c echo //c`）与 `//server/share`（UNC）不误报；
- 逃生口 `env {"MSYS_NO_PATHCONV": ""}` 恢复转换，此时走反向规则（`cmd /c` 被拒绝、`cmd //c` 可用）。

### 5.16 完成判定跟着 shell 走，不跟着管道走

`close` 事件只在**进程退出且 stdio 全部关闭**后才触发，于是「命令跑完了」被定义成「没人再持有输出管道」。
实测：`sleep 20 & echo A-DONE` 花 20130ms，`sleep 20 >/dev/null 2>&1 & echo B-DONE` 只花 126ms——两者做的是同一件事，
唯一差别是子进程是否继承 stdout。后果是启动常驻进程 / GUI（`cmd /c start "" …`）会等到超时并**被杀树连坐**，
后台作业的 `still_running` 也会在残留子进程活着期间永远为 true。

现在完成信号取**直接子进程退出**（`child.on('exit')`），管道只多等 `EXIT_DRAIN_MS = 250ms` 让缓冲字节落地，
到点 `channel.stop()`：摘掉数据监听并 `resume()`，让残留写入者继续排空而不是被我们阻塞。
正常命令走「两条流先结束」的快路径，不增加延迟（实测普通 `echo` 仍 ~84ms）。代价：shell 退出后残留进程写出的内容不再被收集。

## 6. 分发与配置

发布：`npm pack --dry-run` 只应包含源码 —— `bin/`、`lib/`、`server.js`、`package.json`、`README.md`、`LICENSE`
（当前 14 个文件、打包约 42KB），不含 `docs/` 与测试文件。

配置：`gitbash-mcp init` 交互式写入各客户端配置（见 §4.6）；也可手动把命令写成 `gitbash-mcp`、参数留空。
DSH 也可用面板插件注册。

## 7. 被否方案（留档）

| 方案 | 否因 |
|---|---|
| 沙箱内跑 bash（含经 pwsh 调 bash） | MSYS2 signal pipe 被 WRITE_RESTRICTED 掐死（实测） |
| 纯 skill 包裹 | skill 不能部署程序 |
| 原生 executor 插件 | 需改 DSH 仓库并替换默认 shell 栈，侵入大 |
| 单文件 exe（bun compile / Node SEA） | 内嵌运行时 80~110MB；UPX 破坏 Bun 产物且提高杀软误报 |
| npx / bunx 安装 | Windows 上 stdio 拉起 npx 包装层不稳定 |
| 手写 stdio JSON-RPC（零依赖） | 可降到 ~20KB，但需自维协议层；当前保留官方 SDK（零风险） |
| **照抄宿主（DSH）的后台作业机制** | 宿主是那批子进程的 owner，而且它自己就是客户端；MCP server 是独立进程，架构不同。server 自建注册表 + 自暴露 `job_*` 工具即可，不需要宿主配合（§5.10） |
| 让 `timeout_ms` 端到端生效（>60s 的前台调用） | 那道超时在客户端进程里，server 无法覆盖；改为自设 45s 软期限 + 移交后台（§5.11） |
| 只对 docker/kubectl 等程序关闭路径转换 | MSYS 只提供全局开关与**参数前缀**级的 `MSYS2_ARG_CONV_EXCL`（实测 `node:/bin` 无效），做不到程序级作用域（§5.15） |
| 把 `//c` 自动改写为 `/c` 后照跑 | 需要按原样重写用户命令，涉及引号/转义保真（解析器只给出去引号后的词，没有原文 span）；宁可前置拒绝并给出改法，也不做可能改坏命令的魔法 |

## 8. 测试策略

五套测试每套一个关注面，逐套覆盖清单见 `docs/REPO_MAP.md` §8。要点：

- `test-client.mjs` 走真实 MCP 协议，钉住结果契约：超时/移交/取消、后台作业全流程、完成判定、路径转换、spill、缺 bash 降级、策略。
- `test-runner.mjs` 单测执行原语：环境、封顶、通道 tail/offset、并发、杀树、**完成判定**、**时限归零**、作业生命周期、审计。
- `test-policy.mjs` 单测解析与裁决（含历次反馈的回归用例）；`test-menu.mjs` 纯函数；`test-cli.mjs` 在临时 root 里跑 CLI。

> 五套都会 spawn bash.exe 并使用管道，必须在正常 shell 中运行；审计写入用临时 `LOCALAPPDATA`，不污染真实日志。
> 回归修复的规矩：先加一条会失败的用例，再改代码。

## 9. 变更纪律

- §4 结果契约与 §5.1 启动永不失败是红线。
- §5.10 的三条不变量是红线：**后台句柄毫秒级返回**、**取消/预算到点不杀进程而是移交**、
  **停止必须是显式动作**（只认 `timeout_ms` 到点与 `job_kill`）。
- 日志只走 stderr（stdout 是协议通道）。
- 文档与代码同一次提交内同步。