# gitbash-mcp

MCP server，把 **git-bash (MSYS2)** 的命令执行能力提供给 AI agent（DSH / Claude Code / Codex / ...）。
它在 agent 的沙箱**之外**运行，因此 bash 的管道、信号管道全部可用。

- 工具：`exec`、`bash_info`、`doctor`
- 运行时：Node >= 18（兼容 Bun）
- 协议：MCP stdio

## 为什么需要它

DSH 的 Windows 沙箱用 WRITE_RESTRICTED 受限令牌执行命令。MSYS2 启动时必须创建 signal pipe，
受限令牌下会失败（实测 `couldn't create signal pipe, Win32 error 5`，进程直接崩溃）；
受限令牌下新建命名管道同样会 EPERM（Node `spawn` 默认 `stdio: 'pipe'` 即 `Error: spawn EPERM`）。

**结论：沙箱内跑 git-bash 无解。** 本服务器以独立进程活在沙箱外，绕开该限制。

## 安装

只支持全局安装：

~~~powershell
npm i -g gitbash-mcp
# 或
bun add -g gitbash-mcp
~~~

> 不支持 `npx` / `bunx`：每次拉起都要经过 npx 包装层，在 Windows 上以 stdio 启动不稳定。

## 配置

### 一键配置（推荐）

~~~powershell
gitbash-mcp init           # 交互式勾选菜单
gitbash-mcp init --yes     # 免交互，配置所有检测到的客户端
gitbash-mcp init --no-tui  # 纯文本编号输入（非 TTY 环境会自动切换）
gitbash-mcp uninstall      # 反向移除
gitbash-mcp audit          # 查看最近的命令审计日志
gitbash-mcp policy         # 查看当前命令策略
~~~

菜单操作：`↑/↓`（或 `k/j`）移动光标，`空格` 勾选/取消，`a` 全选，`n` 全不选，`1-9` 跳到并切换该项，`回车` 确认，`q`/`Esc`/`Ctrl-C` 取消。

条目分两类：**已探测到**（排在前面、默认勾选，并标注探测依据，如 `(detected: command codex)` 或 `(detected: .dsh)`）与 **未探测到**（标注 `(not found)`，仍可勾选，便于预配置）。
探测为实时判断，顺序是：**PATH 上是否有对应可执行文件**（`claude`、`codex`、`cursor`、`code`）→ 配置目录 → 配置文件；依据直接显示在菜单里，不用猜。

支持 DSH、Claude Code、Codex CLI、Claude Desktop、Cursor、VS Code；写入前自动备份为 `*.bak`。

### 手动配置

把 MCP 命令写成全局命令名 `gitbash-mcp`：

| 客户端 | 做法 |
|---|---|
| DSH | 面板新增 MCP：名称 `gitbash`，命令 `gitbash-mcp`，参数留空 |
| Claude Code | `claude mcp add gitbash -- gitbash-mcp` |
| Codex CLI | `~/.codex/config.toml` 加 `[mcp_servers.gitbash]`，`command = "gitbash-mcp"` |
| 通用 JSON | `{ "mcpServers": { "gitbash": { "command": "gitbash-mcp", "args": [] } } }` |

## 工具

### `exec`

| 参数 | 必填 | 说明 |
|---|---|---|
| `command` | 是 | bash 命令或多行脚本 |
| `cwd` | | 工作目录（Windows 路径） |
| `timeout_ms` | | 超时毫秒（默认 60000，上限 600000），超时杀整棵进程树 |
| `login` | | `bash -lc`（读 profile） |
| `env` | | 追加环境变量 |

返回统一 JSON：

~~~jsonc
{
  // 命令失败（非零退出 / 超时 / spawn 失败）也返回这个结构，不抛工具错误
  "exit_code": 0,
  "stdout": "...",
  "stderr": "",
  "timed_out": false,
  "truncated": false,
  "spill_path": null
}
~~~

- 输出超过 64KB 时截断，完整内容转存到 `%TEMP%\gitbash-mcp\`，`spill_path` 指向它
- 每次调用都是新进程，状态不保留（用 `cd` 或传 `cwd`）

### `bash_info`

报告解析到的 bash 路径与 bash/git 版本。

### `doctor`

完整环境诊断：所有探测过的候选路径、命中的那个、`GITBASH_BASH` 的值是否有效、git 是否在 PATH、
以及找不到时的修复步骤。**bash 相关异常先调它。**

## 护栏（P0，零配置）

装好即生效，不需要任何开关：

| 机制 | 行为 |
|---|---|
| **取消即杀** | 工具调用被取消时，整棵进程树被 `taskkill /T /F` 杀掉，结果标记 `killed_by: cancel` |
| **并发上限** | 最多 4 条命令同时运行，其余排队并在结果里报 `queued_ms` |
| **输出上限** | 单流内存 64KB；超出部分写入 spill 文件，该文件本身也**封顶 64MB** |
| **环境洗白** | 交给 bash 之前清掉凭据形状的变量（`*_TOKEN`、`*_API_KEY`、`AWS_*`、`*PASSWORD*` 等），`SSH_AUTH_SOCK` 保留 |
| **审计日志** | 每次调用追加一行 JSONL；`gitbash-mcp audit [-n 20]` 查看 |

`exec` 的结果因此多了这些字段：`duration_ms`、`killed_by`（cancel / timeout / null）、`queued_ms`、
`spill_bytes`、`spill_truncated`、`audit_id`。

> **诚实声明**：这些是『降低误伤与明显滥用』的护栏，**不是安全边界**——它挡不住蓄意绕过（`r''m`、`$IFS`、
> `base64 -d|bash` 等）。真正的隔离只能在 OS 层做（低权限账户 / 容器 / VM）。

## 命令策略（P1，一个开关）

按危险程度分三档，只由**一个**环境变量控制（写在 MCP 客户端配置里，模型改不了）：

| 档位 | 例子 | `GITBASH_MCP_RISKY=ask`（默认） | `=allow` |
|---|---|---|---|
| catastrophic | `mkfs`、`diskpart`、`rm -rf /`、`shutdown` | 拒绝（`POLICY_DENIED`） | 放行 + 审计 |
| dangerous | `rm -rf ./x`、`git push --force`、`curl \| bash`、`npm publish` | **拦住，让你决定**（`APPROVAL_REQUIRED`） | 放行 + 审计 |
| suspicious | `eval`、`base64 -d \| sh`、`nc`、`env \| curl` | 放行 + 审计 + 结果标注 | 同左 |

被拦住时模型会拿到明确指引：① 让你自己在终端跑 ② 换更安全的写法 ③ 你改配置加 `GITBASH_MCP_RISKY=allow` 并重启。
查看当前策略：`gitbash-mcp policy`，或让模型调 `policy` 工具。

> **为什么没有\"批准码\"**：模型拥有同一个 shell——任何它能提交的批准它也能伪造。唯一不可伪造的同意，是你在**启动配置**里的选择。

## 故障排查

### 报 `BASH_NOT_FOUND`

服务器不会因此崩溃：它照常启动，每次 `exec` 返回带修复指引的 JSON，模型可以直接转述给用户。

~~~jsonc
{
  "exit_code": -1,
  "error_code": "BASH_NOT_FOUND",
  "stderr": "git-bash (MSYS2 bash) was not found ... 1. Install Git for Windows ...",
  "hint": "..."
}
~~~

修复（二选一，然后重启 MCP 服务器）：

1. 安装 Git for Windows：https://git-scm.com/download/win（自带 git-bash）
2. 设置环境变量 `GITBASH_BASH` 指向你的 bash.exe，例如 `C:/Program Files/Git/bin/bash.exe`

### bash 检测顺序

`GITBASH_BASH` 环境变量（仅当文件存在）→ PATH 里的 `bash` → 常见安装路径
（Program Files、Program Files (x86)、`%LOCALAPPDATA%\Programs\Git`、scoop shims、`C:\msys64`、`C:\cygwin64`）。

## 安全边界

本进程在沙箱外运行，权限 = 启动它的 agent 进程的**完整用户权限**，没有文件沙箱。
模型可以无门槛调用 `exec`。这不是缺陷，而是此类 MCP 桥的既有模型——使用前请知悉。

## 开发

~~~powershell
node bin/gitbash-mcp.js        # 起 MCP server（stdio，不接终端）
node test-client.mjs           # 协议冒烟：doctor / 管道 / 超时 / 截断 / 取消 / 策略 / 缺 bash
node test-cli.mjs              # CLI 冒烟：init / uninstall / 幂等 / 备份 / audit
node test-menu.mjs             # 菜单按键逻辑（无需 TTY）
node test-runner.mjs           # 护栏：洗白 / 封顶 / 并发 / 取消杀树 / 审计轮转
node test-policy.mjs           # 策略：档位分类 / 姿态裁决
npm test                       # 一次跑完五套
gitbash-mcp init --dry-run     # 预览会写哪些客户端配置
npm pack --dry-run             # 检查发布内容（只含源码，不含 docs/ 与测试）
npm i -g .                     # 从本地仓库全局安装（发布前自测）
~~~

测试会 spawn bash.exe 并使用管道，因此要在**正常 shell**里跑（不要在受限沙箱里跑）。

## 文档

- `docs/DESIGN.md` — 架构、契约、设计决策
- `docs/PLAN.md` — 里程碑与风险
- `docs/NPM_PUBLISH.md` — 发布到 npm 的完整步骤（**本地文件，不入库**）