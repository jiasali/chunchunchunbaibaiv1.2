/* 纯白人生 - 后台主动回复 Service Worker */
const IDB_NAME = 'tabula_proactive_db';
const IDB_VERSION = 1;
const STORE_NAME = 'proactive';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'relationId' });
      }
    };
  });
}

async function getProactiveData(relationId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(relationId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAllProactiveRelations() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function getRealTimeContextText() {
  try {
    const now = new Date();
    const week = ['日', '一', '二', '三', '四', '五', '六'];
    const pad2 = (n) => String(n).padStart(2, '0');
    const tzMin = -now.getTimezoneOffset();
    const sign = tzMin >= 0 ? '+' : '-';
    const tzAbs = Math.abs(tzMin);
    const tzH = pad2(Math.floor(tzAbs / 60));
    const tzM = pad2(tzAbs % 60);
    const y = now.getFullYear();
    const mo = pad2(now.getMonth() + 1);
    const d = pad2(now.getDate());
    const hh = pad2(now.getHours());
    const mm = pad2(now.getMinutes());
    const ss = pad2(now.getSeconds());
    const tz = 'UTC' + sign + tzH + ':' + tzM;
    return '【当前现实时间】\n' +
      (y + '-' + mo + '-' + d + ' 周' + week[now.getDay()] + ' ' + hh + ':' + mm + ':' + ss + '（' + tz + '）') +
      '\n（请严格根据这个现实时间判断：现在是清晨/上午/中午/下午/傍晚/晚上/深夜，并据此写台词与语气。）\n';
  } catch (e) {
    return '';
  }
}

function getNowHHMM() {
  try {
    const now = new Date();
    const pad2 = (n) => String(n).padStart(2, '0');
    return pad2(now.getHours()) + ':' + pad2(now.getMinutes());
  } catch (e) {
    return '';
  }
}

async function callProactiveAPI(data) {
  const api = (data.api && data.api.endpoint) ? data.api : (data.userSettings && data.userSettings.api) ? data.userSettings.api : null;
  if (!api || !api.endpoint || !api.key) return null;
  const name = (data.name || 'TA').toString().trim();
  const charInfo = data.charInfo || '';
  const historyLines = Array.isArray(data.historyLines) ? data.historyLines : [];
  const worldPresetBlock = data.worldPresetBlock || '';
  const intervalHours = data.proactiveReplyIntervalHours || 1;
  const timeCtx = getRealTimeContextText();
  let endpoint = (api.endpoint || '').trim();
  if (!endpoint.endsWith('/chat/completions')) endpoint = endpoint.replace(/\/$/, '') + '/chat/completions';
  const userContent = '【重要】你已经隔了 ' + intervalHours + ' 小时没有和对方联系。请根据你的人设、与对方的聊天记录，主动发起一条自然的问候或关心。可以表达想念或关心，但不要刻意说「现在几点了」「都X点了」等具体时间。只输出一个 JSON 对象：{"reply":["你说的话1","你说的话2"]}。严禁输出心理独白、旁白等。\n\n' + timeCtx + '\n【聊天记录】\n' + (historyLines.length ? historyLines.join('\n') : '（暂无记录）') + (worldPresetBlock || '');
  const sysPrompt = '你是「' + name + '」。你的设定如下：\n' + charInfo + '\n\n请以该角色身份，主动给玩家发一条消息。';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (api.key || '') },
    body: JSON.stringify({
      model: api.model || 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: userContent }
      ],
      temperature: (typeof api.temperature === 'number' && !isNaN(api.temperature)) ? api.temperature : 0.85
    })
  });
  if (!res.ok) throw new Error('API ' + res.status);
  const json = await res.json();
  let content = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) ? json.choices[0].message.content.trim() : '';
  if (!content) throw new Error('未返回内容');
  content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let replyText = '';
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed.reply)) {
      replyText = parsed.reply.map(x => (x || '').toString().trim()).filter(Boolean).join('');
    } else if (typeof parsed.reply === 'string') {
      replyText = parsed.reply.toString().trim();
    }
  } catch (e) {
    replyText = content;
  }
  return replyText || content;
}

async function handleProactiveWakeup(relationId, url) {
  if (!relationId) return;
  try {
    const item = await getProactiveData(relationId);
    if (!item || !item.proactiveReply) return;
    const now = Date.now();
    const intervalMs = (item.proactiveReplyIntervalHours || 1) * 60 * 60 * 1000;
    const lastAt = item.lastProactiveAt || 0;
    if (now - lastAt < intervalMs) return;
    const replyText = await callProactiveAPI(item);
    if (!replyText) return;
    const name = (item.name || 'TA').toString().trim();
    const avatar = item.avatar || '';
    item.lastProactiveAt = now;
    if (!item.gameState) item.gameState = {};
    if (!item.gameState.chatLogs) item.gameState.chatLogs = {};
    if (!item.gameState.chatLogs[item.relationId]) item.gameState.chatLogs[item.relationId] = [];
    item.gameState.chatLogs[item.relationId].push({ from: 'other', text: replyText });
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(item);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    const hhmm = getNowHHMM();
    const baseBody = replyText.slice(0, 100) + (replyText.length > 100 ? '...' : '');
    const body = (hhmm ? ('[' + hhmm + '] ') : '') + baseBody;
    await self.registration.showNotification(name, {
      body: body,
      icon: avatar || undefined,
      tag: 'proactive-' + item.relationId,
      data: { relationId: item.relationId, url: url || (self.location.origin + self.location.pathname) }
    });
  } catch (err) {
    console.error('Proactive wakeup failed:', err);
  }
}

/* Web Push：iOS 等依赖服务端推送，收到后在此展示通知 */
/* push-backend 发送格式为 { data: { title, body, icon, tag, data: { relationId, url } } } */
self.addEventListener('push', (e) => {
  if (!e.data) return;
  try {
    const payload = e.data.json() || {};
    const type = payload.type || (payload.data && payload.data.type);
    // 服务器仅唤醒模式：收到唤醒信号后在本机生成消息并通知
    if (type === 'proactive-wakeup') {
      const relationId = (payload.data && payload.data.relationId) || payload.relationId;
      const url = (payload.data && payload.data.url) || payload.url || (self.location.origin + self.location.pathname);
      e.waitUntil(handleProactiveWakeup(relationId, url));
      return;
    }
    /* 服务端加密的是 { title, body, icon, tag, data: { relationId, url } }，解密后 payload 即该对象 */
    const inner = (payload.data && typeof payload.data === 'object') ? payload.data : {};
    const title = (payload.title != null ? payload.title : inner.title) || '纯白人生';
    const body = (payload.body != null ? payload.body : inner.body) || '';
    const icon = payload.icon != null ? payload.icon : inner.icon;
    const tag = (payload.tag != null ? payload.tag : inner.tag) || 'proactive-default';
    let openUrl = (inner.url && String(inner.url).startsWith('http')) ? inner.url : (payload.url && String(payload.url).startsWith('http') ? payload.url : null);
    if (!openUrl) openUrl = self.location.origin + self.location.pathname;
    const relationId = inner.relationId || payload.relationId;
    if (relationId && !openUrl.includes('#')) openUrl = openUrl.replace(/#.*$/, '') + '#chat-' + relationId;
    const data = { relationId: relationId, url: openUrl };
    e.waitUntil(
      self.registration.showNotification(title, {
        body: body,
        icon: icon || undefined,
        tag: tag,
        data: data
      })
    );
  } catch (err) {
    console.error('Push parse error:', err);
  }
});

self.addEventListener('periodicsync', async (e) => {
  if (e.tag !== 'tabula-proactive') return;
  const list = await getAllProactiveRelations();
  const now = Date.now();
  for (const item of list) {
    if (!item || !item.proactiveReply) continue;
    const intervalMs = (item.proactiveReplyIntervalHours || 1) * 60 * 60 * 1000;
    const lastAt = item.lastProactiveAt || 0;
    if (now - lastAt < intervalMs) continue;
    try {
      const replyText = await callProactiveAPI(item);
      if (!replyText) continue;
      const name = (item.name || 'TA').toString().trim();
      const avatar = item.avatar || '';
      item.lastProactiveAt = now;
      if (!item.gameState) item.gameState = {};
      if (!item.gameState.chatLogs) item.gameState.chatLogs = {};
      if (!item.gameState.chatLogs[item.relationId]) item.gameState.chatLogs[item.relationId] = [];
      item.gameState.chatLogs[item.relationId].push({ from: 'other', text: replyText });
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(item);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      const hhmm = getNowHHMM();
      const baseBody = replyText.slice(0, 100) + (replyText.length > 100 ? '...' : '');
      const body = (hhmm ? ('[' + hhmm + '] ') : '') + baseBody;
      await self.registration.showNotification(name, {
        body: body,
        icon: avatar || undefined,
        tag: 'proactive-' + item.relationId,
        data: { relationId: item.relationId, url: self.location.origin + self.location.pathname }
      });
    } catch (err) {
      console.error('Proactive reply failed:', err);
    }
  }
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  let url = data.url;
  if (!url || typeof url !== 'string' || !url.startsWith('http')) url = self.location.origin + self.location.pathname;
  const relationId = data.relationId;
  if (relationId && !url.includes('#chat-')) url = url.replace(/#.*$/, '') + '#chat-' + relationId;
  e.waitUntil(clients.openWindow(url));
});
