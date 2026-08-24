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

本插件在 dsh 启动时应用多组补丁：

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

### 3. dsh-passwords 客户端 / 状态补丁

对 `dsh-passwords` 再打三组补丁（同样幂等、可回退）：

- **深色模式（`dist/client.js`）**：dsh-passwords 设置卡片 CSS 把状态胶囊、头像/按钮对比色、开关轨道、输入框 hover/focus 都写死为浅色。dsh 的主题呈现器在深色时给 `body` 打 `data-ds-dark-theme`，本插件在卡片 CSS 末尾追加一组 `body[data-ds-dark-theme]` 覆盖，让这些固定浅色随主题适配，其余 token 驱动的颜色不动。
- **`/patch/status` 发现（`dist/patch.js`）**：dsh-passwords 的 `findDshRoot()` 只查 `npm root -g`、`cwd` 向上与 `/usr/local`，桌面版（dsh 包提升到 dsh home / profile 的 `node_modules`）找不到 dsh 根，于是 `/api/dsh-passwords/patch/status` 返回 `null`，卡片显示"状态未知"。本插件给 `findDshRoot()` 追加 dsh home / `profiles` 扫描，使其在桌面布局下也能找到 dsh 根、返回真实补丁状态。
- **"全部禁用"保存（`dist/gateway.js`）**：工作区开关把所有工作区关掉时客户端发 `allowedFolders: ['__deny__']`（dsh-passwords 的"全部禁用"哨兵），但 `/gateway/api/permissions` 的校验把 `__deny__` 当非法路径拒绝，导致保存返回 400、权限草稿回退。本插件给该校验豁免 `__deny__` 哨兵，使"禁用全部工作区"能保存。

> 说明：`/patch/status` 现在会返回真实状态（例如 dsh-passwords 自己的侧栏搜索子补丁未打时显示"未生效"）。要让该卡显示"已生效"，还需 dsh-passwords 的 workspaceSearch 补丁也被应用——那属于 dsh-passwords 自身的另一组补丁，不在本插件范围。

### 4. dsh-comfyui 媒体地址 / dsh-qqchat 下载基准地址补丁

这一组补丁让 ComfyUI 生成的媒体在聊天里能用"你实际访问的地址"加载，而不是固定回环 `127.0.0.1`：

- **dsh-comfyui 媒体地址三段探测**：原 `proxyBase()` 用 `hostHint.origin()`（`external ?? loopback`）选地址，回环请求（服务端工具调用）会把外部/局域网/公网地址顶掉，且从不校验可达性，导致生成的媒体链接固定成 `http://127.0.0.1:3080`（远程浏览器加载失败）。本补丁：
  - 重写 `lib/host-hint.js`：把浏览器实际访问地址（`x-forwarded-host/proto/port`、非回环 `Host`/`Referer`）与回环分开记录，新增 `externalOrigin()` / `probeCandidates()` / `resolveMediaBase()`；无可信浏览器地址时，对局域网 IPv4 → 回环做**可达性探测**（`/comfyui/ping`）+ 短缓存，回环仅在兜底使用。
  - `lib/index.js`：`proxyBase()` 改为 `async` 并调用 `resolveMediaBase(ws.port)`，去掉 `detectLanOrigin` 导入，sweep 路径 `await`。
  - `lib/tools.js` / `lib/routes.js`：`proxyBase()` 调用点改为 `await`。
  - `client/client.js`：给卡片 / 放大图加 `mediaSrc()`，取图地址若是回环（`127.0.0.1`/`localhost` 等）则自动改用浏览器当前用的 origin，确保图片在你打开页面的任意地址（回环 / 局域网 / 公网）都能显示，无需在消息里塞多条地址。
  - `lib/progress.js` / `lib/comfyui.js` / `lib/tools.js` / `lib/index.js`：把 LLM（TextGenerate/Qwen）生成的提示词通过 WebSocket `executed` 事件 + 历史图**回传到检测结果**（`comfyui_run`/`comfyui_workflow` 的结果里多一个 `prompt` 字段），这样随机生图时 QQ / web 都能看到实际用到的提示词（`comfyui-prompt-*` 命令，见下）。
- **dsh-qqchat 取图临时 token 绕过**：`qqchat_send_image` 下载 http(s) 图片时原样 `fetch(URL)`。若 URL 是 ComfyUI 媒体且在公网 origin 上，会落在 dsh-passwords 登录页后面，服务端 fetch 被 302 到 `/gateway/login`，结果把登录页 HTML 当作图片上传。本补丁在 `lib/media/send-tool.js` 注入 `resolveComfyuiMediaUrl()`，给这类 URL **追加一个短时的签名 `?token=`**（HMAC-SHA256，密钥取自环境变量 `DSH_GATEWAY_MEDIA_TOKEN_SECRET`，仅 5 分钟有效、且只对签发时的精确路径生效）；网关侧同时被补丁为接受该 token（`GET`/`HEAD` 可直接放行），于是取图能绕过登录页。`DSH_GATEWAY_MEDIA_TOKEN_SECRET` 未设置时，插件自动禁用该绕过（URL 原样返回）。

两类补丁与既有补丁相同——**锚点匹配原内容 → 替换改进内容 + 幂等标记 → 备份 + sha256 清单 → 可回滚**；目标插件未安装时自然 `missing/0`，不报错。

> 相关配置：qqchat 取图的临时 token 绕过需要设置共享密钥环境变量 `DSH_GATEWAY_MEDIA_TOKEN_SECRET`（dsh 主机侧与网关进程都会读取；用它生成并校验 token）。未设置时该绕过自动停用。comfyui 面板的"媒体访问地址"（`mediaHost`）仍优先于任何自动探测。注意 `?token=` 会出现在被代理请求的 URL 里，请勿在日志/分享场景泄露。


## 安装

本插件作为 DSH 的 patch-layer bundle 提供。用 dsh 插件命令直接把它加入 profile（以 `web` 为例，指向本目录的**绝对路径**）：

```bash
# 把它作为插件加入 dsh profile（web 为例）
dsh plugin --profile web add <本目录绝对路径>

# 可选的"现在立刻全打一次"（dsh 启动时也会自动打，二者取其一）
scripts\install.bat       # Windows
scripts/install.sh        # Linux/macOS
```

> 说明：`dsh plugin add` 会把它写入 profile 的 `cordis.patch.yml` 与依赖；下次启动 dsh 时插件会自动匹配并给所有 bundle 拷贝打补丁（幂等）。`install.bat/sh` 只是"立即打一次"的快捷路径，正在运行的 dsh 仍建议重启一次以加载宿主侧改动。

或者手动方式：把 `cordis.yml` 的 contents 合并进 `~/.dsh/profiles/web/cordis.patch.yml`，并在 profile 依赖里加入 `dsh-remote-settings`。

> dsh-passwords 等网关类插件也可以把 `dsh-remote-settings` 声明为自己的依赖，从而自动带上本修复，无需各自重新实现。

启动 dsh 时插件会**自动匹配并给所有可能的 bundle 拷贝打补丁**（幂等）：它用 `clientModules.clientPath` 拿到被服务的那个文件，并据此扫描 `node_modules`、`packages/*` 源码目录、以及 `harness-versions` 下的**每一个版本快照**，全部一次处理——这样 dsh 升级切换到别的快照/树也不会漏。日志会显示 `[dsh-remote-settings] all copies: N applied, M unchanged / X found`。

> 也就是说：你只需安装 + 重启 dsh，它会**自动"全打一遍"**，不需要手动 `--dir`、不需要逐棵树操作。

## 使用 / 卸载

插件启动后自动打补丁（包括 Remote Settings、Gateway、dsh-passwords 客户端/状态、dsh-comfyui 媒体地址与 dsh-qqchat 下载基准等补丁组）。也可用 CLI 检查/应用/恢复（`status`/`patch` 都**作用于所有拷贝**）：

```bash
# 查看已匹配到的所有拷贝及各自状态（自动识别，无需 --dir）
# 同时显示 remote-settings / gateway / dspw-client、dspw-patch、dspw-perms / comfyui / qqchat 各组补丁的状态
dsh-remote-settings status

# 给所有拷贝打补丁（幂等）
# 同时应用上面所有补丁组
dsh-remote-settings patch

# 恢复所有拷贝到原始状态 —— 卸载前执行这一步即可还原原功能
# 同时撤销上面所有补丁组
dsh-remote-settings rollback
```

### 安装脚本（自动识别 + 一次全打 / 取消）

带 **cmd / sh 安装与取消脚本**，`dsh plugin` 安装后运行一次即可自动识别并全打（包括所有补丁组）；卸载前用撤销脚本还原：

```bash
# 安装时自动识别并给所有拷贝打补丁（remote-settings + gateway）
scripts/install.sh        # Linux/macOS
scripts\install.bat       # Windows

# 撤销（还原所有拷贝到原始状态，包括所有补丁组）
scripts/undo.sh           # Linux/macOS
scripts\undo.bat          # Windows
```

> 也可以直接用 `node lib/install.js patch|undo|status`（内部同样自动识别、作用于所有拷贝，包括上面所有补丁组）。
> 如果只想操作特定补丁，可使用 `gateway-patch|gateway-undo|gateway-status`、`dspw-client-patch|dspw-client-undo|dspw-client-status`、`dspw-patch-patch|dspw-patch-undo|dspw-patch-status`、`dspw-perms-patch|dspw-perms-undo|dspw-perms-status`、`comfyui-patch|comfyui-undo|comfyui-status`、`comfyui-prompt-patch|comfyui-prompt-undo|comfyui-prompt-status`、`qqchat-patch|qqchat-undo|qqchat-status` 命令。
> 包还声明了 `postinstall`（`node lib/install.js patch`），在 `pnpm add` 运行该包生命周期脚本时（需在 profile 的 `pnpm-workspace.yaml` 把此包加入 `allowBuilds`，pnpm 10+ 默认拦截脚本）会自动打一次。

> **卸载恢复**：DSH 插件没有"卸载回调"，所以卸载时先运行 `dsh-remote-settings rollback`（或 `scripts/undo.*`）（会把每个打过补丁的拷贝用备份还原成原始 bundle，包括上面所有补丁组），再 `dsh plugin --profile web remove dsh-remote-settings`，即可完全恢复原功能。

其它插件可以通过服务 `ctx.remoteSettings`（`status()` / `apply()` / `rollback()`）或直接复用 `dsh-remote-settings/patch` 子路径导出的函数来接入。

## 何时需要"重载补丁"

dsh 或 dsh-passwords 升级会覆盖编译后的 bundle。若升级后远程设置又报 `settings are unavailable in this browser` 或权限检查恢复，重启 dsh 即可（插件启动时重新应用全部补丁组）；也可运行 `dsh-remote-settings patch` 一次性重新打上，然后刷新浏览器。

## 兼容性

- 目标匹配基于语义三元，不依赖具体格式；dsh 版本变化后仍能命中。
- 若某个 dsh 版本已**原生支持**远程配置面（bundle 中不再含该三元），`status` 会显示 `enabled`，`patch` 显示 `unchanged`——无需任何动作。

## 许可证

MIT
