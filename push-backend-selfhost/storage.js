/**
 * 文件存储，替代 Cloudflare KV
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function keyToFile(k) {
  return k.replace(/:/g, '__') + '.json';
}

function fileToKey(f) {
  if (!f.endsWith('.json')) return null;
  return f.slice(0, -5).replace(/__/g, ':');
}

export async function get(key) {
  ensureDir();
  const file = path.join(DATA_DIR, keyToFile(key));
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw;
  } catch {
    return null;
  }
}

export async function put(key, value, options = {}) {
  ensureDir();
  const file = path.join(DATA_DIR, keyToFile(key));
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

export async function del(key) {
  const file = path.join(DATA_DIR, keyToFile(key));
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

export async function list(prefix = '') {
  ensureDir();
  const files = fs.readdirSync(DATA_DIR);
  const prefixFile = prefix.replace(/:/g, '__');
  const keys = files
    .filter((f) => f.endsWith('.json') && f.startsWith(prefixFile))
    .map((f) => fileToKey(f))
    .filter(Boolean);
  return { keys };
}
