# gitbash-mcp

把 **git-bash (MSYS2)** 交给 AI agent 用的 MCP server（DSH / Claude Code / Codex / Cursor / VS Code / Claude Desktop）。
它在 agent 沙箱**之外**运行：管道、`$(...)`、子进程、Docker 全部可用；长任务可以转成后台作业。

- 工具：`exec`、`job_output`、`job_list`、`job_kill`、`bash_info`、`doctor`、`policy`
- 运行时 Node >= 18（兼容 Bun）；协议 MCP stdio；只支持全局安装

## 简介

Windows 上 agent 沙箱用受限令牌跑命令，MSYS2 在这种令牌下起不来（建不了 signal pipe），捕获子进程输出也会失败；
Docker 需要的命名管道同样打不开。**所以 git-bash 只能跑在沙箱外**——这就是本 server 存在的理由：
作为一个独立进程常驻，把「沙箱外的完整 shell」交给 agent。

它顺带解决三件长会话里最容易出事的事：

1. **长任务不会被客户端超时打断**：前台最多等 45 秒，到点把命令**移交**成后台作业继续跑，返回句柄而不是杀掉进程。
2. **任何超时/取消都不丢成果**：命令的结局只由它自己和显式参数决定，停止永远是显式动作（`job_kill`）。
3. **面向 Windows 原生程序**：默认关掉 MSYS 的路径改写，`docker run --entrypoint /bin/sh` 这类参数原样送达。

## 部署

~~~powershell
npm i -g gitbash-mcp
gitbash-mcp init          # 交互式勾选客户端；--yes 免交互，--dry-run 只预览
gitbash-mcp uninstall     # 反向移除，只删自己的条目
~~~

`init` 写入**绝对路径**（`node <...>/bin/gitbash-mcp.js`），因为 npm / bun 的 shim 目录常常不在 GUI 客户端的 PATH 上。
写入前会备份 `*.bak`，重复运行幂等。**配置完重启对应客户端。**

| 客户端 | 写入位置 | 格式 |
|---|---|---|
| DSH | `$DSH_HOME/cordis.patch.yml` | YAML insert |
| Claude Code | `~/.claude.json` | `mcpServers` |
| Codex CLI | `~/.codex/config.toml` | `[mcp_servers.gitbash]` |
| Claude Desktop | `%APPDATA%/Claude/claude_desktop_config.json` | `mcpServers` |
| Cursor | `~/.cursor/mcp.json` | `mcpServers` |
| VS Code | `<cwd>/.vscode/mcp.json` | `servers` |

只支持全局安装，不支持 npx / bunx（多一层包装，在 Windows 上以 stdio 启动不稳定）。
bash 找不到时服务照常启动：`exec` 返回修复指引，`doctor` 给完整诊断。

## 使用

### `exec`

| 参数 | 说明 |
|---|---|
| `command` | 必填，bash 命令或多行脚本 |
| `cwd` | 工作目录；省略时用客户端声明的 workspace root |
| `timeout_ms` | 进程生命期：前台默认 60000，后台默认不限 |
| `login` | `bash -lc`（读 profile） |
| `env` | 追加环境变量；值为 `""` 表示删除该变量 |
| `run_in_background` | `true` = 转后台作业，立刻返回 `job_id` |

返回 JSON，常用字段：

| 字段 | 含义 |
|---|---|
| `exit_code` | 退出码；被杀为 `-1`；已移交后台为 `null` |
| `stdout` / `stderr` | 单流最多 64KB，超出部分转存到 `spill_path` |
| `timed_out` / `still_running` | 前台是否没等到结束 / 命令是否还活着（还活着就用 `job_id` 取回） |
| `killed_by` | `timeout`（生命期到点）/ `kill`（`job_kill`）/ `null` |
| `duration_ms` / `queued_ms` | 实际耗时 / 因并发上限排队的时间 |
| `audit_id` / `policy` / `hint` | 审计 id / 一行裁决 / 下一步建议 |

命令失败（非零退出、超时、spawn 失败）同样是这个结构，不抛工具错误。每次调用都是新进程，状态不保留。

### 长任务与后台作业

前台调用最多等 45 秒；超过时命令**不会被杀**，而是转成后台作业继续跑并返回 `job_id`：

| 工具 | 作用 |
|---|---|
| `exec {run_in_background: true}` | 毫秒级返回 `job_id`，命令不绑定在发起它的请求上 |
| `job_output {job_id, wait?, timeout_ms?, offset_bytes?}` | 默认返回状态 + 每条流尾部 64KB；`wait: true` 阻塞到结束；`offset_bytes` 读增量 |
| `job_list` | 列出作业、状态、退出码 |
| `job_kill {job_id}` | 显式停止（杀整棵树） |

典型流程：

~~~text
exec        { command: "docker pull postgres:17.9", run_in_background: true }   -> job-xxxx
job_output  { job_id: "job-xxxx", wait: true, timeout_ms: 30000 }               # 等到结束，收退出码
job_output  { job_id: "job-xxxx", offset_bytes: 65536 }                         # 接着上次的字节偏移读增量
job_kill    { job_id: "job-xxxx" }                                             # 显式停止
~~~

作业活在 server 进程内：重启客户端会丢句柄，但审计日志记了作业的起止、退出码与输出文件路径，结果还能从盘上捞回。
需要跨重启的可靠后台执行，请用 `schtasks` 或系统服务。

### 其他工具

- `bash_info` — bash 路径与 bash/git 版本
- `doctor` — 完整环境诊断；bash 行为异常先调它
- `policy` — 当前姿态与完整规则；被拦住后调它才能向用户解释清楚

### 命令策略

不是黑名单，是**能力分类**：命令逐段判定，只有每段都可读、或由项目自己声明、且没有不可判读构造时才自动放行。
唯一开关 `GITBASH_MCP_RISKY` 写在 MCP 客户端配置里（模型改不了，改完要重启服务器）。

| 判定 | 默认 `ask` | `allow` |
|---|---|---|
| read-only / project | 放行 | 放行 |
| mutating / unknown / opaque | 拦住，让你决定 | 放行 + 审计 |
| catastrophic | 拒绝 | 放行 + 审计 |

被拦住时模型会拿到三条路：① 你自己在终端跑 ② 换更安全的写法 ③ 配置 `GITBASH_MCP_RISKY=allow` 并重启。

## 思路

**为什么不做成 skill 或插件。** skill 不能部署程序，原生 executor 插件要改客户端仓库并替换默认 shell 栈；
一个全局安装的小 server 最省事，也不必内嵌运行时（单文件 exe 要多背 100MB）。

**为什么沙箱外是刚需。** 受限令牌下 MSYS2 连启动都做不到，这不是调用方式的问题，只能换进程。

**同一台机器上有三条不同的路**，结论会不一致，判断时要注意：

| 环境 | 文件沙箱 | 命名管道 | 网络路径 |
|---|---|---|---|
| git-bash 桥（本 server） | 沙箱**外**，可写任意路径 | 可访问 | 走宿主网络 |
| 宿主沙箱内的 shell | 受限 | 打不开 | 走宿主网络 |
| Docker daemon | — | — | 独立代理配置 |

例如 `docker manifest inspect`（客户端直连）与 `docker pull`（daemon 侧）会给出矛盾的答案——前者失败只能说明**客户端**连不上。

**为什么有 45 秒这条线。** MCP 客户端自己有请求超时（官方 SDK 默认 60 秒），到点会取消请求。server 改不了那道超时，
所以自设更短的软期限：先返回结构化结果，把没跑完的命令**移交**给作业注册表。移交同时清零继承的进程生命期——
`timeout_ms` 的含义是「调用方愿意等多久」，调用方不等了，它就不该继续倒计时。

**为什么「完成」看 shell 而不是看管道。** 命令派生出的常驻进程（`start`、`&`、daemon）会一直持有输出管道；
若以管道关闭为准，启动一个 GUI 或后台服务就会被判成「还没跑完」，最后挨一次超时连坐杀树。现在 shell 退出即完成，
残留进程之后写的内容不再收集——这是刻意的取舍。

**为什么默认关掉 MSYS 路径转换。** 它会把 `/bin/sh` 这类参数改写成 Windows 路径，原生程序收到就报错。
代价是 MSYS 的 `//x` 转义同时失效，所以写 `cmd /c …` 而不是 `cmd //c …`（后者会挂住，工具会直接拒绝并提示）。
需要旧行为时单次传 `env: {"MSYS_NO_PATHCONV": ""}`。

**安全边界。** 本进程在沙箱外运行，权限 = 启动它的 agent 进程的完整用户权限，没有文件沙箱。
命令策略、并发上限、输出封顶、环境洗白、审计日志都是「降低误伤」的护栏，**不是安全边界**；
真正的隔离只能在 OS 层做（低权限账户 / 容器 / VM）。

## 相关文档

- `docs/DESIGN.md` — 完整契约、决策记录与被否方案
- `docs/REPO_MAP.md` — 代码地图
- `docs/PLAN.md` — 里程碑与风险登记
- `AGENTS.md` — 维护者须知
