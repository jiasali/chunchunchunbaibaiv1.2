/**
 * 定时任务：每分钟检查并发送主动回复推送
 * 可用系统 cron 或 node-cron 调用
 */
import 'dotenv/config';
import webPush from 'web-push';
import * as storage from './storage.js';

function getRealTimeContextText() {
  try {
    const now = new Date();
    const week = ['日', '一', '二', '三', '四', '五', '六'];
    const pad2 = (n) => String(n).padStart(2, '0');
    const y = now.getUTCFullYear();
    const mo = pad2(now.getUTCMonth() + 1);
    const d = pad2(now.getUTCDate());
    const hh = pad2(now.getUTCHours());
    const mm = pad2(now.getUTCMinutes());
    const ss = pad2(now.getUTCSeconds());
    return '【当前现实时间（UTC）】\n' +
      (y + '-' + mo + '-' + d + ' 周' + week[now.getUTCDay()] + ' ' + hh + ':' + mm + ':' + ss + ' UTC') +
      '\n（请严格根据这个现实时间判断：现在是清晨/上午/中午/下午/傍晚/晚上/深夜，并据此写台词与语气。）\n';
  } catch (e) {
    return '';
  }
}

function getNowHHMM() {
  try {
    const now = new Date();
    const pad2 = (n) => String(n).padStart(2, '0');
    return pad2(now.getUTCHours()) + ':' + pad2(now.getUTCMinutes());
  } catch (e) {
    return '';
  }
}

async function runScheduled() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    console.log('VAPID not configured, skip');
    return;
  }
  webPush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    publicKey,
    privateKey
  );
  const GAME_ORIGIN = process.env.GAME_ORIGIN || 'https://example.github.io';
  const listResult = await storage.list('rel:');
  const now = Date.now();
  const keys = listResult.keys || [];
  for (const keyName of keys) {
    if (!keyName.startsWith('rel:')) continue;
    const val = await storage.get(keyName);
    if (!val) continue;
    let item;
    try {
      item = JSON.parse(val);
    } catch {
      continue;
    }
    const intervalMs = (item.proactiveReplyIntervalHours || 1) * 60 * 60 * 1000;
    if (now - (item.lastProactiveAt || 0) < intervalMs) continue;
    const api = item.api || {};
    if (!api.endpoint || !api.key) continue;
    let replyText = '';
    try {
      let endpoint = (api.endpoint || '').trim().replace(/\/$/, '');
      if (!endpoint.endsWith('/chat/completions')) endpoint += '/chat/completions';
      const timeCtx = getRealTimeContextText();
      const userContent = '【重要】你已经隔了 ' + (item.proactiveReplyIntervalHours || 1) + ' 小时没有和对方联系。请根据你的人设、与对方的聊天记录，主动发起一条自然的问候或关心。可以表达想念或关心，但不要刻意说「现在几点了」「都X点了」等具体时间。只输出一个 JSON 对象：{"reply":["你说的话"]}。\n\n' + timeCtx + '\n【聊天记录】\n' + (Array.isArray(item.historyLines) ? item.historyLines.join('\n') : '（暂无记录）') + (item.worldPresetBlock || '') + (item.playerProfileBlock || '');
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (api.key || '') },
        body: JSON.stringify({
          model: api.model || 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: '你是「' + (item.name || 'TA') + '」。你的设定如下：\n' + (item.charInfo || '') + '\n\n请以该角色身份，主动给玩家发一条消息。' },
            { role: 'user', content: userContent },
          ],
          temperature: typeof api.temperature === 'number' ? api.temperature : 0.85,
        }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      let content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) ? data.choices[0].message.content.trim() : '';
      if (!content) continue;
      content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      try {
        const p = JSON.parse(content);
        replyText = Array.isArray(p.reply) ? p.reply.join('') : (p.reply || content);
      } catch {
        replyText = content;
      }
    } catch {
      continue;
    }
    if (!replyText) continue;
    const parts = keyName.split(':');
    const subKey = parts.length >= 2 ? parts[1] : '';
    const subVal = await storage.get('sub:' + subKey);
    if (!subVal) continue;
    let sub;
    try {
      sub = JSON.parse(subVal);
    } catch {
      continue;
    }
    if (!sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) continue;
    const appUrl = (item.origin && item.origin.startsWith('http')) ? item.origin : GAME_ORIGIN;
    const hhmm = getNowHHMM();
    const baseBody = replyText.slice(0, 100) + (replyText.length > 100 ? '...' : '');
    const body = (hhmm ? ('[' + hhmm + '] ') : '') + baseBody;
    const payload = JSON.stringify({
      title: item.name || 'TA',
      body: body,
      icon: item.iconUrl || undefined,
      tag: 'proactive-' + item.relationId,
      data: { relationId: item.relationId, url: appUrl },
    });
    let pushOk = false;
    try {
      await webPush.sendNotification(sub, payload);
      pushOk = true;
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        await storage.del(keyName);
      }
      console.error('Push failed:', e.message);
    }
    if (!pushOk) continue;
    item.lastProactiveAt = now;
    await storage.put(keyName, JSON.stringify(item));
  }
}

export { runScheduled };

// 直接运行 cron.js 时执行一次后退出（可用于系统 crontab）
const isMain = process.argv[1] && process.argv[1].endsWith('cron.js');
if (isMain) {
  runScheduled().then(() => process.exit(0)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
