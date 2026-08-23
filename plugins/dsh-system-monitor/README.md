# dsh-system-monitor

非官方 DSH 插件：在 Web 客户端最底栏添加系统监控信息。

## 显示内容

- **CPU**：温度、占用率、功耗（瓦）
- **GPU**：温度、占用率、功耗（瓦）、显存 `xxG/xxG`、显存频率（MHz）
- **内存**：占用百分比、`xxG/xxG`

## 安装

在 DSH profile（例如 `web`）中安装：

```bash
dsh plugin --profile web add link:../plugins/dsh-system-monitor
```

或者手动方式：

1. 把 `dsh-system-monitor` 目录加进 profile 的依赖（`link:` 指向本目录）。
2. 把 `cordis.yml` 的内容合并进 `cordis.patch.yml`。
3. 重启 DSH Web。

## 兼容性

- 已移除版本验证，不再因版本不匹配禁用插件。
- 默认状态为关闭。
- 用户在设置页打开后会立即同步刷新 UI 并显示监控栏。
- 浏览器半区使用 `ctx.slots.inject` 动态 hook 注册，目标插槽不存在时不会硬注册，避免不兼容版本下页面崩溃。

## 文件说明

- `lib/index.js`：主机半区，注册 `/api/system-monitor` 只读路由。
  - Windows 使用 `Get-Counter` 读取 CPU 占用、热区温度和 RAPL 功耗。
  - 使用 `nvidia-smi` 读取 NVIDIA GPU 温度、占用、功耗、显存和显存频率。
  - 内存使用 Node `os`。
- `lib/client.js`：浏览器半区，注册进 `conversation.composer.dock`，嵌入会话输入区下方的统计带。
- `cordis.yml`：patch-layer 插件注册行。

## 卸载

```bash
dsh plugin --profile web remove dsh-system-monitor
```

重启 DSH 后生效。

## 平台说明

- CPU / 内存：Windows 已支持；无对应性能计数器时显示 `--`。
- GPU：目前支持 NVIDIA `nvidia-smi`；没有检测到 GPU 时不显示 GPU 段。
