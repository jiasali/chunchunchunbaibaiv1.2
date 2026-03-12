/**
 * 纯白人生 - 后台主动回复推送服务
 * 部署到 Cloudflare Workers，用于 iOS 等依赖服务端推送的场景
 *
 * 部署前：
 * 1. npm install
 * 2. npx wrangler kv namespace create PROACTIVE_KV
 * 3. 将返回的 id 填入 wrangler.toml 的 [[kv_namespaces]] id
 * 4. wrangler secret put VAPID_PUBLIC_KEY 和 VAPID_PRIVATE_KEY
 *    (可用 npx web-push generate-vapid-keys 生成，或 npx @block65/webcrypto-web-push 等)
 */
import { buildPushPayload } from '@block65/webcrypto-web-push';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

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

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';

    if (path === '/vapid-public') {
      const pub = env.VAPID_PUBLIC_KEY;
      if (!pub) return jsonResp({ error: 'VAPID not configured' }, 500);
      return jsonResp({ publicKey: pub });
    }

    if (path === '/api/status' && request.method === 'GET') {
      const vapidOk = !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
      let relationCount = 0;
      try {
        const list = await env.PROACTIVE_KV.list({ prefix: 'rel:' });
        relationCount = (list.keys || []).length;
      } catch (_) {}
      return jsonResp({ ok: true, vapidConfigured: vapidOk, relationCount });
    }

    if (path.startsWith('/icon/')) {
      let id = '';
      try { id = decodeURIComponent(path.slice(6)); } catch (_) { id = path.slice(6); }
      if (!id) return new Response('Not Found', { status: 404 });
      const val = await env.PROACTIVE_KV.get('icon:' + id);
      if (!val) return new Response('Not Found', { status: 404 });
      const match = val.match(/^data:([^;]+);base64,(.+)$/);
      const body = match ? atob(match[2]) : val;
      const mime = match ? match[1] : 'image/png';
      const bytes = new Uint8Array(body.length);
      for (let i = 0; i < body.length; i++) bytes[i] = body.charCodeAt(i);
      return new Response(bytes, {
        headers: {
          'Content-Type': mime,
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }

    if (path === '/register' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { subscription, relations } = body || {};
        if (!subscription || !subscription.endpoint || !Array.isArray(relations) || !relations.length) {
          return jsonResp({ error: 'Invalid payload' }, 400);
        }
        const subKey = hash(subscription.endpoint);
        const origin = (body.origin && typeof body.origin === 'string') ? body.origin.replace(/\/$/, '') : url.origin;
        for (const rel of relations) {
          const rid = rel.relationId;
          if (!rid) continue;
          const iconId = 'icon_' + subKey + '_' + rid;
          if (rel.avatar && rel.avatar.startsWith('data:')) {
            await env.PROACTIVE_KV.put('icon:' + iconId, rel.avatar, { expirationTtl: 60 * 60 * 24 * 7 });
          }
          const iconUrl = rel.avatar && rel.avatar.startsWith('data:')
            ? url.origin + '/icon/' + encodeURIComponent(iconId)
            : undefined;
          const item = {
            subscription,
            relationId: rid,
            proactiveReplyIntervalHours: rel.proactiveReplyIntervalHours || 1,
            lastProactiveAt: rel.lastProactiveAt || Date.now(),
            name: rel.name || 'TA',
            charInfo: rel.charInfo || '',
            historyLines: rel.historyLines || [],
            worldPresetBlock: rel.worldPresetBlock || '',
            playerProfileBlock: rel.playerProfileBlock || '',
            iconUrl,
            api: rel.api || {},
            origin,
          };
          await env.PROACTIVE_KV.put('rel:' + subKey + ':' + rid, JSON.stringify(item), { expirationTtl: 60 * 60 * 24 * 30 });
        }
        await env.PROACTIVE_KV.put('sub:' + subKey, JSON.stringify(subscription), { expirationTtl: 60 * 60 * 24 * 30 });
        return jsonResp({ ok: true });
      } catch (e) {
        return jsonResp({ error: String(e.message || e) }, 500);
      }
    }

    return jsonResp({ error: 'Not Found' }, 404);
  },

  async scheduled(event, env, ctx) {
    const vapid = {
      subject: env.VAPID_SUBJECT || 'mailto:admin@example.com',
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
    };
    if (!vapid.publicKey || !vapid.privateKey) return;

    const listResult = await env.PROACTIVE_KV.list({ prefix: 'rel:' });
    const now = Date.now();
    const keys = listResult.keys || [];

    for (const k of keys) {
      const keyName = typeof k === 'string' ? k : (k.name || k);
      if (!keyName.startsWith('rel:')) continue;
      const val = await env.PROACTIVE_KV.get(keyName);
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
        const userContent = '【重要】你已经隔了 ' + (item.proactiveReplyIntervalHours || 1) + ' 小时没有和对方联系。请根据你的人设、与对方的聊天记录，主动发起一条自然的问候或关心。只输出一个 JSON 对象：{"reply":["你说的话"]}。\n\n' + timeCtx + '\n【聊天记录】\n' + (Array.isArray(item.historyLines) ? item.historyLines.join('\n') : '（暂无记录）') + (item.worldPresetBlock || '') + (item.playerProfileBlock || '');
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
      const subVal = await env.PROACTIVE_KV.get('sub:' + subKey);
      if (!subVal) continue;
      let sub;
      try {
        sub = JSON.parse(subVal);
      } catch {
        continue;
      }
      if (!sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) continue;

      const appUrl = (item.origin && item.origin.startsWith('http')) ? item.origin : (env.GAME_ORIGIN && env.GAME_ORIGIN !== '*' ? env.GAME_ORIGIN : 'https://example.github.io');
      const hhmm = getNowHHMM();
      const baseBody = replyText.slice(0, 100) + (replyText.length > 100 ? '...' : '');
      const body = (hhmm ? ('[' + hhmm + '] ') : '') + baseBody;
      const payload = {
        data: {
          title: item.name || 'TA',
          body: body,
          icon: item.iconUrl || undefined,
          tag: 'proactive-' + item.relationId,
          data: { relationId: item.relationId, url: appUrl },
        },
        options: { ttl: 60 },
      };

      let pushOk = false;
      try {
        const { headers, method, body } = await buildPushPayload(payload, sub, vapid);
        const pushRes = await fetch(sub.endpoint, {
          method: method || 'POST',
          headers,
          body,
        });
        if (pushRes.ok) {
          pushOk = true;
        } else if (pushRes.status === 410 || pushRes.status === 404) {
          await env.PROACTIVE_KV.delete(keyName);
        }
      } catch (e) {
        console.error('Push failed:', e);
      }
      if (!pushOk) continue;

      item.lastProactiveAt = now;
      await env.PROACTIVE_KV.put(keyName, JSON.stringify(item), { expirationTtl: 60 * 60 * 24 * 30 });
    }
  },
};
