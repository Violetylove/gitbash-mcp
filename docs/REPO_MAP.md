# gitbash-mcp 仓库地图

先读本文件确定职责，再读 DESIGN.md 获取当前契约；目标与进度见 PROGRESS.md。

## 1. 入口与依赖方向

~~~text
bin/gitbash-mcp.js
  ├─ server.js → lib/mcp/server.js → lib/mcp/tools/*
  │                ├─ lib/execution/service.js → policy / environment / execution / jobs / audit
  │                ├─ lib/jobs/service.js → lib/jobs/registry.js → lib/execution/runner.js
  │                └─ lib/environment/diagnostics.js、detect.js、lib/policy/index.js
  └─ lib/cli/index.js → environment / policy / audit / cli/menu.js / cli/theme.js
~~~

协议适配依赖服务，服务返回普通对象；进程原语不依赖 MCP SDK。server 给执行服务注入当前会话的工作目录解析器。

## 2. 文件职责

| 模块目录 | 边界 |
|---|---|
| lib/mcp/ | 协议定义、响应格式、模型指引、会话 roots；业务模块不依赖此目录 |
| lib/execution/ | 执行流程与唯一进程启动路径、输出和并发 |
| lib/policy/ | 命令解析、风险分类、执行授权 |
| lib/approval/ | 单次审批注册表、无超时等待、WPF 窗口与私有管道 |
| lib/jobs/ | 作业注册、移交、查询、等待和停止 |
| lib/environment/ | Bash 检测与环境诊断 |
| lib/audit/ | 本机审计存储 |
| lib/cli/ | 客户端配置与终端交互 |

| 文件 | 职责 / 关键接口 |
|---|---|
| bin/gitbash-mcp.js | 唯一命令入口；server / CLI 分派 |
| server.js | stdio 启动与退出清理 |
| lib/mcp/server.js | 创建与组装会话；测试可注入窗口适配器 |
| lib/mcp/tools/approval.js | approval_list / approval_status / approval_cancel 注册 |
| lib/approval/service.js | 审批创建、exec 内部结果等待、单次决策、中断恢复、状态、取消、审计与清理；待审批清空后关闭窗口 |
| lib/approval/windows.js | Windows PowerShell 启动、私有 JSONL 管道、就绪与故障处理 |
| lib/approval/windows.ps1 | WPF 单请求详情、底部翻页与逐条选择；WinForms 为备选 |
| lib/mcp/tools/exec.js | exec 描述、schema、MCP 适配；registerExecTool |
| lib/mcp/tools/jobs.js | job_output / job_list / job_kill 注册；registerJobTools |
| lib/mcp/tools/diagnostics.js | bash_info / doctor / policy 注册；registerDiagnosticTools |
| lib/mcp/instructions.js | initialize 返回的模型指引 |
| lib/execution/results.js | 基础执行结果与 hint |
| lib/execution/preflight.js | 工作目录预检与 INVALID_CWD 结果；directoryFailure |
| lib/mcp/responses.js | MCP content 格式；json / text |
| lib/mcp/workspace.js | roots 查询、缓存与 cwd 回退；createWorkspaceResolver |
| lib/execution/service.js | 校验、授权、预检、审批接入、前后台执行、移交、审计、退出清理；createExecutionService |
| lib/policy/authorization.js | 当前策略执行门与拒绝说明；authorizeCommand |
| lib/jobs/service.js | 作业查询、等待、摘要、显式停止；readJob / listJobSummaries / stopJob |
| lib/environment/diagnostics.js | Bash 信息服务；bashInfo |
| lib/environment/detect.js | 候选扫描、惰性缓存、缺 Bash 结果、doctorReport |
| lib/execution/runner.js | launch、runWithForegroundBudget、输出通道、FIFO 闸门、环境、杀树 |
| lib/jobs/registry.js | 当前进程作业注册表；startJob / adopt / jobPayload / killAllJobs |
| lib/policy/shell-parse.js | 纯命令解析；parseCommand |
| lib/policy/index.js | 能力分类、项目入口识别、姿态裁决与路径转换检查 |
| lib/audit/index.js | JSONL 追加、读取、路径、5MB 轮转 |
| lib/cli/index.js | 配置客户端、卸载、诊断、审计与策略命令 |
| lib/cli/menu.js | 纯菜单 reducer 与终端渲染 |
| lib/cli/theme.js | ANSI 样式，尊重 NO_COLOR / FORCE_COLOR / TERM |
| package.json | ESM、Node 版本、bin、脚本、依赖、发布白名单 |

## 3. 修改任务索引

| 任务 | 修改位置 | 对应测试 |
|---|---|---|
| 工具 schema / 描述 / 指引 | mcp/tools/*、mcp/instructions.js | test-client |
| 授权接入与拒绝结果 | policy/authorization.js、execution/service.js | test-client、test-policy |
| 审批状态、窗口与执行 | approval/*、mcp/tools/approval.js、execution/service.js | test-approval、test-client |
| 默认工作目录 | mcp/workspace.js | test-client |
| 工作目录预检与错误提示 | execution/preflight.js、execution/service.js | test-client、test-approval |
| 排队、超时与移交流程 | execution/service.js、execution/runner.js | test-client、test-runner |
| 输出封顶、环境与杀树 | execution/runner.js | test-runner |
| 作业管理与查询 | jobs/registry.js、jobs/service.js | test-runner、test-client |
| 命令解析和风险档位 | policy/shell-parse.js、policy/index.js | test-policy |
| Bash 探测与诊断 | environment/detect.js、environment/diagnostics.js | test-client、test-runner |
| 审计 | audit/index.js、execution/service.js、jobs/registry.js | test-runner、test-client |
| 客户端配置与入口 | cli/index.js、bin/gitbash-mcp.js | test-cli |
| 菜单与配色 | cli/menu.js、cli/theme.js | test-menu |
| 发布文件 | package.json | npm pack --dry-run |

## 4. 执行常量

runner：DEFAULT_TIMEOUT_MS=60000，MAX_TIMEOUT_MS=600000，FOREGROUND_MS=45000，QUEUE_FLOOR_MS=250，MAX_CONCURRENCY=4，OUTPUT_CAP_BYTES=64KB，SPILL_CAP_BYTES=64MB，JOB_TAIL_BYTES=64KB，KILL_GRACE_MS=1500，EXIT_DRAIN_MS=250。

jobs：MAX_BACKGROUND_JOBS=8（只限制显式后台启动），MAX_RETAINED_JOBS=32（运行中记录不删除），DEFAULT_JOB_WAIT_MS=30000，MAX_JOB_WAIT_MS=50000。

当前风险姿态为 GITBASH_MCP_RISKY=ask / allow；Bash 路径探测支持 GITBASH_BASH。资源护栏使用代码常量，不增加环境配置。

approval：待审批上限 32，结束记录最多 64（按结束先后清理），单条 JSON 快照上限 128 KiB（UTF-8 字节数），窗口消息上限 4 MiB；人类审批无超时。Windows 适配器窗口启动就绪期限 15 秒，仅检测启动故障。

## 5. 测试与文档

| 套件 | 主要覆盖 |
|---|---|
| test/test-client.mjs | MCP 握手、十个工具、结果契约、长任务、取消、路径转换、缺 Bash、策略与审批查询 |
| test/test-cli.mjs | CLI、dry-run、备份、幂等、合并配置、卸载 |
| test/test-menu.mjs | reducer、按键、渲染、配色 |
| test/test-runner.mjs | 环境、通道、输出、并发、生命期、杀树、作业、审计 |
| test/test-policy.mjs | 解析、能力分类、项目入口、姿态、路径转换 |
| test/test-approval.mjs | 请求冻结、单次批准、取消、窗口失败、容量、实际执行接线、WPF 控件验证 |

完整测试含 Bash 与子进程管道，必须在沙箱外运行。menu 和 policy 是纯函数套件，可独立运行。

test/fixtures/server.mjs 用测试窗口替身运行真实 MCP 组装。六套自动测试、配套夹具和 WPF 控件验证入口保留；测试文件不入发布包。历史验证结果见 PROGRESS.md。

README 面向用户；DESIGN 描述设计和契约；PROGRESS 记录目标、历史进度、待办与验收标准；AGENTS 约束维护方式。
