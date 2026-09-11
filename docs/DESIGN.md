# gitbash-mcp 设计文档

> 状态：v3（Node 运行时 + 全局安装 + doctor 诊断）。决策记录见 §5、§7。

## 1. 背景与限制（实测）

DSH 的 Windows 沙箱（`@deepseek-ai/dsh-sandbox-windows-acl`）用 **WRITE_RESTRICTED 受限令牌**执行命令
（`packages/sandbox/sandbox-windows-acl/src/token.ts`）。后果：

1. 受限令牌下**新建命名管道失败**：Node `spawn` 默认 `stdio:'pipe'` → `Error: spawn EPERM`。
2. **MSYS2 启动即需创建 signal pipe** → `couldn't create signal pipe, Win32 error 5`，进程起不来。

**沙箱内跑 git-bash 无解**（与调用方式无关）；执行进程必须在沙箱外。

## 2. 目标 / 非目标

目标：`exec`（跑命令）、`doctor`（环境诊断）、**永不因环境问题启动失败**、超时整树杀 + 截断/spill、
通过 **npm 全局安装**分发（无自带运行时）。

非目标：DSH skill 打包、原生 executor 插件、沙箱内执行、后台任务管理、
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
`server.js` 只做工具注册，`lib/detect.js`（bash 检测 / doctor）与 `lib/runner.js`（spawn / 截断）被两者共用，
`lib/cli.js` 是零依赖（`node:readline`）的客户端配置写入器。

## 4. 工具契约

### 4.1 `exec`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `command` | string | 是 | bash 命令或多行脚本，作为**单个 argv** 传给 `bash -c/-lc` |
| `cwd` | string | | 工作目录（Windows 路径） |
| `timeout_ms` | int | | 默认 60000，上限 600000 |
| `login` | bool | | `bash -lc`（读 profile） |
| `env` | object | | 追加环境变量 |

~~~jsonc
{
  "exit_code": 0,        // spawn 失败或超时为 -1
  "stdout": "...",       // 超过 64KB 截断
  "stderr": "",
  "timed_out": false,
  "truncated": false,
  "spill_path": null,     // 有截断时指向 %TEMP%\gitbash-mcp\ 的全量日志
  "spill_bytes": 0,       // 已写入 spill 的字节数
  "spill_truncated": false, // spill 文件本身是否封顶截断
  "duration_ms": 123,      // 实际耗时
  "killed_by": null,       // 'cancel' | 'timeout' | null
  "queued_ms": 0,          // 因并发上限而排队的时间
  "audit_id": "...",       // 该次调用的审计记录 id
  "policy": {              // 允许执行时附带的裁决信息
    "decision": "allow",   // 'allow' | 'allow-risky'
    "tier": "safe",        // safe | suspicious | dangerous | catastrophic
    "stance": "ask",       // 来自 GITBASH_MCP_RISKY
    "matched_rules": []
  },
  "error_code": "APPROVAL_REQUIRED", // 被策略拦住时：APPROVAL_REQUIRED | POLICY_DENIED
  "category": "dangerous",
  "matched_rules": ["recursive delete"]
  "error_code": "BASH_NOT_FOUND",  // 仅缺 bash 时出现
  "hint": "..."                     // 仅缺 bash 时出现
}
~~~

- 命令失败（非零退出 / 超时 / spawn 失败）→ 返回 JSON，**不抛 MCP 错误**
- 参数错误（command 为空）→ 抛 MCP 错误

### 4.2 `bash_info`
返回 bash 路径、bash/git 版本、HOME/PWD/MSYSTEM；缺 bash 时返回修复说明。

### 4.3 `doctor`
纯文本诊断：platform、runtime、execPath、`GITBASH_BASH` 值及有效性、命中的 bash 及来源、
PATH 上的 git、**逐条候选路径命中情况**、缺 bash 时的修复步骤。

### 4.4 CLI（`init` / `uninstall` / `doctor`）

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
支持窗口 resize 重绘。按键逻辑是纯函数 `reduceMenu`，帧内容由纯函数 `menuRows`/`renderFrame` 生成，均由 `test-menu.mjs` 单测覆盖。

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

### 5.4 超时与进程树
超时用 `taskkill /pid <pid> /T /F` 整树强杀，再 `child.kill()` 兜底；结果 `timed_out: true`。

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
| 取消即杀 | `RequestHandlerExtra.signal` → `taskkill /T /F`；杀掉后给 1.5s 宽限，不等孤儿进程占着的管道 | — |
| 并发上限 | `createSemaphore` FIFO 排队，结果报 `queued_ms` | `MAX_CONCURRENCY = 4` |
| 输出封顶 | 内存 64KB + spill 文件封顶 | `OUTPUT_CAP_BYTES = 64KB`、`SPILL_CAP_BYTES = 64MB` |
| 环境洗白 | spawn 前清掉凭据形状变量（`*_TOKEN`/`*_API_KEY`/`AWS_*`/`*PASSWORD*`），保留 `SSH_AUTH_SOCK` | — |
| 审计 | 每次调用追加 JSONL，`gitbash-mcp audit` 读取 | — |

> 关键教训（实测）：`taskkill /T /F` 本身有效，但**被杀的 MSYS2 孙进程可能继续持有 stdio 管道**，
> 把 `close` 事件拖到子进程自然结束。因此杀完后必须在有界宽限内直接结算，不能只等 `close`。

这些是"降低误伤"的护栏，**不是安全边界**（正则/资源限制都挡不住蓄意绕过）。真正的隔离只能在 OS 层。

### 5.8 命令策略（P1，单开关）

三档分类（`lib/policy.js`，纯函数）：`catastrophic` / `dangerous` / `suspicious`；
其中 `rm` **用结构化解析**（提取 flag 与目标）而不是正则——`rm -rf` / `rm -fr` / `rm --recursive` 的写法太多，
正则漏判过一次（`rm -rf ./x` 曾判成 safe），这个 bug 由 `test-policy.mjs` 的 32 个用例钉住。

裁决：`safe`/`suspicious` → 放行（后者在结果里标注 tier）；`dangerous` → 默认 `ask-required`（返回 `APPROVAL_REQUIRED`，
指引模型去问用户）；`catastrophic` → 默认 `deny`（`POLICY_DENIED`）；当 `GITBASH_MCP_RISKY=allow` 时两者都放行并标注 `allow-risky`。

**不实现 in-band 批准码**：模型拥有同一个 shell，它能跑任何它能提交的批准命令。唯一不可伪造的同意通道是 MCP 的启动配置。
新增 `policy` 工具输出完整规则与当前姿态，供模型向用户解释。

### 5.9 分发：全局安装，不做 exe
`bin: { gitbash-mcp: server.js }`，shebang `#!/usr/bin/env node`，用户 `npm i -g gitbash-mcp`。
`bun build --compile` 会内嵌整个 Bun 运行时（实测 108.82MB），全局安装只需用户已有的 Node，
安装体积约 14MB（依赖 13.85MB）。

已核实 `cross-spawn/lib/parse.js`：非 `.exe/.com` 扩展名会经 `cmd.exe /d /s /c` 包装，
因此全局 `.cmd` shim 可直接作为 MCP 客户端的 `command`。

## 6. 分发与配置

发布：`npm pack --dry-run` 只应包含源码 —— `bin/`、`lib/`、`server.js`、`package.json`、`README.md`、`LICENSE`
（当前 12 个文件、打包约 24KB），不含 `docs/` 与测试文件；
完整步骤见 `docs/NPM_PUBLISH.md`（本地文件，不入库）。

配置：`gitbash-mcp init` 交互式写入各客户端配置（见 §4.4）；也可手动把命令写成 `gitbash-mcp`、参数留空。
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

## 8. 测试策略

`node test-client.mjs` 覆盖：工具握手与列举、`doctor` 报告、回显、**管道**、非零退出码、
**超时整树杀**、**超 64KB 截断 + spill 全量校验**、空命令报错、**缺 bash 降级**
（清洗 env 拉起第二个实例，断言 `BASH_NOT_FOUND` + 修复指引 + doctor 报 NOT FOUND）。

`node test-cli.mjs` 覆盖 CLI：help/version/doctor、`--dry-run` 不落盘、init 写入并保留既有内容、备份生成、
**二次 init 幂等**、uninstall 只删自己的条目、`--yes` 选择已检测客户端；全部在临时 root 中进行，不碰真实配置。

`node test-runner.mjs` 单测 P0 护栏：环境洗白的保留/剔除清单、spill 内存与磁盘双重封顶、
信号量并发峰值与 `queuedMs`、**取消后进程树确实死亡**（用延迟写入的标记文件验证）、审计 JSONL 往返。

`node test-policy.mjs` 覆盖策略：32 个档位分类用例（含曾经误判的 `rm -rf ./x`）、姿态裁决（unset/未知值回退 ask、allow 放行）、报告内容。

> 五套测试都会 spawn bash.exe 并使用管道，必须在正常 shell 中运行。
> 审计写入用临时 `LOCALAPPDATA`，不会污染真实日志。

## 9. 变更纪律

- §4 结果契约与 §5.1 启动永不失败是红线。
- 日志只走 stderr（stdout 是协议通道）。
- 文档与代码同一次提交内同步。