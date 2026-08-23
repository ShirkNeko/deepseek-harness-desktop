# dsh-remote-settings

[English](README_en.md) | 简体中文

一个可复用的 DeepSeek Harness (dsh) 插件：为"通过已认证网关远程访问"的浏览器开启配置面（设置 / 插件 / 模型 / 凭据页面），并允许 owner/admin 角色绕过下载白名单限制，但**不削弱 dsh 主机侧的 `/api` 安全栅栏**。

## 问题背景

dsh 的浏览器端把配置面做了 **loopback only**：
- 浏览器端持久化门：`connection.isLoopback ? "host" : "memory"`（写死在编译后的客户端 bundle 里）。
- 因此任何非回环来源（公网 IP / 局域网地址）都会进入 `memory` 模式，设置镜像 `view: undefined`，页面报 `settings are unavailable in this browser`，插件 / 模型 / 凭据页一起失效。

主机侧 `/api` 栅栏对**特权方法集**（`settings.*`、`credentials.*`、`agentPreset.*`、`host.pickDirectory/openPath`、`llm.discoverModels`）仍然**只接受回环**。`dsh-passwords` 这类网关在转发时把 `Host/Origin` 改写为 dsh 实际监听的回环地址（`127.0.0.1`，端口随 dsh 配置/`webServer.port` 变化，**非固定 3080**），所以经网关的流量能被放行——实现上是"认证层 + 回环改写"。本插件只做**客户端持久化门**这一件事：让已认证/可信网关后面的远程浏览器能使用配置面。

> 安全说明：本插件**没有**把任意远程来源都放行。它只把客户端持久化门强制为 `"host"`。任何**没经过网关**的局域网/公网调用，主机侧 `/api` 栅栏仍会对特权方法返回 403；配置数据只在"经网关（已认证）"的路径上暴露。所以 dsh 的安全方式保持不变。

## 工作原理

本插件在 dsh 启动时应用两个补丁：

### 1. Remote Settings 补丁

dsh 客户端持久化门写死在编译后的 bundle 里，DSH 没有给插件留下"打开配置面"的口子。因此本插件对编译后的 `@deepseek-ai/dsh-client-ui-settings/lib/client.js` 做一次**按语义匹配、对版本健壮**的补丁：

```js
// 命中（任意空白/引号风格）：
connection.isLoopback ? "host" : "memory"
// 替换为：
"host"
```

### 2. Gateway 补丁

对 `dsh-passwords` 包的 `dist/gateway.js` 应用补丁，允许 owner/admin 角色绕过下载文件夹白名单检查：

```js
// 命中：
if (!folderAllowed(real, perms.allowed_folders)) {
// 替换为：
if (me.role !== 'admin' && !folderAllowed(real, perms.allowed_folders)) {
```

**补丁特性：**

- **语义正则**匹配，容忍任意空白与单/双引号，因此 dsh 换了压缩器、改换行、改缩进都不会失配。**这是唯一需要跨 dsh 版本存活的东西。**
- Remote Settings 补丁覆盖 dsh 中**两处**该三元（`SettingsScopeController` 与 `SettingsDescribeMirror`）。
- **精确定位被服务的 bundle**：插件通过 `ctx.clientModules.clientPath(pkg)` 拿到 dsh 实际对外提供的那个客户端 bundle 文件路径（与浏览器插件名录同源解析），再对该文件直接打补丁，因此无论是 `node_modules` 安装还是 `packages/*` 源码快照（如 `harness-versions`）都能命中；`clientModules` 不可用时回退到 `node_modules` / `packages` 扫描。
- 保留**原文件备份 + sha256 哈希元数据**，`rollback` 永远不会把另一个版本的文件恢复回来。
- Gateway 补丁自动扫描所有 `dsh-passwords` 副本并应用权限绕过补丁。

## 安装

本插件作为 DSH 的 patch-layer bundle 提供。把它加入 dsh profile（以 `web` 为例），用 `link:` 指向本目录：

```bash
# 在 dsh profile 里注册（等价于把 link:<本目录> 加入 package.json 依赖 + dsh.profile.bundles）
# 然后：
pnpm install
```

或者手动方式：把 `cordis.yml` 的 contents 合并进 `~/.dsh/profiles/web/cordis.patch.yml`，并在 profile 依赖里加入 `dsh-remote-settings`。

> dsh-passwords 等网关类插件也可以把 `dsh-remote-settings` 声明为自己的依赖，从而自动带上本修复，无需各自重新实现。

启动 dsh 时插件会**自动匹配并给所有可能的 bundle 拷贝打补丁**（幂等）：它用 `clientModules.clientPath` 拿到被服务的那个文件，并据此扫描 `node_modules`、`packages/*` 源码目录、以及 `harness-versions` 下的**每一个版本快照**，全部一次处理——这样 dsh 升级切换到别的快照/树也不会漏。日志会显示 `[dsh-remote-settings] all copies: N applied, M unchanged / X found`。

> 也就是说：你只需安装 + 重启 dsh，它会**自动"全打一遍"**，不需要手动 `--dir`、不需要逐棵树操作。

## 使用 / 卸载

插件启动后自动打补丁（包括 Remote Settings 和 Gateway 两个补丁）。也可用 CLI 检查/应用/恢复（`status`/`patch` 都**作用于所有拷贝**）：

```bash
# 查看已匹配到的所有拷贝及各自状态（自动识别，无需 --dir）
# 同时显示 remote-settings 和 gateway 两个补丁的状态
dsh-remote-settings status

# 给所有拷贝打补丁（幂等）
# 同时应用 remote-settings 和 gateway 两个补丁
dsh-remote-settings patch

# 恢复所有拷贝到原始状态 —— 卸载前执行这一步即可还原原功能
# 同时撤销 remote-settings 和 gateway 两个补丁
dsh-remote-settings rollback
```

### 安装脚本（自动识别 + 一次全打 / 取消）

带 **cmd / sh 安装与取消脚本**，`dsh plugin` 安装后运行一次即可自动识别并全打（包括两个补丁）；卸载前用撤销脚本还原：

```bash
# 安装时自动识别并给所有拷贝打补丁（remote-settings + gateway）
scripts/install.sh        # Linux/macOS
scripts\install.bat       # Windows

# 撤销（还原所有拷贝到原始状态，包括两个补丁）
scripts/undo.sh           # Linux/macOS
scripts\undo.bat          # Windows
```

> 也可以直接用 `node lib/install.js patch|undo|status`（内部同样自动识别、作用于所有拷贝，包括两个补丁）。
> 如果只想操作特定补丁，可使用 `gateway-patch|gateway-undo|gateway-status` 命令。
> 包还声明了 `postinstall`（`node lib/install.js patch`），在 `pnpm add` 运行该包生命周期脚本时（需在 profile 的 `pnpm-workspace.yaml` 把此包加入 `allowBuilds`，pnpm 10+ 默认拦截脚本）会自动打一次。

> **卸载恢复**：DSH 插件没有"卸载回调"，所以卸载时先运行 `dsh-remote-settings rollback`（或 `scripts/undo.*`）（会把每个打过补丁的拷贝用备份还原成原始 bundle，包括两个补丁），再 `dsh plugin --profile web remove dsh-remote-settings`，即可完全恢复原功能。

其它插件可以通过服务 `ctx.remoteSettings`（`status()` / `apply()` / `rollback()`）或直接复用 `dsh-remote-settings/patch` 子路径导出的函数来接入。

## 何时需要"重载补丁"

dsh 或 dsh-passwords 升级会覆盖编译后的 bundle。若升级后远程设置又报 `settings are unavailable in this browser` 或权限检查恢复，重启 dsh 即可（插件启动时重新应用两个补丁）；也可运行 `dsh-remote-settings patch` 一次性重新打上，然后刷新浏览器。

## 兼容性

- 目标匹配基于语义三元，不依赖具体格式；dsh 版本变化后仍能命中。
- 若某个 dsh 版本已**原生支持**远程配置面（bundle 中不再含该三元），`status` 会显示 `enabled`，`patch` 显示 `unchanged`——无需任何动作。

## 许可证

MIT
