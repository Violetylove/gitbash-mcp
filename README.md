# gitbash-mcp

MCP server，把 **git-bash (MSYS2)** 交给 AI agent 用（DSH / Claude Code / Codex / Cursor / VS Code / Claude Desktop）。
它在 agent 的沙箱**之外**运行，所以管道、`$(...)`、子进程全部可用。

- 工具：`exec`、`bash_info`、`doctor`、`policy`
- 运行时：Node >= 18（兼容 Bun）
- 协议：MCP stdio

## 为什么需要它

Windows 上 DSH 的沙箱用 WRITE_RESTRICTED 受限令牌跑命令。MSYS2 启动要建 signal pipe，受限令牌下直接失败
（实测 `couldn't create signal pipe, Win32 error 5`）；捕获子进程输出也会 `EPERM`。
**沙箱内跑 git-bash 无解**，所以这个 MCP 以独立进程活在沙箱外。

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

### `exec`

| 参数 | 必填 | 说明 |
|---|---|---|
| `command` | 是 | bash 命令或多行脚本 |
| `cwd` | | 工作目录（Windows 路径） |
| `timeout_ms` | | 超时毫秒（默认 60000，上限 600000），超时杀整棵进程树 |
| `login` | | `bash -lc`（读 profile） |
| `env` | | 追加环境变量 |

返回统一 JSON：`exit_code` `stdout` `stderr` `timed_out` `truncated` `spill_path` `duration_ms` `killed_by`
`queued_ms` `audit_id`，以及裁决信息 `policy`。**命令失败（非零退出 / 超时 / spawn 失败）也返回这个结构，不抛工具错误。**
完整契约见 `docs/DESIGN.md` §4。

- 输出超 64KB 截断，完整内容转存 `%TEMP%\gitbash-mcp\`，`spill_path` 指向它
- 每次调用都是新进程，状态不保留（用 `cd` 或传 `cwd`）

### 其他

- `bash_info` — 报 bash 路径与 bash/git 版本
- `doctor` — 完整环境诊断，**bash 异常先调它**
- `policy` — 打印当前姿态与完整规则；被拦住后调它才能向用户解释清楚

`exec` 的描述和 MCP `initialize` 的 `instructions` 都声明了「Windows 上优先用它」，但压不过 harness 自带的
系统提示——模型仍可能先选自带 shell。

## 命令策略

不是黑名单，是**能力分类**：命令被切成若干段逐段判定，只有每段都可读、或由项目自己声明、且没有不可判读构造时才自动放行。
唯一开关 `GITBASH_MCP_RISKY` 写在 MCP 客户端配置里（模型改不了，改完要重启服务器）。

| 判定 | 默认 `ask` | `allow` |
|---|---|---|
| read-only / project | 放行 | 放行 |
| mutating / unknown / opaque | 拦住，让你决定（`APPROVAL_REQUIRED`） | 放行 + 审计 |
| catastrophic | 拒绝（`POLICY_DENIED`） | 放行 + 审计 |

被拦住时模型会拿到三条路：① 你自己在终端跑 ② 换更安全的写法 ③ 改配置加 `GITBASH_MCP_RISKY=allow` 并重启。
查看当前策略：`gitbash-mcp policy`。为什么不用正则黑名单、为什么没有批准码，见 `docs/DESIGN.md` §5.8。

## 护栏（零配置）

- **取消即杀**：整棵进程树 `taskkill /T /F`，结果标 `killed_by: cancel`
- **并发上限 4**：超出排队，并在结果里报 `queued_ms`
- **输出封顶**：内存单流 64KB，spill 文件另有 64MB 上限
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

## 开发

~~~powershell
node bin/gitbash-mcp.js     # 起 MCP server（stdio，不接终端）
npm test                    # 五套：client / cli / menu / runner / policy
npm pack --dry-run          # 检查发布内容（只含源码，不含 docs/ 与测试）
~~~

测试会 spawn bash.exe 并使用管道，必须在**正常 shell**里跑（不要在受限沙箱里跑）。

## 文档

- `docs/DESIGN.md` — 架构、工具契约、设计决策
- `docs/REPO_MAP.md` — 代码地图：文件职责、任务→文件索引
- `docs/PLAN.md` — 里程碑与风险
