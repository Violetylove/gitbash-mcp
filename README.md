# gitbash-mcp

让 Windows 上的 AI 客户端使用 Git Bash 执行命令，支持人类审批、后台任务和执行记录。

适合 Git 操作、Shell 管道、项目构建和脚本执行。Windows 原生 cmdlet、COM 和 .NET 操作仍适合使用 PowerShell。

## 功能

- **执行命令**：支持单条命令和多行脚本，返回输出、退出码与错误提示。
- **人类审批**：需要确认的命令先在本机弹窗中展示，批准后才执行。
- **长任务管理**：任务可在后台继续运行，随时查看输出或停止。
- **诊断与记录**：检查 Bash 环境、查看命令策略和审计记录。

## 安装与接入

需要 Windows、Node.js 18 或更高版本，以及 Git Bash。审批窗口还需要可用的 Windows 桌面、Windows PowerShell 和 WPF。

1. 全局安装：

   ```powershell
   npm install -g gitbash-mcp
   ```

2. 选择要接入的客户端：

   ```powershell
   gitbash-mcp init
   ```

3. 重启对应客户端，检查 MCP 工具是否已加载。

支持自动配置 DSH、Claude Code、Codex CLI、Claude Desktop、Cursor 和 VS Code。VS Code 配置写入当前工作目录，运行 `init` 前请先进入项目。

配置修改前会备份已有文件。也可以先预览，或指定客户端：

```powershell
gitbash-mcp init --dry-run
gitbash-mcp init --target codex,cursor
```

仅支持全局安装，不提供 npx / bunx 启动方式。服务由 MCP 客户端启动，平时无需另开终端手动运行。

## 使用

接入后，可以直接向 AI 描述任务，例如：

> 使用 gitbash-mcp 查看这个项目的 Git 状态。
>
> 在项目目录执行构建；如果需要审批，等待我确认。
>
> 将这个长任务放到后台运行，稍后查看输出。

以下示例是客户端调用 MCP 工具的参数，不是需要粘贴到终端的命令。

### 执行命令

调用 `exec`：

```json
{
  "command": "git status --short",
  "cwd": "C:\\projects\\demo"
}
```

| 参数 | 用途 |
|---|---|
| `command` | 必填；Bash 命令或多行脚本 |
| `cwd` | 执行目录；省略时优先使用客户端提供的工作区，否则使用服务工作目录 |
| `run_in_background` | 设为 `true`，授权后启动后台任务并返回 `job_id` |
| `timeout_ms` | 命令执行时限，单位毫秒；前台默认 60000，后台省略时不设时限，上限 600000 |

还可通过 `login: true` 加载 Bash 登录配置。环境变量直接写在命令里，例如 `FOO=1 npm test`；不提供单独的 `env` 参数。默认审批模式下，这类环境赋值需要人类确认。

路径转换默认关闭，需要时在程序前加 `env -u MSYS_NO_PATHCONV`；这一写法本身不会增加审批要求，实际命令仍按其风险判定。

结果主要看 `exit_code`、`stdout` 和 `stderr`；出现 `job_id` 时，用作业工具继续获取结果。命令失败会返回原因和可用提示。

执行目录不存在、不是目录或无法访问时，返回 `INVALID_CWD` 和目录修正提示，命令不会启动。

每次调用都是独立的 Shell，上一条命令的 `cd` 不会影响下一次调用。需要固定目录时请传 `cwd`。

### 人类审批

默认模式下，只读命令和识别到的项目声明入口可以直接执行；其他需要确认的命令会打开审批窗口，严重破坏性命令会被拒绝。

窗口展示命令和执行目录，长内容可以展开；多个请求通过 `<`、`>` 切换。登录 Shell、后台运行和时限不在窗口展示，批准后仍按原请求参数执行。

最后一条待审批请求批准、拒绝或撤销后，窗口自动关闭；已批准的命令继续执行。新的审批请求到来时会重新打开窗口。

| 操作 | 结果 |
|---|---|
| **Approve** | 批准本次原始命令，执行后向原 `exec` 调用返回结果 |
| **Reject** | 拒绝本次请求，命令不执行 |
| **关闭窗口** | 取消全部待审批请求；已经批准的执行不受影响 |
| **最小化** | 保留待审批请求，稍后可以继续处理 |

审批不设超时，也不计入命令执行时限。正常流程中，`exec` 等待人类决定，客户端不需要轮询审批。

多条请求各自处理、各自返回：拒绝立即返回；批准后在该条命令执行结束或转为后台作业时返回，不等待其他请求。

如果客户端先中断或超时，已受理的审批仍会保留。不要重复提交命令：用 `approval_list` 找回请求，再通过 `approval_status {approval_id}` 查看结果；需要撤销时使用 `approval_cancel {approval_id}`。客户端断开或服务重启后，记录不再保留。

`approval_list` 的参数为 `{}`，根据命令、目录和创建时间找到原请求的 `approval_id`。服务不限制人类等待时间，但客户端仍可能有自己的调用超时。

风险模式由客户端的 MCP 启动环境变量 `GITBASH_MCP_RISKY` 控制：`ask` 为默认审批模式；`allow` 跳过风险审批并放行命令。修改后需重启服务；在命令里设置它不会改变审批模式。

### 后台任务

耗时较长的命令建议直接使用后台模式：

```json
{
  "command": "npm run build",
  "cwd": "C:\\projects\\demo",
  "run_in_background": true
}
```

取得 `job_id` 后：

| 工具 | 用途 |
|---|---|
| `job_output {job_id}` | 查看状态与输出；加 `wait: true` 可等待一段时间 |
| `job_list` | 找回当前服务中的任务 |
| `job_kill {job_id}` | 停止任务及其子进程 |

前台执行最多等待 45 秒，审批时间另计。到点或调用取消时，仍在执行的命令会移交为后台作业；需要停止时使用 `job_kill`。命令自己的执行时限到点则会停止执行。

后台任务不跨服务重启保留；客户端断开或服务退出时会清理运行中的任务。

## 诊断与维护

在终端中运行：

```powershell
gitbash-mcp doctor    # 检查运行环境
gitbash-mcp policy    # 查看当前命令策略
gitbash-mcp audit     # 查看执行与审批记录
```

AI 也可以调用 `doctor`、`policy` 和 `bash_info` 获取诊断信息。

找不到 Bash 时，运行 `doctor`，按提示安装 Git for Windows 或修正路径，再重新连接客户端。调用失败或超时后，先检查已有审批和作业，避免重复执行。

移除客户端配置及全局安装：

```powershell
gitbash-mcp uninstall
npm uninstall -g gitbash-mcp
```

## 权限与边界

本服务在 agent 沙箱外运行，具有启动它的 agent 进程的完整用户权限，**没有文件沙箱**。命令分类、审批和审计用于减少误操作，不构成安全隔离；项目声明的脚本也不代表已经逐条验证安全。

## 更多文档

[设计说明](docs/DESIGN.md) · [目标与进度](docs/PROGRESS.md) · [维护者指南](AGENTS.md)

MIT License。
