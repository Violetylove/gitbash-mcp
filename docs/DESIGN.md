# gitbash-mcp 设计文档

> 状态：v4（Node 运行时 + 全局安装 + doctor 诊断 + 后台作业与超时契约）。决策记录见 §5、§7。

## 1. 背景与限制（实测）

DSH 的 Windows 沙箱（`@deepseek-ai/dsh-sandbox-windows-acl`）用 **WRITE_RESTRICTED 受限令牌**执行命令
（`packages/sandbox/sandbox-windows-acl/src/token.ts`）。后果：

1. 受限令牌下**新建命名管道失败**：Node `spawn` 默认 `stdio:'pipe'` → `Error: spawn EPERM`。
2. **MSYS2 启动即需创建 signal pipe** → `couldn't create signal pipe, Win32 error 5`，进程起不来。

**沙箱内跑 git-bash 无解**（与调用方式无关）；执行进程必须在沙箱外。

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
  "timeout_ms": 60000,     // 本次实际生效的生命期
  "queued_ms": 0,          // 因并发上限而排队的时间
  "audit_id": "...",       // 该次调用的审计记录 id
  "job_id": "job-...",     // 仅在命令被移交后台时出现
  "policy": "allow",       // 一行裁决：'allow' | 'allow-risky (tier, stance=..., see the policy tool)'
  "hint": "...",           // 超时 / 转后台 / 排队超时 / 缺 bash 时的下一步建议
  "error_code": "APPROVAL_REQUIRED", // 被策略拦住时：APPROVAL_REQUIRED | POLICY_DENIED
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
| `job_output` | `job_id`；`wait?`；`timeout_ms?`（默认 30000，上限 50000）；`offset_bytes?`；`tail_bytes?`（默认/上限 65536） | 默认非阻塞：状态 + 每条流尾部 64KB。`wait: true` 阻塞到作业结束或超时。`offset_bytes` 按**stdout** 字节偏移读增量（`stderr` 始终按尾部返回），响应的 `next_offset` 就是下一次该传的值 |
| `job_list` | — | 本 server 起的作业（后台 + 被移交的前台）与状态、退出码、字节数；`summary` 形式不返回输出正文 |
| `job_kill` | `job_id` | 杀整棵进程树（`taskkill /T /F`），`killed_by: "kill"` |

`job_output` 返回体：`job_id` `status`(`running`/`exited`/`killed`/`timeout`) `still_running` `mode` `command` `cwd` `pid`
`started_at` `ended_at` `duration_ms` `exit_code` `timed_out` `killed_by` `timeout_ms` `audit_id` `policy`
`stdout` `stderr` `stdout_offset` `stderr_offset` `next_offset` `stdout_bytes` `stderr_bytes` `log_path` `log_truncated`。

未知 `job_id` 返回 `error_code: JOB_NOT_FOUND`（结构化结果，不是工具错误）。作业元数据只活在 server 进程内（重启即丢句柄），
但审计日志记了 `job_id` / `command` / `exit_code` / `log_path`，输出文件在 `%TEMP%\gitbash-mcp\`（24h 内可捞）。

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

交互：`lib/menu.js` 的原位勾选菜单（`↑/↓`/`k`/`j` 移动，`空格` 切换，`a`/`n` 全选/全不选，`1-9` 跳转，`回车` 确认，`q`/`Esc`/`Ctrl-C` 取消）；
非 TTY 或 `--no-tui` 时回退为编号输入。

观感：进入终端**备用屏幕**（`\x1b[?1049h`）并隐藏光标，每次按键整帧重绘（`\x1b[H` + 内容 + `\x1b[J`），
用 `◇ ❯ ◻ ◼ ✔ ✖ │ ·` 符号体系与 ANSI 着色（经 `lib/theme.js`，尊重 `NO_COLOR`/`FORCE_COLOR`/`TERM=dumb`），
支持窗口 resize 重绘。按键逻辑是纯函数 `reduceMenu`，帧内容由纯函数 `menuRows`/`renderFrame` 生成，均由 `test/test-menu.mjs` 单测覆盖。

写入语义（重要）：JSON 类目标是**按键合并后整文件重写**（2 空格缩进，已有键保留但格式被规范化）；
TOML/YAML 类是**先删除我们自己的段/块，再追加到文件末尾**。两类写入前都备份 `*.bak`，且重复运行幂等。

探测：`configPath` 与 `detected` 都是实时计算的 —— 目标是**配置文件/目录存在**，或 **PATH 上存在对应可执行文件**
（`claude`、`codex`、`cursor`、`code`）。列表按「已探测在前」稳定排序，未探测的标注 `(not detected)` 但仍可选中（用于预配置）。
受支持客户端的**集合是固定的 6 项**：每个客户端的配置格式与位置不同，无法从文件系统推导。

其他开关：`--dry-run` 只预览；`--target a,b` 精确指定；`--yes` 免交互；`--runtime auto|node|bun|name` 决定写入的运行时；`--root DIR` 覆盖配置根（测试用）。
- `uninstall` 反向移除，只删自己的条目，保留用户已有内容。

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

杀完整树后仍给 1.5s（`KILL_GRACE_MS`）有界宽限结算，不等孤儿进程占着的管道——否则 `close` 事件会被拖到孤儿自己退出。

**取消不再杀进程**：MCP 的 `notifications/cancelled`（客户端请求超时和用户按停止都走这条路）被当成「移交」而不是「丢弃」，
见 §5.10。

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
| 生命期到点杀树 | 单条命令的 `timeout_ms` → `taskkill /T /F`；杀掉后给 1.5s 宽限，不等孤儿进程占着的管道 | `KILL_GRACE_MS = 1500` |
| 并发上限 | `createSemaphore` FIFO 排队，结果报 `queued_ms`；排队时间不计入 `timeout_ms`（生命期计时从 spawn 开始） | `MAX_CONCURRENCY = 4` |
| 后台作业上限 | 同时在跑的后台作业数 | `MAX_BACKGROUND_JOBS = 8` |
| 输出封顶 | 内存 64KB + spill 文件封顶 | `OUTPUT_CAP_BYTES = 64KB`、`SPILL_CAP_BYTES = 64MB` |
| 环境洗白 | spawn 前清掉凭据形状变量（`*_TOKEN`/`*_API_KEY`/`AWS_*`/`*PASSWORD*`），保留 `SSH_AUTH_SOCK` | — |
| 审计 | 每次调用追加 JSONL，`gitbash-mcp audit` 读取；作业另记 start/finish 两行（含 `log_path`） | — |

> 关键教训（实测）：`taskkill /T /F` 本身有效，但**被杀的 MSYS2 孙进程可能继续持有 stdio 管道**，
> 把 `close` 事件拖到子进程自然结束。因此杀完后必须在有界宽限内直接结算，不能只等 `close`。

这些是"降低误伤"的护栏，**不是安全边界**（分类器再细也挡不住蓄意绕过：`r''m`、`$IFS`、`base64 -d|bash` 等）。真正的隔离只能在 OS 层。

### 5.8 命令策略（P1，单开关，能力分类 / 模型 D）

不做正则黑名单，做**能力分类**（`lib/shell-parse.js` 解析 + `lib/policy.js` 裁决，两者都是纯函数）：

1. **解析** `parseCommand`：去引号与反斜杠转义、按 `&& || ; | & 换行` 切段、记录重定向目标；
   here-doc 正文整体跳过（它是数据不是命令）；`$( )`、反引号、`$'…'`、变量当程序名、`( )` 子 shell、未闭合引号 → 标记 `opaque`。
   **shell 关键字是语法不是程序**：`{`/`}`/`!`/`if`/`then`/`else`/`while`/`do` 只被丢掉后再判定其后的命令
   （`{ rm -rf /; }` 仍必须是 catastrophic），`for`/`case`/`function`/`in`/`done`/`fi` 这类整段没有命令的语法直接跳过。
   重定向按 `n>`/`n>>`/`&>`/`n>&m`/`n>&-` 识别：fd 复用与关闭不算文件写入，`/dev/null` 也不算
   （v2 反馈里 `2>&1` 曾产出 `writes to ` + 一个假程序 `1`）。
2. **逐段判定能力**：`read-only`（内置 ~85 个程序 + 27 个 git 只读子命令）/ `project`（项目自己声明的入口）/ `mutating` / `unknown` / `opaque` / `catastrophic`。
3. **汇总裁决**：`catastrophic` → deny；`opaque`/`mutating`/`unknown` → ask-required；全部 read-only 或 project → allow。

**项目声明的信任**（替代白名单文件）：`projectEntry(cwd)` 向上最多 6 层找 `package.json` scripts、`Makefile` 目标、
`justfile` recipe，并只匹配 `npm run <name>` / `make <target>` / `just <recipe>` 这类形式；项目改了脚本就等于改了自己的白名单，
不引入任何需要人维护的清单文件。

**结构化优先于正则**：`rm -rf`/`-fr`/`--recursive` 靠提取 flag 与目标判定。早期逐行 `^rm` 匹配时，多行脚本
`cd /tmp` 换行 `rm -rf /` 被判成 safe（`^` 少了 `/m`），这个 bug 由 `test/test-policy.mjs` 钉住；here-doc 正文也曾被当成命令
（`cat <<EOF` + `rm -rf /` 误判 catastrophic），修好后正文直接跳过。

`read-only`/`project` → 放行（结果里的 `policy` 是 `"allow"`）；其余默认 `ask-required`（`APPROVAL_REQUIRED`，指引模型去问用户）/
`deny`（`POLICY_DENIED`）；`GITBASH_MCP_RISKY=allow` 时全部放行并标注 `allow-risky`。

**不实现 in-band 批准码**：模型拥有同一个 shell，它能跑任何它能提交的批准命令。唯一不可伪造的同意通道是 MCP 的启动配置。
新增 `policy` 工具输出完整规则与当前姿态，供模型向用户解释。

### 5.9 分发：全局安装，不做 exe
`bin: { gitbash-mcp: bin/gitbash-mcp.js }`，shebang `#!/usr/bin/env node`，用户 `npm i -g gitbash-mcp`。
`bun build --compile` 会内嵌整个 Bun 运行时（实测 108.82MB），全局安装只需用户已有的 Node，
安装体积约 14MB（依赖 13.85MB）。

已核实 `cross-spawn/lib/parse.js`：非 `.exe/.com` 扩展名会经 `cmd.exe /d /s /c` 包装，
因此全局 `.cmd` shim 可直接作为 MCP 客户端的 `command`。

### 5.10 后台作业：为什么必须由 server 自己做，以及取消为什么不再杀进程

MCP server 是**跨调用长期存活的独立进程**（stdio，一个会话一个进程），所以「job 注册表 + 轮询/停止接口」
完全可以在 server 内实现，不需要客户端配合——这一点是本设计的出发点：

1. **`run_in_background: true` 立即返回 `job_id`**。请求毫秒级结束，客户端那 ~60s 的请求超时根本无从触发；
   作业的生命期**不绑定**在发起它的那次请求上（`lib/jobs.js` 的 `startJob` 不接 `signal`）。
2. **取消 = 移交，不是丢弃**。客户端请求超时和用户按「停止」在协议上不可区分（都是 `notifications/cancelled`），
   而「成果消失」是两种误判里更坏的一种：所以 `runWithForegroundBudget` 用 `cancelAction: 'report'`，
   收到取消时把同一个进程句柄 `adopt()` 进注册表继续跑，调用方用 `job_list` 就能找回，要停就显式 `job_kill`。
   代价是「按停止」不再立即断掉命令——这是刻意取舍，用 `job_kill` 换「长任务永不白跑」。
3. **前台预算到点也移交**（§5.11）。三条路径（正常结束 / 生命期超时 / 预算或取消）都产出结构化结果，
   调用方永远不用猜「活儿还在不在」。

作业输出复用 `launch()` 的输出通道：内存留头部 64KB（前台结果要用），spill 文件留全文（作业轮询要 tail/offset）。
作业注册表只保留最近 `MAX_RETAINED_JOBS = 32` 条已完成记录；server 退出时 `killAllJobs()`，不留孤儿 bash 树。

### 5.11 前台预算 45s：把「客户端超时」变成非事件

实测（本机 DSH + 官方 SDK 客户端）：任何超过 **~60 秒**的 `exec` 调用都会以 `MCP error -32001: Request timed out`
告终，**`timeout_ms` 完全不生效**——那道超时属于客户端，server 改不了。

因此 server 不假装能端到端尊重一个 10 分钟的 `timeout_ms`，而是自设软期限：`FOREGROUND_MS = 45000`。
45s 留出 15s 余量（进程启动 + 结果序列化 + 传输），保证本 server 的 JSON 总是**先**到。
调用方要更长的等待就用 `run_in_background: true` 或 `job_output {wait: true}`，两者的等待都发生在
「已经返回过的请求」之外。

### 5.12 `policy` 只回一行

早期每次结果都带完整 `policy` 对象（`decision`/`tier`/`stance`/`reason`/`matched_rules[]`），
长会话里几十次调用 × 二三十行 JSON = 纯上下文开销，而拦截价值为零（`allow` 时尤其）。
现在 `exec` 只回一行字符串：`"allow"` 或 `"allow-risky (dangerous, stance=allow, see the policy tool)"`；
明细按需走 `policy` 工具。被拦住时（`APPROVAL_REQUIRED` / `POLICY_DENIED`）仍返回完整
`category`/`reason`/`matched_rules`，因为那条路径要能向用户解释清楚。

### 5.13 默认 `MSYS_NO_PATHCONV=1`

MSYS2 会把看起来像 unix 路径的**参数**改写成 Windows 路径再交给原生程序：
`docker run --rm --entrypoint /bin/sh …` 实测变成 `exec: "C:/…/usr/bin/sh": no such file or directory`。
MSYS 的路径转换只对原生程序生效、对 bash 内建与 MSYS 程序无效，所以默认关掉它利大于弊。
要恢复旧行为：`env: {"MSYS_NO_PATHCONV": ""}`（空值 = 删除变量，见 §4.1）。

### 5.14 省略 `cwd` 时用客户端的 workspace root

stdio MCP server 的进程 cwd 是「客户端恰好从哪儿拉起它」，实测就是 DSH 的安装目录——作为默认工作目录毫无意义。
所以 `exec` 省略 `cwd` 时先问客户端要 roots（MCP 标准 `roots/list`，2s 超时、结果缓存），
取第一个存在的 root 当默认值；客户端不实现 roots 就退回进程 cwd，行为与旧版一致。

## 6. 分发与配置

发布：`npm pack --dry-run` 只应包含源码 —— `bin/`、`lib/`、`server.js`、`package.json`、`README.md`、`LICENSE`
（当前 14 个文件、打包约 39KB），不含 `docs/` 与测试文件。

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

## 8. 测试策略

`node test/test-client.mjs` 覆盖：工具握手与列举（含三个 job 工具）、`doctor` 报告、回显、**管道**、非零退出码、
**生命期超时整树杀**（`timed_out` + `still_running: false` + `timeout_ms` + hint）、**后台作业全流程**
（立即返回句柄 → 中途轮询到部分输出 → `wait: true` 收退出码 → `offset_bytes` 增量 → `job_list` → `job_kill`）、
**取消 = 移交**（abort 后调用被拒，但作业仍出现在 `job_list` 并能 `job_kill`）、**超 64KB 截断 + spill 全量校验**、
空命令报错、`policy` 一行裁决、**缺 bash 降级**（清洗 env 拉起第二个实例，断言 `BASH_NOT_FOUND` + 修复指引 + doctor 报 NOT FOUND）。

`node test/test-cli.mjs` 覆盖 CLI：help/version/doctor、`--dry-run` 不落盘、init 写入并保留既有内容、备份生成、
**二次 init 幂等**、uninstall 只删自己的条目、`--yes` 选择已检测客户端；全部在临时 root 中进行，不碰真实配置。

`node test/test-runner.mjs` 单测 P0 护栏与执行原语：环境洗白与 `MSYS_NO_PATHCONV` 默认/撤销、
spill 内存与磁盘双重封顶、通道的 tail/offset 读、信号量并发峰值与 `queuedMs`、**取消即杀**（`spawnBash` 的默认语义，用延迟写入的标记文件验证树真死）、
**前台预算到点移交而非杀**、**取消移交而非杀**、后台作业生命周期与审计落盘、审计 JSONL 往返与轮转。

`node test/test-policy.mjs` 覆盖策略：50+ 个档位分类用例（含 `for`/`do`/`done`/`{`/`}` 关键字、`2>&1`、`&>`、
`>/dev/null` 等 v2 反馈的解析回归）、姿态裁决（unset/未知值回退 ask、allow 放行）、报告内容。

> 五套测试都会 spawn bash.exe 并使用管道，必须在正常 shell 中运行。
> 审计写入用临时 `LOCALAPPDATA`，不会污染真实日志。

## 9. 变更纪律

- §4 结果契约与 §5.1 启动永不失败是红线。
- §5.10 的三条不变量是红线：**后台句柄毫秒级返回**、**取消/预算到点不杀进程而是移交**、
  **停止必须是显式动作**（只认 `timeout_ms` 到点与 `job_kill`）。
- 日志只走 stderr（stdout 是协议通道）。
- 文档与代码同一次提交内同步。