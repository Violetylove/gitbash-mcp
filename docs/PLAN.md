# gitbash-mcp 项目计划书

> 状态：M0–M11 完成（M11 = 采纳率：服务端 `instructions` + `exec` 描述声明「Windows 优先」）；只剩发布。代码契约以 `docs/DESIGN.md` 为准，代码地图见 `docs/REPO_MAP.md`。

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

## 未完成

### M12：发布到 npm（只剩真发布的 OTP）

1. 前置已就绪：包名 404 未被占用；`npm whoami --registry=https://registry.npmjs.org/` → `violetylov3`；
   `npm publish --dry-run` 已跑通（13 个文件、约 29 kB）
2. `npm publish --otp=<验证器 6 位码>`（或把 granular token 配成 **All packages + Read and write + Bypass 2FA**）
3. `npm i -g gitbash-mcp` 验证全局安装
4. 把 DSH 面板的注册从仓库路径改成 `gitbash-mcp` 命令

### M13（可选）：P2 加固

- ~~`GITBASH_MCP_ENV=safe` 白名单模式~~ 已由模型 D 的「项目声明信任」取代：不引入需要人维护的清单文件
- `bash -r` 受限模式（软限制，会破正常用法，默认关）
- `readonly` 策略预设

## 风险登记表

| 风险 | 影响 | 缓解 |
|---|---|---|
| 找不到 bash | 工具不可用 | 服务不崩；`BASH_NOT_FOUND` + `doctor` 给修复步骤 |
| MSYS2 子进程残留 | 超时后占资源 | `taskkill /T /F` 整树 + 1.5s 有界宽限结算 |
| 策略被绕过 | 危险命令仍可能执行 | 文档明确声明「护栏不是安全边界」；人类同意开关 + 完整审计 |
| 审计 / spill 无界增长 | 磁盘占用 | 审计 5MB 轮转；spill 单文件 64MB + 24h 清理 |
| 依赖漂移（SDK/zod） | 启动报错 | semver 锁定 + 每次发布前跑五套测试 |

## 变更控制

- 五套测试全绿才提交；文档（README / AGENTS / DESIGN / PLAN / REPO_MAP）与代码同一提交。
- 结果契约（DESIGN §4）与「启动永不失败」（§5.1）是红线。
- 唯一允许的环境变量是 `GITBASH_MCP_RISKY`。