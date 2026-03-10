/**
 * 纯白人生 - 后台主动回复 Web Push 后端
 * 部署到 Cloudflare Workers，配合 GitHub Pages 实现 iOS/Android 后台推送
 */
import { buildPushHTTPRequest } from '@pushforge/builder';

const KV_KEY_PREFIX = 'proactive:';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function kvKey(endpoint) {
  return KV_KEY_PREFIX + endpoint.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 200);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    if (url.pathname === '/api/subscribe' && request.method === 'POST') {
      return handleSubscribe(request, env);
    }
    if (url.pathname === '/api/health' && request.method === 'GET') {
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ error: 'Not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    await runCron(env);
  },
};

async function handleSubscribe(request, env) {
  try {
    const body = await request.json();
    const { subscription, relations } = body;
    if (!subscription || !subscription.endpoint || !Array.isArray(relations)) {
      return jsonResponse({ error: 'Invalid body: need subscription and relations' }, 400);
    }
    if (!env.VAPID_PRIVATE_KEY) {
      return jsonResponse({ error: 'Server not configured' }, 500);
    }

    const now = Date.now();
    const relationsWithSchedule = relations.map((r) => ({
      relationId: r.relationId,
      intervalHours: Math.max(1, Math.min(24, r.intervalHours || 1)),
      nextPushAt: now + (r.intervalHours || 1) * 60 * 60 * 1000,
    }));

    const key = kvKey(subscription.endpoint);
    const value = JSON.stringify({
      subscription,
      relations: relationsWithSchedule,
      updatedAt: now,
    });
    await env.PROACTIVE_KV.put(key, value);
    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ error: String(e.message || e) }, 500);
  }
}

async function runCron(env) {
  if (!env.VAPID_PRIVATE_KEY || !env.PROACTIVE_KV) return;
  const privateJWK = JSON.parse(env.VAPID_PRIVATE_KEY);
  const now = Date.now();
  const list = await env.PROACTIVE_KV.list({ prefix: KV_KEY_PREFIX });
  for (const key of list.keys) {
    try {
      const raw = await env.PROACTIVE_KV.get(key.name);
      if (!raw) continue;
      const data = JSON.parse(raw);
      const { subscription, relations } = data;
      if (!subscription || !Array.isArray(relations)) continue;

      const due = relations.filter((r) => r.nextPushAt <= now);
      if (due.length === 0) continue;

      const { endpoint, headers, body } = await buildPushHTTPRequest({
        privateJWK,
        subscription,
        message: {
          payload: { type: 'proactive', relationIds: due.map((d) => d.relationId) },
          adminContact: 'mailto:support@example.com',
          options: { ttl: 3600 },
        },
      });

      const res = await fetch(endpoint, { method: 'POST', headers, body });
      if (res.status !== 201 && res.status !== 200) {
        const text = await res.text();
        if (res.status !== 404 && res.status !== 410) continue;
        await env.PROACTIVE_KV.delete(key.name);
        continue;
      }

      const updated = relations.map((r) => {
        if (r.nextPushAt <= now) {
          return { ...r, nextPushAt: now + r.intervalHours * 60 * 60 * 1000 };
        }
        return r;
      });
      await env.PROACTIVE_KV.put(key.name, JSON.stringify({
        ...data,
        relations: updated,
        updatedAt: now,
      }));
    } catch (err) {
      console.error('Cron push failed:', key?.name, err);
    }
  }
}
