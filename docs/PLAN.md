# gitbash-mcp 项目计划书

> 状态：M0–M11、M14 完成（M14 = 采纳用户视角 v2 反馈：后台作业 / 超时契约 / policy 瘦身 / 解析 bug / 路径转换 / 文档）；
> 只剩 M12 发布。代码契约以 `docs/DESIGN.md` 为准，代码地图见 `docs/REPO_MAP.md`。

## 已完成

| # | 里程碑 | 交付 |
|---|---|---|
| M0 | 设计定稿 | DESIGN / PLAN / AGENTS |
| M1 | 骨架 + 核心 exec | server.js + 协议冒烟 |
| M2 | 健壮性 | 超时整树杀 / 截断+spill / UTF-8 / 错误契约 |
| M3 | 部署脚本 | install/uninstall（后被 CLI 取代并删除） |
| M4 | 真机验证 | DSH 面板注册，工具实际可用 |
| M5 | 友好性 | 惰性检测 + `BASH_NOT_FOUND` + `doctor`（启动永不失败） |
| M6 | npm 就绪 | bin / files / engines / license / publishConfig |
| M7 | 交互式安装器 | `init` / `uninstall` / `doctor` + 备用屏幕勾选菜单（6 客户端） |
| M8 | git + 首发准备 | git 初始化、发布前自检（`npm pack --dry-run`） |
| M9 | P0 护栏 | 取消即杀 / 并发上限 / 双重封顶 / 环境洗白 / 审计日志（零配置） |
| M10 | P1 策略引擎 | 能力分类（`shell-parse.js` 解析 + 逐段判定 + 项目声明信任，取代正则黑名单）+ 单开关 `GITBASH_MCP_RISKY` + `policy` 工具 |
| M11 | 采纳率 | 服务端 MCP `instructions` + `exec` 描述声明「Windows 上优先用它」（`4d4b62d`） |
| M14 | 长任务与超时契约（反馈 v2） | 后台作业注册表 + `job_output`/`job_list`/`job_kill`；`run_in_background` 毫秒级返回句柄；取消/预算到点改为「移交」而非杀进程；`FOREGROUND_MS=45000` 软期限；`still_running`/`timeout_ms`/`job_id`；policy 收成一行；解析器修关键字与 `2>&1`/`/dev/null`；默认 `MSYS_NO_PATHCONV=1`；`cwd` 用客户端 roots |
| M15 | 修 v2 带来的两条回归（反馈 v3） | 移交即**清零继承的 `timeout_ms`**（默认 60s 时限曾在软返回后 15 秒销毁成果）；`cmd //c` 前置拒绝（`PATHCONV_ESCAPE` + 改法 + 逃生口），其它程序只加 `warnings` |
| M16 | 完成判定与并发口径（反馈 v4） | **完成 = 直接子进程退出**（管道只多等 `EXIT_DRAIN_MS=250`）：`start`/`&`/daemon 的残留持有者不再拖到超时并连坐杀树（20130ms → 364ms）；并发口径写死：`MAX_CONCURRENCY` 管前台、`MAX_BACKGROUND_JOBS` 管后台，后台启动结果补 `queued_ms` |

> 这三轮的来源是同一个会话的四份用户视角黑盒反馈（`gitbash-mcp-agent-brief*.md`）。
> 贯穿结论：MCP server 是跨调用长期存活的独立进程，**后台作业与超时兜底可在 server 内独立完成，不需要宿主配合**；
> 唯一修不了的是「让一次前台调用真的阻塞 10 分钟」（那道超时在客户端进程里），用软期限 + 移交绕过。

## 未完成

### M12：发布（收尾）

1. 前置已就绪：`npm whoami --registry=https://registry.npmjs.org/` → `violetylov3`，token 可发布（无需 OTP）
2. `npm publish` → 校验 `npm view gitbash-mcp version`
3. 本机切到发布版：`npm i -g gitbash-mcp@latest`（**客户端要重启**才加载新版本）
4. 可选：把 DSH 面板的注册从仓库路径改成裸命令 `gitbash-mcp`

### M13（可选）：P2 加固

- ~~`GITBASH_MCP_ENV=safe` 白名单模式~~ 已由模型 D 的「项目声明信任」取代：不引入需要人维护的清单文件
- `bash -r` 受限模式（软限制，会破正常用法，默认关）
- `readonly` 策略预设

## 风险登记表

| 风险 | 影响 | 缓解 |
|---|---|---|
| 找不到 bash | 工具不可用 | 服务不崩；`BASH_NOT_FOUND` + `doctor` 给修复步骤 |
| MSYS2 子进程残留 | 超时后占资源 | `taskkill /T /F` 整树 + 1.5s 有界宽限结算 |
| 客户端请求超时（~60s）打断长命令 | 调用方拿 `-32001`，误判「任务失败」 | 前台软期限 `FOREGROUND_MS=45s` 先返回结构化结果；更长的走后台作业；取消改为移交而不是杀（§5.10/§5.11） |
| 取消不再断进程（按「停止」不等于停） | 命令可能继续跑 | 有意取舍：`job_list` 可见、`job_kill` 可停、server 退出全杀、后台作业上限 8 |
| 移交后的命令不再有时限 | 可能长期占资源 | 有意取舍（时限语义属于「愿意等多久」）；`job_list` 可见、`job_kill` 可停、server 退出全杀 |
| 路径转换默认关闭，旧式 `//x` 写法失效 | 存量脚本/提示词踩坑 | `cmd //c` 会被**前置拒绝**（不会静默挂死）并给出改法与 `env` 逃生口；其它程序在结果里附 `warnings`；README 有迁移表格 |
| 后台作业随 server 重启丢失 | 句柄与结果取不回 | 文档明示；审计落 `job_id`/`command`/`exit_code`/`log_path`，输出文件 24h 内可从盘上捞 |
| 策略被绕过 | 危险命令仍可能执行 | 文档明确声明「护栏不是安全边界」；人类同意开关 + 完整审计 |
| 审计 / spill 无界增长 | 磁盘占用 | 审计 5MB 轮转；spill 单文件 64MB + 24h 清理；作业注册表最多 32 条 |
| 依赖漂移（SDK/zod） | 启动报错 | semver 锁定 + 每次发布前跑五套测试 |

## 变更控制

- 五套测试全绿才提交；文档（README / AGENTS / DESIGN / PLAN / REPO_MAP）与代码同一提交。
- 结果契约（DESIGN §4）与「启动永不失败」（§5.1）是红线。
- 唯一允许的环境变量是 `GITBASH_MCP_RISKY`。