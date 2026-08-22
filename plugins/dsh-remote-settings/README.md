# dsh-remote-settings

[English](README_en.md) | 简体中文

一个可复用的 DeepSeek Harness (dsh) 插件：为“通过已认证网关远程访问”的浏览器开启配置面（设置 / 插件 / 模型 / 凭据页面），但**不削弱 dsh 主机侧的 `/api` 安全栅栏**。

## 问题背景

dsh 的浏览器端把配置面做了 **loopback only**：
- 浏览器端持久化门：`connection.isLoopback ? "host" : "memory"`（写死在编译后的客户端 bundle 里）。
- 因此任何非回环来源（公网 IP / 局域网地址）都会进入 `memory` 模式，设置镜像 `view: undefined`，页面报 `settings are unavailable in this browser`，插件 / 模型 / 凭据页一起失效。

主机侧 `/api` 栅栏对**特权方法集**（`settings.*`、`credentials.*`、`agentPreset.*`、`host.pickDirectory/openPath`、`llm.discoverModels`）仍然**只接受回环**。`dsh-passwords` 这类网关在转发时把 `Host/Origin` 改写为 `127.0.0.1:3080`，所以经网关的流量能被放行——实现上是“认证层 + 回环改写”。本插件只做**客户端持久化门**这一件事：让已认证/可信网关后面的远程浏览器能使用配置面。

> 安全说明：本插件**没有**把任意远程来源都放行。它只把客户端持久化门强制为 `"host"`。任何**没经过网关**的局域网/公网调用，主机侧 `/api` 栅栏仍会对特权方法返回 403；配置数据只在“经网关（已认证）”的路径上暴露。所以 dsh 的安全方式保持不变。

## 工作原理

dsh 客户端持久化门写死在编译后的 bundle 里，DSH 没有给插件留下“打开配置面”的口子。因此本插件在 dsh 启动时，对编译后的 `@deepseek-ai/dsh-client-ui-settings/lib/client.js` 做一次**按语义匹配、对版本健壮**的补丁：

```js
// 命中（任意空白/引号风格）：
connection.isLoopback ? "host" : "memory"
// 替换为：
"host"
```

- **语义正则**匹配 `connection.isLoopback ? "host" : "memory"`（容忍任意空白与单/双引号），因此 dsh 换了压缩器、改换行、改缩进都不会失配。**这是唯一需要跨 dsh 版本存活的东西。**
- 用 `split/replace` 全量替换，覆盖 dsh 中**两处**该三元（`SettingsScopeController` 与 `SettingsDescribeMirror`）。
- 保留**原文件备份 + sha256 哈希元数据**，`rollback` 永远不会把另一个 dsh 版本的文件恢复回来。

## 安装

本插件作为 DSH 的 patch-layer bundle 提供。把它加入 dsh profile（以 `web` 为例），用 `link:` 指向本目录：

```bash
# 在 dsh profile 里注册（等价于把 link:<本目录> 加入 package.json 依赖 + dsh.profile.bundles）
# 然后：
pnpm install
```

或者手动方式：把 `cordis.yml` 的 contents 合并进 `~/.dsh/profiles/web/cordis.patch.yml`，并在 profile 依赖里加入 `dsh-remote-settings`。

> dsh-passwords 等网关类插件也可以把 `dsh-remote-settings` 声明为自己的依赖，从而自动带上本修复，无需各自重新实现。

启动 dsh 时插件会自动应用补丁（幂等）。日志会显示 `[dsh-remote-settings] applied/unchanged`。

## 使用

插件启动后自动打补丁。也可用 CLI 手动检查/应用/回滚：

```bash
# 查看当前配置面是否已开启
dsh-remote-settings status

# 手动应用补丁（幂等）
dsh-remote-settings patch

# 回滚到原始 bundle
dsh-remote-settings rollback

# 目标包/文件可通过参数覆盖；--dir 额外指定解析锚点
dsh-remote-settings status --package @deepseek-ai/dsh-client-ui-settings --file lib/client.js --dir /path/to/dsh
```

其它插件可以通过服务 `ctx.remoteSettings`（`status()` / `apply()` / `rollback()`）或直接复用 `dsh-remote-settings/patch` 子路径导出的函数来接入。

## 何时需要“重载补丁”

dsh 升级会覆盖编译后的 bundle。若升级后远程设置又报 `settings are unavailable in this browser`，重启 dsh 即可（插件启动时重新应用）；也可运行 `dsh-remote-settings patch` 一次性重新打上，然后刷新浏览器。

## 兼容性

- 目标匹配基于语义三元，不依赖具体格式；dsh 版本变化后仍能命中。
- 若某个 dsh 版本已**原生支持**远程配置面（bundle 中不再含该三元），`status` 会显示 `enabled`，`patch` 显示 `unchanged`——无需任何动作。

## 许可证

MIT
