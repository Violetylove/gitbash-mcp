# gitbash-mcp 设计书

## 1. 产品范围

gitbash-mcp 为 Windows 上的 AI 客户端提供可用的 Git Bash 执行能力。MCP server 通过 stdio 接收请求，在独立 Bash 进程中执行命令，返回结构化结果并管理长任务。

运行环境为 Node >= 18，纯 JavaScript ESM，兼容 Bun；通过 npm 全局安装，无构建步骤。项目目标、历史进度、弹窗开发要求与验收标准见 [PROGRESS.md](PROGRESS.md)。

本进程在沙箱外运行，权限等于启动它的 agent 进程的完整用户权限；无文件沙箱。命令分类、审批、环境洗白、资源上限和审计用于减少误操作，不构成 OS 安全隔离。

## 2. 模块架构

lib/ 按模块分成 mcp、execution、policy、approval、jobs、environment、audit、cli。审批状态与桌面窗口由 approval 模块管理，跨模块依赖使用明确的相对路径。

~~~text
MCP 客户端 → bin/gitbash-mcp.js → server.js
                                  ├─ lib/mcp/server.js：会话组装
                                  ├─ lib/mcp/tools/*：工具定义、参数校验、MCP 响应
                                  ├─ lib/mcp/workspace.js：默认工作目录
                                  └─ lib/execution/service.js：命令执行流程
                                       ├─ lib/policy/authorization.js → lib/policy/index.js → lib/policy/shell-parse.js
                                       ├─ lib/approval/service.js → windows.js → windows.ps1
                                       ├─ lib/environment/detect.js：Bash 探测
                                       ├─ lib/execution/runner.js：执行句柄、输出、时限、并发
                                       ├─ lib/jobs/registry.js：后台启动与前台移交
                                       └─ lib/audit/index.js：审计
作业工具 → lib/jobs/service.js → lib/jobs/registry.js
诊断工具 → lib/environment/diagnostics.js / lib/environment/detect.js / lib/policy/index.js
CLI      → lib/cli/index.js → detect / audit / policy / menu / theme
~~~

- `server.js` 只组装服务、注册工具、连接 stdio 和安装退出清理。
- `lib/mcp/tools/` 负责协议适配，不做风险判定或进程管理。
- `lib/mcp/responses.js` 负责 MCP content 格式，`lib/execution/results.js` 只定义业务结果；业务模块不依赖 mcp 目录。
- `execution/service.js` 返回普通对象，负责执行顺序、排队、移交和调用审计；每个服务实例拥有独立的前台并发闸门。
- `execution/preflight.js` 校验工作目录并构造 INVALID_CWD 结果，执行服务在受理和启动前复用该检查。
- `policy/authorization.js` 将策略裁决转换为允许或拒绝执行的结果，作为执行授权接口。
- `policy/index.js`、`policy/shell-parse.js` 保留能力分类与解析职责；`execution/runner.js` 保留唯一进程启动原语 `launch()`。
- `jobs/registry.js` 拥有当前进程的作业注册表，`jobs/service.js` 提供查询、等待和停止操作。

## 3. 命令执行流程

1. 校验非空命令，分配审计 id，解析工作目录。
2. 分类并裁决命令；deny 直接拒绝，ask-required 标记为需要审批。
3. 校验工作目录、惰性探测 Bash、检查路径转换写法；无法执行时返回错误和修复指引，不创建审批。批准后及前台排队结束时重新检查工作目录。
4. 需要审批时等待本机人类决定；授权完成后，后台请求立即启动并注册作业，前台请求通过 FIFO 并发闸门执行。
5. 前台自然结束时返回结果；等待预算到点或请求取消时，将同一执行句柄交给作业注册表。

`command` 始终作为单个 argv 传给 `bash -c` 或 `bash -lc`，不改写命令，不增加引号转义层。每次执行新建 Bash 进程，状态不跨请求保留。

工作目录优先使用显式 `cwd`，否则查询客户端 `roots/list`，选择第一个存在的 file URI 路径；查询结果按会话缓存。查询失败或无可用 root 时使用 server 进程 cwd，查询有有界等待。

## 4. MCP 工具契约

### 4.1 exec

| 参数 | 约束与含义 |
|---|---|
| `command` | 必填、非空字符串；命令或多行 Bash 脚本 |
| `cwd` | 可选 Windows 工作目录 |
| `timeout_ms` | 可选整数，1000–600000；前台默认 60000，后台省略时无限 |
| `login` | 可选布尔值；true 使用 `bash -lc` |
| `run_in_background` | 可选布尔值；true 在授权完成后立即返回作业句柄 |

不提供 `env` 参数：策略只判读命令文本，独立的环境映射能让只读程序执行任意代码（`GIT_PAGER`、`GIT_CONFIG_*`、`BASH_ENV`）。环境变量写在命令里，由策略判读。

前台结果字段：`exit_code`、`stdout`、`stderr`、`timed_out`、`still_running`、`truncated`、`spill_path`、`spill_bytes`、`spill_truncated`、`duration_ms`、`killed_by`、`timeout_ms`、`queued_ms`、`audit_id`、`policy`。按路径附加 `hint`、`warnings`、`error_code`、`job_id`、`pid` 或拒绝原因。

`exit_code` 为正常退出码；启动失败或被杀时为 -1，已移交时为 null。`still_running` 表示命令仍在运行。等待预算耗尽可同时返回 `timed_out: true` 和 `still_running: true`；请求取消移交返回 `timed_out: false`。`killed_by` 区分生命期超时和显式停止。

策略拦截返回基础执行字段、`error_code`、`category`、`reason`、`matched_rules`、`hint`、`audit_id`。缺 Bash 返回 `BASH_NOT_FOUND`、修复指引及审计 id。`policy`、`warnings` 的返回位置遵循对应执行分支，调用方不能假设可选字段总是存在。

后台启动返回：`job_id`、`status`、`still_running`、`pid`、`started_at`、`timeout_ms`、`queued_ms`、`command`、`cwd`、`audit_id`、`policy`、`hint`，有路径转换警告时附加 `warnings`。

命令非零退出、启动失败和超时返回 JSON；参数不合法才作为 MCP 工具错误处理。

| error_code | 含义 |
|---|---|
| `APPROVAL_DETACHED` | 原调用等待已中断，审批或执行记录仍可查询 |
| `APPROVAL_REJECTED` | 人类拒绝本次命令，未执行 |
| `APPROVAL_CANCELLED` | 关闭窗口或显式撤销本次审批，未执行 |
| `POLICY_DENIED` | 当前姿态拒绝执行，命令未启动 |
| `BASH_NOT_FOUND` | 无可用 Bash 路径 |
| `INVALID_CWD` | 工作目录不存在、不是目录或无法访问；返回 cwd 与修复提示，命令未启动 |
| `PATHCONV_ESCAPE` | cmd 开关写法与路径转换状态不匹配 |
| `EXEC_QUEUE_TIMEOUT` | 排队已耗尽本次等待预算，命令未启动 |
| `TOO_MANY_JOBS` | 显式后台作业达到上限，命令未启动 |
| `TOO_MANY_APPROVALS` | 待审批请求达到上限，命令未启动 |
| `APPROVAL_TOO_LARGE` | 单条请求的 JSON 快照超过 128 KiB（UTF-8 字节数），未创建审批 |
| `APPROVAL_EXECUTION_FAILED` | 批准后执行流程抛错，命令可能未启动 |
| `SERVER_CLOSED` | server 会话已结束，命令未启动 |
| `APPROVAL_UI_UNAVAILABLE` | 窗口无法启动或故障，命令未启动 |

### 4.2 作业工具

| 工具 | 参数与行为 |
|---|---|
| `job_output` | `job_id`；可选 `wait`、`timeout_ms`、`offset_bytes`、`tail_bytes`。默认非阻塞，返回每条流尾部最多 64KB |
| `job_list` | 列出本 server 的后台启动作业及前台移交作业，返回摘要 |
| `job_kill` | `job_id`；停止整棵进程树并返回摘要 |

`job_output` 等待默认 30000ms，上限 50000ms。`offset_bytes` 是 stdout 字节游标；返回的 `next_offset` 用于下次增量查询，stderr 始终返回尾部。

作业结果字段：`job_id`、`status`、`still_running`、`mode`、`command`、`cwd`、`pid`、`started_at`、`ended_at`、`duration_ms`、`exit_code`、`timed_out`、`killed_by`、`timeout_ms`、`audit_id`、`policy`、`stdout`、`stderr`、`stdout_offset`、`stderr_offset`、`next_offset`、`stdout_bytes`、`stderr_bytes`、`log_path`、`log_truncated`。摘要省略输出正文及游标。

`status` 为 running / exited / killed / timeout。未知作业返回 `JOB_NOT_FOUND`。注册表只在当前 server 进程内有效；退出或重启后句柄失效。审计日志记录作业起止与可用输出文件路径；只有写入 spill 的输出可从文件恢复。

### 4.3 诊断工具与服务指引

`bash_info` 返回 Bash 路径、Bash/Git 版本及环境信息；`doctor` 返回运行时、候选扫描、探测来源、探测变量有效性、Git 路径、审计路径和修复步骤；`policy` 返回当前风险姿态与完整规则。

server 的 initialize `instructions` 和 `exec` 描述说明：在 Windows 上优先使用本工具执行 shell / Git / 构建脚本；长任务使用后台作业；Windows 原生 cmdlet、COM 和 .NET 操作使用原生工具。日志只写 stderr，stdout 专用于 MCP。

## 5. 进程与资源管理

### 5.1 执行生命期

| 项目 | 当前值 / 行为 |
|---|---|
| 前台生命期默认值 | 60000ms，从启动进程开始计时 |
| 可设置生命期上限 | 600000ms |
| 前台等待预算 | 最多 45000ms，排队计入等待预算 |
| 排队余量下限 | 剩余不超过 250ms 时不启动 |
| 等待作业上限 | 50000ms |
| 杀树结算宽限 | 1500ms |
| shell 退出后的输出排水 | 最多 250ms |

授权完成后的后台启动必须迅速返回 `job_id`，生命期与发起请求分离。前台取消和预算到点必须移交同一执行句柄，解除请求信号并清零继承的生命期。停止运行中的命令树由等待期内生命期到点、`job_kill` 或 server 退出触发。

完成判定以直接子进程 shell 的 exit 为准，不等待所有后代关闭 stdio。两条输出流先结束时直接结算，否则在排水窗口后停止采集；shell 退出后残留进程的新输出不再收集。

### 5.2 并发与输出

前台最多同时运行 4 条命令，超出后 FIFO 排队；显式后台启动最多同时运行 8 条，不占前台名额且 `queued_ms` 为 0。前台移交作业的 mode 为 foreground，不计入显式后台启动上限；8 不是所有运行进程的总上限。已完成作业按注册表容量 32 清理，运行中记录不删除。

输出采用 UTF-8，每条流内存保留头部最多 64KB。超出后转存到临时 spill 文件，每条流文件最多 64MB。作业查询可读取尾部或字节偏移。输出文件在临时目录 `gitbash-mcp` 下，按 24 小时清理期限处理；写入完成有有界兜底。

## 6. 环境、检测与命令策略

### 6.1 环境与检测

继承环境先清除凭据形状变量，保留 `SSH_AUTH_SOCK`；默认注入 `GIT_PAGER=cat`、`NO_COLOR=1`、`MSYS_NO_PATHCONV=1`。

Bash 按 `GITBASH_BASH` 指定路径、PATH、常见 Git/MSYS2/Cygwin 安装位置依次寻找现存文件。指定路径无效时诊断标明无效，仍可回退到其他候选。探测惰性执行并缓存；doctor 强制刷新；服务启动不依赖 Bash 存在。

路径转换默认关闭。`cmd /c` 使用正常开关；关闭转换时 cmd 首参数为 `//c` 等转义开关会前置拒绝，其它程序的同类写法返回警告；数据参数和 UNC 路径不误报。MSYS 只看变量是否存在，空值不能恢复转换：`env -u MSYS_NO_PATHCONV prog` 为单个程序恢复，`unset MSYS_NO_PATHCONV` 为本行其后命令恢复，再赋值则重新关闭；检查按每段的转换状态进行。

### 6.2 当前策略

解析器按命令结构分段，识别引号、shell 关键字、重定向与 here-doc。fd 复用、关闭和 `/dev/null` 不视为文件写入。命令替换、动态程序名、子 shell 等不可可靠判断的结构归为 opaque。改变环境的写法同样归为 opaque：`VAR=x prog`、单独赋值（可能改写已导出变量）、带操作数的 `export`、`env VAR=x` / `env -S`、`declare -x` 及带值的 declare、`set -a`、`read` 大写变量、`printf -v`。`MSYS_NO_PATHCONV` 只影响参数改写，豁免；`env -u` 只删变量，不算。opaque 不压低更严重的裁决（`X=1 rm -rf /` 仍为 catastrophic）。

策略分类为 read-only、project、ask-required、dangerous、catastrophic。项目入口依据向上最多 6 层的 package.json scripts、Makefile targets、justfile recipes 识别；这是对项目声明的信任，不代表对其内部脚本逐条证明安全。

`GITBASH_MCP_RISKY` 是当前风险姿态开关，由客户端启动配置提供：默认 ask 自动放行只读和项目入口，其他命令要求人类决定，catastrophic 拒绝；allow 放行并标注风险裁决。命令里设置的变量不改变服务自身的姿态。

ask-required 命令在预检通过后创建单次审批；deny 不弹窗，allow / allow-risky 按原有姿态直接执行。策略不是对蓄意绕过的安全防护。

### 6.3 审计

审计使用本机状态目录下的 JSONL 文件，记录调用、策略拦截、前台完成、后台启动、移交及作业结束。日志到 5MB 后轮转为一个备份文件。审计写入失败仅报告 stderr，不打断执行。作业超限当前直接返回错误；不把未落盘的分支描述为已审计。

## 7. CLI 与分发

`bin/gitbash-mcp.js` 无参启动 server；init / uninstall / doctor / audit / policy / help / version 分派到 CLI。仅支持 npm 全局安装，发布白名单为 bin/、lib/、server.js、package.json、README.md、LICENSE。

init 支持 DSH、Claude Code、Codex CLI、Claude Desktop、Cursor、VS Code 六个固定客户端；通过 `init --dry-run` 查看目标配置路径与写入内容。检测依据配置路径或对应可执行文件；未检测的客户端仍可选择。

菜单使用纯 reducer 管理按键，渲染与终端交互分开；非 TTY 或 `--no-tui` 使用编号输入。支持 `--dry-run`、`--target`、`--yes`、`--runtime` 和测试用 `--root`。

写入前备份。JSON 按键合并并重写，TOML/YAML 仅替换本项目所属段落；重复执行幂等。init 写入运行时及入口的绝对路径，配置后需重启客户端。uninstall 只移除本项目配置。

## 8. 人类确认审批

### 8.1 状态与执行

审批不设超时。需要审批时 exec 保持原工具调用等待，不提前返回待审批句柄。批准后走原执行路径，返回执行结果并附带 approval_id；长任务仍可移交并返回 job_id。拒绝、关闭窗口、显式取消或窗口故障时，向原调用返回基础执行结果、approval_id 和对应错误，不启动命令。无需客户端轮询审批，不新增 approval_wait 或自定义通知。待审批最多 32 条，已结束审批最多保留 64 条；待审批记录不因清理而失效。

各请求独立执行并向对应的 exec 返回结果，不等待其他请求完成。窗口仅管理待审批请求，最后一条处理后立即关闭，不等待已批准的命令执行结束。

状态流为 pending_approval → executing → completed；拒绝、客户端显式取消、窗口关闭、窗口故障、server 退出分别进入 rejected / cancelled / failed 等终态。终态不可再次批准。审批等待不占执行并发、不计入前台等待预算或 timeout_ms。批准后才开始排队和执行计时，前台执行沿用原 MCP 请求 signal，取消时移交同一进程句柄；显式后台请求仍遵守后台作业上限。completed 表示审批执行已返回结果，结果可能包含仍在运行的 job_id；命令非零退出仍通过 result.exit_code 表达。

创建时固定 command、cwd、login、timeout_ms、run_in_background 和审计 id；显式后台请求在创建审批前和批准后各检查一次作业上限。单条请求的窗口 JSON 快照按 UTF-8 字节数限制为 128 KiB，超出时返回 APPROVAL_TOO_LARGE，不创建记录。整个窗口快照上限为 4 MiB，包含 JSON 封装。已结束记录按结束先后清理。审批页不允许改写请求；执行前重新检查 Bash 与路径转换，沿用创建时的授权裁决，命令仅可启动一次。取消审批只适用于 pending_approval；已经执行时通过 job_kill 停止已取得句柄的作业。

### 8.2 客户端工具

新增 `approval_list`、`approval_status {approval_id}`、`approval_cancel {approval_id}`。status 非阻塞返回状态、风险原因及可用执行结果；list 返回摘要，cancel 只撤销待审批请求。未知句柄返回 APPROVAL_NOT_FOUND；超限返回 TOO_MANY_APPROVALS；窗口不可用返回 APPROVAL_UI_UNAVAILABLE。不提供客户端批准工具或批准参数。

客户端请求超时或取消信号仅解除原调用的等待，不撤销已受理的审批。若响应通道仍可用，返回 APPROVAL_DETACHED 和 approval_id；客户端已关闭调用时不能保证收到此响应，可用 approval_list 找回，再用 approval_status 查询。批准发生在请求中断之后时，前台执行通过已取消信号立即移交作业，清零继承时限。未发送取消信号的客户端超时无法由服务器自行识别。查询工具作为中断后的恢复入口，不要求正常审批流程调用。客户端断开或 server 退出清理所有待审批和窗口，同时停止前台执行句柄及注册作业，阻止退出后启动排队命令；句柄不跨 server 重启保留。审批与普通作业使用独立注册表。

### 8.3 WPF 窗口与通信

每个 MCP server 进程最多一个审批窗口，每次只展示一条请求的命令、执行目录和执行选项（登录 Shell、前台/后台、时限），不展示风险原因或请求列表；人类批准的就是窗口所示的全部执行参数。

内容使用无输入边框的文本卡片，按实际宽度换行，默认最多两行；超过两行时提供独立的展开/收起按钮，展开后可滚动查看完整内容。切换请求恢复折叠，同一请求收到新快照时保持展开状态。底部 `<`、`>` 按钮与当前位置按整个窗口居中，Reject、Approve 按钮位于同一水平行的右侧；使用 Catppuccin Latte 浅色配色，所有按钮统一使用 5px 圆角；到达首尾时禁用对应切换按钮。主标题 Command approvals 与14px、Medium 字重副标题 gitbash-mcp 整体居中，整个顶部区域（包括标题上方留白）可拖动、双击最大化或还原，提供最小化与关闭按钮；按钮点击不触发拖动，最小化保留待审批请求，不显示左下说明。

仅支持允许本次、拒绝本次，不提供批量批准。新请求不抢走当前请求；当前请求移除后展示相邻请求；最后一条待审批请求批准、拒绝或撤销后自动关闭窗口并清理 WPF 子进程，已批准的执行不受影响；有新请求时重新打开窗口。人类主动关闭窗口撤销全部待审批请求并清理 WPF 子进程；MCP 服务继续接收请求。窗口重建后，旧窗口的迟到决策、关闭或故障回调均失效。

Node 使用固定 Windows PowerShell 路径启动随包发布的 WPF 脚本，隐藏控制台，保留可见审批窗口；脚本使用 STA 和固定 XAML。父子进程通过私有 stdin/stdout JSONL 管道传递快照与选择，命令文本只作为数据；输出严格解析和限制长度，诊断走 stderr。窗口只显示和返回选择，不能自行启动 Bash。

WPF 是首选实现；WinForms 为保留的替代方向，首版不自动切换。非 Windows、PowerShell/WPF 不可用、管道断开或窗口崩溃时拒绝所有待审批请求并返回原因，不降级为自动批准。窗口启动与 IPC 故障检测可有期限，但人类审批等待没有期限。

### 8.4 审计与验证

记录审批创建、批准、拒绝、取消、窗口失败、执行完成，并串联原 audit_id、approval_id 和可用 job_id。测试使用注入的窗口适配器模拟人类选择，真实 MCP 工具不提供此入口。验证请求冻结、只执行一次、无审批期限、客户端取消独立、窗口故障、并发列表与清理；WPF 单独验证脚本和真实窗口通信。
