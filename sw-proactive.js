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

async function callProactiveAPI(data) {
  const api = (data.api && data.api.endpoint) ? data.api : (data.userSettings && data.userSettings.api) ? data.userSettings.api : null;
  if (!api || !api.endpoint || !api.key) return null;
  const name = (data.name || 'TA').toString().trim();
  const charInfo = data.charInfo || '';
  const historyLines = Array.isArray(data.historyLines) ? data.historyLines : [];
  const worldPresetBlock = data.worldPresetBlock || '';
  const intervalHours = data.proactiveReplyIntervalHours || 1;
  let endpoint = (api.endpoint || '').trim();
  if (!endpoint.endsWith('/chat/completions')) endpoint = endpoint.replace(/\/$/, '') + '/chat/completions';
  const userContent = '【重要】你已经隔了 ' + intervalHours + ' 小时没有和对方联系。请根据你的人设、与对方的聊天记录，主动发起一条自然的问候或关心。可以提及时间过去了多久，表达想念或关心。只输出一个 JSON 对象：{"reply":["你说的话1","你说的话2"]}。严禁输出心理独白、旁白等。\n\n【聊天记录】\n' + (historyLines.length ? historyLines.join('\n') : '（暂无记录）') + (worldPresetBlock || '');
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

/* Web Push：iOS 等依赖服务端推送，收到后在此展示通知 */
self.addEventListener('push', (e) => {
  if (!e.data) return;
  try {
    const payload = e.data.json();
    const title = (payload && payload.title) || '纯白人生';
    const body = (payload && payload.body) || '';
    const icon = (payload && payload.icon) || undefined;
    const tag = (payload && payload.tag) || 'proactive-default';
    const data = (payload && payload.data) || {};
    const url = data.url || self.location.origin + self.location.pathname;
    e.waitUntil(
      self.registration.showNotification(title, {
        body: body,
        icon: icon,
        tag: tag,
        data: { ...data, url: url }
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
      await self.registration.showNotification(name, {
        body: replyText.slice(0, 100) + (replyText.length > 100 ? '...' : ''),
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
  const url = e.notification.data && e.notification.data.url;
  if (url && url.startsWith('http')) e.waitUntil(clients.openWindow(url));
});
