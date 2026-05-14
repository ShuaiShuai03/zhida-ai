import { LONG_TEXT_EXCERPT_MAX } from './config.js';
import { byteSize, generateId } from './utils.js';

const DB_NAME = 'zhida-ai-long-text';
const DB_VERSION = 1;
const STORE_NAME = 'attachments';

export function formatBjtCompactTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
}

export function buildLongTextExcerpt(content, maxLength = LONG_TEXT_EXCERPT_MAX) {
  const text = String(content ?? '');
  if (text.length <= maxLength) return text;
  const headLength = Math.ceil(maxLength / 2);
  const tailLength = Math.floor(maxLength / 2);
  return `${text.slice(0, headLength)}${text.slice(-tailLength)}`;
}

export function createGeneratedMdAttachment(content, date = new Date()) {
  const text = String(content ?? '');
  return {
    id: generateId(),
    type: 'generated-md',
    name: `long-text-${formatBjtCompactTimestamp(date)}-BJT.md`,
    size: byteSize(text),
    charCount: text.length,
    lineCount: text ? text.split(/\r\n|\r|\n/).length : 0,
    mode: 'reference',
    excerpt: buildLongTextExcerpt(text),
  };
}

export function sanitizeGeneratedMdAttachment(value) {
  if (!value || value.type !== 'generated-md' || typeof value.id !== 'string') return null;
  return {
    id: value.id,
    type: 'generated-md',
    name: String(value.name || 'long-text.md'),
    size: Number.isFinite(value.size) ? value.size : 0,
    charCount: Number.isFinite(value.charCount) ? value.charCount : 0,
    lineCount: Number.isFinite(value.lineCount) ? value.lineCount : 0,
    mode: value.mode === 'full' ? 'full' : 'reference',
    excerpt: String(value.excerpt || ''),
  };
}

export function formatLongTextDisplay(att) {
  const modeLabel = att.mode === 'full' ? '全文模式' : '引用模式';
  return [
    `📎 ${att.name}（${modeLabel}）`,
    `字符数：${att.charCount}，行数：${att.lineCount}，大小：${att.size} bytes`,
    att.mode === 'full'
      ? '发送请求时会附带完整 md 内容。'
      : '全文已保存为本地 md 附件，默认不会随请求发送。',
  ].join('\n');
}

export function buildLongTextPromptBlock(att, content = '') {
  const mode = att.mode === 'full' ? 'full' : 'reference';
  if (mode === 'full') {
    return [
      `## 本地 md 附件：${att.name}`,
      `字符数：${att.charCount}，行数：${att.lineCount}`,
      '',
      '以下是该附件全文：',
      '```markdown',
      content,
      '```',
    ].join('\n');
  }

  return [
    `## 本地 md 附件引用：${att.name}`,
    `字符数：${att.charCount}，行数：${att.lineCount}，大小：${att.size} bytes`,
    '全文已保存为本地 md 附件，未随请求发送。你只能依据文件名、统计信息和下面摘录判断；如需精确全文分析，请要求用户切换为全文模式。',
    '',
    '摘录：',
    '```markdown',
    att.excerpt || '',
    '```',
  ].join('\n');
}

function openDb() {
  if (!('indexedDB' in globalThis)) {
    return Promise.reject(new Error('当前浏览器不支持 IndexedDB，无法保存长文本附件'));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB 打开失败'));
  });
}

async function withStore(mode, callback) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      let result;
      try {
        result = callback(store);
      } catch (err) {
        reject(err);
        return;
      }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB 操作失败'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB 操作已中止'));
    });
  } finally {
    db.close();
  }
}

export function saveLongTextAttachment(att, content) {
  return withStore('readwrite', (store) => {
    store.put({
      ...sanitizeGeneratedMdAttachment(att),
      content: String(content ?? ''),
      updatedAt: Date.now(),
    });
  });
}

export async function getLongTextContent(id) {
  const record = await withStore('readonly', (store) => {
    return new Promise((resolve, reject) => {
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('IndexedDB 读取失败'));
    });
  });
  return typeof record?.content === 'string' ? record.content : '';
}

export async function exportLongTextAttachments(conversations) {
  const ids = new Map();
  for (const conversation of conversations || []) {
    for (const message of conversation.messages || []) {
      for (const att of message.attachments || []) {
        const normalized = sanitizeGeneratedMdAttachment(att);
        if (normalized) ids.set(normalized.id, normalized);
      }
    }
  }

  const exported = [];
  for (const att of ids.values()) {
    const content = await getLongTextContent(att.id).catch(() => '');
    if (content) exported.push({ ...att, content });
  }
  return exported;
}

export async function importLongTextAttachments(items) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  let count = 0;
  for (const item of items) {
    const att = sanitizeGeneratedMdAttachment(item);
    if (!att || typeof item.content !== 'string') continue;
    await saveLongTextAttachment(att, item.content);
    count += 1;
  }
  return count;
}
