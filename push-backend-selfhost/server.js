/**
 * 纯白人生 - 自托管推送服务（替代 Cloudflare Workers）
 * 部署到你自己的香港服务器，国内访问无需梯子
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });
import express from 'express';
import cron from 'node-cron';
import * as storage from './storage.js';
import { runScheduled } from './cron.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;
const GAME_ORIGIN = process.env.GAME_ORIGIN || '*';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': GAME_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

app.use((req, res, next) => {
  res.set(CORS_HEADERS);
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

// GET /vapid-public
app.get('/vapid-public', (req, res) => {
  const pub = process.env.VAPID_PUBLIC_KEY;
  if (!pub) return res.status(500).json({ error: 'VAPID not configured' });
  res.json({ publicKey: pub });
});

// GET /api/status
app.get('/api/status', async (req, res) => {
  const vapidOk = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  let relationCount = 0;
  try {
    const list = await storage.list('rel:');
    relationCount = (list.keys || []).length;
  } catch (_) {}
  res.json({ ok: true, vapidConfigured: vapidOk, relationCount });
});

// GET /icon/:id
app.get('/icon/:id', async (req, res) => {
  let id = '';
  try {
    id = decodeURIComponent(req.params.id);
  } catch (_) {
    id = req.params.id;
  }
  if (!id) return res.status(404).send('Not Found');
  const val = await storage.get('icon:' + id);
  if (!val) return res.status(404).send('Not Found');
  const match = val.match(/^data:([^;]+);base64,(.+)$/);
  const body = match ? Buffer.from(match[2], 'base64') : Buffer.from(val, 'utf8');
  const mime = match ? match[1] : 'image/png';
  res.set('Cache-Control', 'public, max-age=86400');
  res.type(mime).send(body);
});

// POST /register
app.post('/register', async (req, res) => {
  try {
    const body = req.body;
    const { subscription, relations } = body || {};
    if (!subscription || !subscription.endpoint || !Array.isArray(relations) || !relations.length) {
      return res.status(400).json({ error: 'Invalid payload' });
    }
    const subKey = hash(subscription.endpoint);
    const origin = (body.origin && typeof body.origin === 'string')
      ? body.origin.replace(/\/$/, '')
      : (req.protocol + '://' + req.get('host'));
    const serverBase = req.protocol + '://' + req.get('host');
    for (const rel of relations) {
      const rid = rel.relationId;
      if (!rid) continue;
      const iconId = 'icon_' + subKey + '_' + rid;
      if (rel.avatar && rel.avatar.startsWith('data:')) {
        await storage.put('icon:' + iconId, rel.avatar);
      }
      const iconUrl = rel.avatar && rel.avatar.startsWith('data:')
        ? serverBase + '/icon/' + encodeURIComponent(iconId)
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
      await storage.put('rel:' + subKey + ':' + rid, JSON.stringify(item));
    }
    await storage.put('sub:' + subKey, JSON.stringify(subscription));
    res.json({ ok: true });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// 每分钟执行一次主动推送（与 Cloudflare cron 一致）
cron.schedule('* * * * *', () => {
  runScheduled().catch((e) => console.error('Cron error:', e));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Push server running on port ${PORT}`);
  console.log(`VAPID configured: ${!!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)}`);
});
