# 纯白人生 - 自托管推送服务

替代 Cloudflare Workers，部署到你自己的香港服务器，**国内用户无需梯子**即可使用后台主动回复。

## 快速开始

```bash
npm install
npm run generate-vapid   # 复制输出的密钥
cp .env.example .env    # 编辑 .env，填入 VAPID 密钥
npm start
```

## 详细部署

请阅读 [香港服务器部署教程.md](./香港服务器部署教程.md)。

## 修改游戏配置

部署完成后，在 `index.html` 中修改：

```javascript
var PUSH_SERVER_URL = 'https://你的推送服务地址';
var PUSH_SERVER_URL_CN = '';  // 若主地址国内可访问，可留空
```
