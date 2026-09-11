# gitbash-mcp 项目计划书

## 已完成

| # | 里程碑 | 交付 | 状态 |
|---|---|---|---|
| M0 | 设计定稿 | DESIGN / PLAN / AGENTS | 完成 |
| M1 | 骨架 + 核心 exec | server.js + 冒烟测试 | 完成 |
| M2 | 健壮性 | 超时整树杀 / 截断+spill / UTF-8 / 错误契约 | 完成 |
| M3 | 部署脚本 | install/uninstall（后因改用其他注册方式而废弃） | 完成 |
| M4 | 真机验证 | DSH 面板注册，工具实际可用 | 完成 |
| M5 | 友好性 | 惰性检测 + `BASH_NOT_FOUND` + `doctor` | 完成 |
| M6 | npm 就绪 | bin / files / engines / license | 完成 |
| M7 | 交互式安装器 | `gitbash-mcp init/uninstall/doctor` + 多客户端菜单；`npm pack` = 8 文件 12.3KB | 完成 |

## 待办

### M7：交互式安装器（`gitbash-mcp init`）

纯 JS、零新增依赖（`node:readline`）。流程：探测已安装的 agent → 多选菜单 → 预览 diff → 备份后写入 → 提示重启。

| 客户端 | 写入位置 |
|---|---|
| DSH | `$DSH_HOME/cordis.patch.yml`，或提示用面板 |
| Claude Code | `~/.claude.json` 的 `mcpServers` |
| Codex CLI | `~/.codex/config.toml` 的 `[mcp_servers.gitbash]` |
| Claude Desktop | `%APPDATA%/Claude/claude_desktop_config.json` |
| Cursor / VS Code | `~/.cursor/mcp.json` / `.vscode/mcp.json` |
| 兜底 | 打印 JSON/TOML 片段供手动粘贴 |

预估 2–3 小时。验收：写入幂等、失败可回滚（备份）、无 agent 时给出手动片段。

### M8：发布到 npm

1. `npm login`（用户操作）
2. `npm version minor`（含 M7 后发布 2.2.0）
3. `npm publish`
4. `npm i -g gitbash-mcp` 验证
5. 把 DSH 面板从旧 exe 路径改为 `gitbash-mcp`；验证通过后删除残留 exe

### M9：文档终审

对齐 README / DESIGN / PLAN / AGENTS / NPM_PUBLISH；初始化 git 仓库并首次提交。

## 风险登记表

| 风险 | 影响 | 缓解 |
|---|---|---|
| 找不到 bash | 工具不可用 | 服务不崩；`BASH_NOT_FOUND` + `doctor` 给修复步骤 |
| MSYS2 子进程残留 | 超时后占资源 | `taskkill /T /F` 整树 |
| 输出编码 | 中文乱码 | UTF-8 解码；实测中文正常 |
| npm 包名被占用 | 无法发布 | 已核实未占用；若被占改用 scope + `--access public` |
| 旧 exe 残留 | 面板指向失效路径 | 切换注册后再删（当前被运行中的进程锁定） |
| 依赖漂移（SDK/zod） | 启动报错 | semver 锁定 + 发布前跑冒烟 |

## 变更控制

- 验收未过不进下一步；文档与代码同一提交。
- 结果契约（DESIGN §4）与启动永不失败（§5.1）是红线。