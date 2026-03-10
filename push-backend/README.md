# 纯白人生 - 后台推送服务

用于 iOS 等依赖服务端推送的场景，实现真正的后台通知（无需打开应用）。

## 部署步骤

### 1. 安装依赖

```bash
cd push-backend
npm install
```

### 2. 创建 KV 命名空间

```bash
npx wrangler kv namespace create PROACTIVE_KV
```

将输出的 `id` 填入 `wrangler.toml` 中 `[[kv_namespaces]]` 的 `id` 字段。

### 3. 生成 VAPID 密钥

```bash
npm install -g web-push
web-push generate-vapid-keys
```

会输出公钥和私钥，保存备用。

### 4. 配置密钥

```bash
npx wrangler secret put VAPID_PUBLIC_KEY
# 粘贴公钥

npx wrangler secret put VAPID_PRIVATE_KEY
# 粘贴私钥
```

可选：`VAPID_SUBJECT`（如 `mailto:your@email.com`）

### 5. 部署

```bash
npx wrangler deploy
```

部署后会得到 Worker 地址，例如：`https://tabula-proactive-push.xxx.workers.dev`

### 6. 配置游戏

在 `纯白人生.html` 中，找到 `PUSH_SERVER_URL`，填入你的 Worker 地址：

```javascript
var PUSH_SERVER_URL = 'https://tabula-proactive-push.xxx.workers.dev';
```

## 玩家使用说明

- **安卓**：授权通知权限即可，支持 periodicSync 和 Web Push 双通道
- **iOS**：需将游戏「添加到主屏幕」（PWA），再授权通知，才能收到后台推送

玩家无需注册账号，只需系统弹窗授权即可。
