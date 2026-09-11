# 发布到 npm（gitbash-mcp）

本文档是操作手册：从零把本仓库发布到 npm，并让用户用一条命令全局安装。

## 0. 前置条件

| 项 | 状态 |
|---|---|
| 包名 `gitbash-mcp` | 已确认可用（registry 返回 404，未被占用） |
| Node.js | >= 18（`node --version`） |
| npm 账号 | 需要自己注册：https://www.npmjs.com/signup |
| 本机登录 | `npm login`（会打开浏览器或要求 OTP） |

## 1. 发布前自检（不产生任何后果）

在仓库根目录执行：

~~~powershell
npm pack --dry-run
~~~

预期输出（当前已实测）：

~~~
package: gitbash-mcp@2.2.0
Tarball Contents: LICENSE, README.md, package.json, server.js, bin/gitbash-mcp.js,
                 lib/cli.js, lib/detect.js, lib/menu.js, lib/runner.js, lib/theme.js
total files: 10
package size: 15.6 kB
unpacked size: 41.6 kB
~~~

如果出现 `gitbash-mcp.exe`、`node_modules`、`docs`、`test-*.mjs`，说明 `package.json` 的 `files` 白名单被改坏了。

## 2. 登录 npm

~~~powershell
npm login          # 输入用户名 / 密码 / 邮箱 / 一次性验证码
npm whoami         # 应该打印你的用户名
~~~

已开启 2FA 的账号：`npm publish` 时会要求输入 OTP。

## 3. 定版本号

~~~powershell
npm version patch   # 2.1.0 -> 2.1.1（修 bug）
npm version minor   # 2.1.0 -> 2.2.0（加功能）
npm version major   # 2.1.0 -> 3.0.0（破坏性变更）
~~~

这条命令会改 `package.json` 并自动打一个 git tag（若仓库已初始化）。

## 4. 发布

~~~powershell
npm publish
~~~

看到 `+ gitbash-mcp@2.1.0` 即成功。

## 5. 验证

~~~powershell
npm view gitbash-mcp version           # 应显示刚发布的版本
npm i -g gitbash-mcp                   # 全局安装
gitbash-mcp --help 2>$null; doctor     # 通过 MCP 客户端调用 doctor
~~~

> 直连调试：`node <全局路径>/gitbash-mcp/server.js` 走 stdio，不接终端；用 `node test-client.mjs` 验证更直观。

## 6. 之后如何更新

1. 改代码
2. `npm version patch`（或 minor/major）
3. `npm publish`

用户侧升级：`npm i -g gitbash-mcp@latest`。

## 7. 想先本地实测（不发布）

在仓库根目录：

~~~powershell
npm i -g .        # 把当前目录作为包全局安装
~~~

效果与从 registry 安装一致，之后可以随时用 `npm i -g gitbash-mcp@latest` 覆盖。

## 8. 撤回 / 弃用

| 目的 | 命令 | 限制 |
|---|---|---|
| 72 小时内撤回 | `npm unpublish gitbash-mcp@2.1.0` | 发布超过 72 小时、或已被依赖则不允许 |
| 标记弃用 | `npm deprecate gitbash-mcp@2.1.0 "reason"` | 推荐，温和且可逆 |
| 整包撤回 | `npm unpublish gitbash-mcp --force` | 有严格限制，慎用 |

## 9. 常见坑

- **名字被占用**：发布前先 `npm view gitbash-mcp`，404 才可用。若将来被占用，改用 scope：把 `name` 改成 `@你的用户名/gitbash-mcp`，然后 `npm publish --access public`。
- **`private: true`**：会直接拒绝发布。本仓库已移除。
- **`bin` 未生效**：必须是 `'server.js'` 且首行有 `#!/usr/bin/env node`（已就绪）。
- **代理/镜像**：公司网络常见 `npm config get registry` 指向镜像，镜像只读，发布要切回 `https://registry.npmjs.org/`。
- **首次发布收不到确认邮件**：不影响发布成功，`npm view` 能查到即可。

## 10. 发布后用户怎么用

~~~powershell
npm i -g gitbash-mcp
~~~

然后在 MCP 客户端里把命令写成全局命令名：

| 客户端 | 配置 |
|---|---|
| DSH | 面板新增 MCP：名称 `gitbash`，命令 `gitbash-mcp`，参数留空 |
| Claude Code | `claude mcp add gitbash -- gitbash-mcp` |
| Codex CLI | `~/.codex/config.toml` 里加 `[mcp_servers.gitbash]` + `command = "gitbash-mcp"` |
| 通用 JSON | `{ "mcpServers": { "gitbash": { "command": "gitbash-mcp", "args": [] } } }` |

> Windows 上 `.cmd` shim 能被 MCP 客户端的 `cross-spawn` 正确解析（已核实），所以直接写 `gitbash-mcp` 即可，不需要 `cmd /c`。