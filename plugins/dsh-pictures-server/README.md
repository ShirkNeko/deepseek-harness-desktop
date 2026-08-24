# dsh-pictures-server

DSH 主机半区插件：把 `D:\agent\Pictures` 挂到 DSH Web 入口的 `/pictures/*` 上，使公网反向代理
也能访问生成的图片。

## 背景

DSH Web 监听 `127.0.0.1:3080`，你的公网入口由 `dsh-passwords serve-gateway --upstream
http://127.0.0.1:3080` 转发到该 origin。由于它只转发到 3080 这一个上游（不转发 8642 等其它端口），
要让图片在公网入口可见，就把它挂到 3080 这个 origin 下——即本插件注册的 `/pictures` 前缀路由。

## 安装

```bash
dsh plugin --profile web add link:D:/agent/deepseek-harness-desktop/plugins/dsh-pictures-server
```

会通过 pnpm 装入 `web` profile，并写入 `dsh.profile.bundles`。重启 DSH Web 后生效。

## 使用

图片经 `/pictures/` 前缀访问，例如：

```
https://<domain>/pictures/output/loli_silver_hair_sailor.png
http://127.0.0.1:3080/pictures/output/loli_silver_hair_sailor.png
```

## 配置

- 根目录默认 `D:\agent\Pictures`；可用插件 `config.root` 或环境变量 `PICTURES_DIR` 覆盖。
- 只允许 GET / HEAD，禁止路径穿越（无法跳出根目录）。
- 已设置 `Access-Control-Allow-Origin: *`，容错：`405` / `400` / `403` / `404`。

## 目录

```
dsh-pictures-server/
├── package.json      # dsh.bundle.patch -> ./cordis.yml
├── cordis.yml        # 挂载行
├── lib/index.js      # 主机插件（注册 /pictures 路由）
└── README.md
```
