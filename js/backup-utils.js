import { DISPLAY_FONT_OPTIONS, REASONING_EFFORTS, WEB_SEARCH_CONTEXT_SIZES } from './config.js';
import { normalizeTags, sortConversationsByUpdatedAt } from './conversation-utils.js';
import { normalizeCustomTemplates } from './prompt-templates.js';
import { generateId } from './utils.js';

export const BACKUP_VERSION = 1;
const SAFE_IMPORTED_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function formatBjtTimestamp(date = new Date()) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

export function normalizeSettings(value = {}) {
  const settings = value && typeof value === 'object' ? value : {};
  return {
    temperature: typeof settings.temperature === 'number' ? settings.temperature : undefined,
    maxTokens: typeof settings.maxTokens === 'number' ? settings.maxTokens : undefined,
    systemPrompt: typeof settings.systemPrompt === 'string' ? settings.systemPrompt : undefined,
    apiBaseUrl: typeof settings.apiBaseUrl === 'string' ? settings.apiBaseUrl : undefined,
    webSearchEnabled: typeof settings.webSearchEnabled === 'boolean' ? settings.webSearchEnabled : undefined,
    webSearchContextSize: WEB_SEARCH_CONTEXT_SIZES.includes(settings.webSearchContextSize)
      ? settings.webSearchContextSize
      : undefined,
    reasoningEffort: REASONING_EFFORTS.includes(settings.reasoningEffort)
      ? settings.reasoningEffort
      : undefined,
    displayFont: DISPLAY_FONT_OPTIONS.includes(settings.displayFont)
      ? settings.displayFont
      : undefined,
  };
}

function normalizeImportedId(value, prefix, idMap = new Map()) {
  if (typeof value === 'string' && SAFE_IMPORTED_ID_PATTERN.test(value)) {
    return value;
  }

  const key = `${prefix}:${typeof value === 'string' ? value : ''}`;
  if (typeof value === 'string' && value && idMap.has(key)) return idMap.get(key);

  const id = `${prefix}-${generateId()}`;
  if (typeof value === 'string' && value) idMap.set(key, id);
  return id;
}

function normalizeMessage(value, idMap = new Map()) {
  if (!value || typeof value !== 'object') return null;
  return {
    ...value,
    id: normalizeImportedId(value.id, 'msg', idMap),
  };
}

function resolveActiveConversationId(value, idMap, conversations) {
  if (typeof value !== 'string') return null;
  const normalizedId = SAFE_IMPORTED_ID_PATTERN.test(value)
    ? value
    : idMap.get(`conv:${value}`);
  return conversations.some((item) => item.id === normalizedId) ? normalizedId : null;
}

export function normalizeLongTextAttachment(value) {
  if (!value || typeof value !== 'object' || value.type !== 'generated-md' || typeof value.id !== 'string') {
    return null;
  }
  return {
    id: value.id,
    type: 'generated-md',
    name: String(value.name || 'long-text.md'),
    size: Number.isFinite(value.size) ? value.size : 0,
    charCount: Number.isFinite(value.charCount) ? value.charCount : 0,
    lineCount: Number.isFinite(value.lineCount) ? value.lineCount : 0,
    mode: value.mode === 'full' ? 'full' : 'reference',
    excerpt: String(value.excerpt || ''),
    content: typeof value.content === 'string' ? value.content : undefined,
  };
}

export function normalizeConversation(value, options = {}) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string') return null;
  const now = Date.now();
  const conversationIdMap = options.conversationIdMap ?? new Map();
  const messageIdMap = options.messageIdMap ?? new Map();
  return {
    ...value,
    id: normalizeImportedId(value.id, 'conv', conversationIdMap),
    title: String(value.title ?? '新对话'),
    modelId: String(value.modelId ?? ''),
    systemPrompt: typeof value.systemPrompt === 'string' ? value.systemPrompt : '',
    messages: Array.isArray(value.messages)
      ? value.messages.map((message) => normalizeMessage(message, messageIdMap)).filter(Boolean)
      : [],
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : (value.createdAt ?? now),
    pinned: Boolean(value.pinned),
    tags: normalizeTags(value.tags),
  };
}

export function createBackupPayload(data) {
  const conversationIdMap = new Map();
  const conversations = sortConversationsByUpdatedAt(
    (Array.isArray(data.conversations) ? data.conversations : [])
      .map((conversation) => normalizeConversation(conversation, { conversationIdMap }))
      .filter(Boolean)
  );

  return {
    version: BACKUP_VERSION,
    exportedAt: formatBjtTimestamp(),
    settings: normalizeSettings(data.settings),
    conversations,
    activeConversationId: resolveActiveConversationId(data.activeConversationId, conversationIdMap, conversations),
    selectedModelId: data.selectedModelId ?? null,
    models: Array.isArray(data.models) ? data.models : [],
    promptTemplates: normalizeCustomTemplates(data.promptTemplates),
    longTextAttachments: (Array.isArray(data.longTextAttachments) ? data.longTextAttachments : [])
      .map(normalizeLongTextAttachment)
      .filter(Boolean),
  };
}

export function parseBackupPayload(raw) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new Error('备份文件不是合法 JSON');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('备份文件格式无效');
  }
  if (parsed.version !== BACKUP_VERSION) {
    throw new Error(`不支持的备份版本：${parsed.version ?? '未知'}`);
  }

  return createBackupPayload(parsed);
}

export function mergeBackupIntoState(current, backup) {
  const byId = new Map();
  const currentConversationIdMap = new Map();
  for (const conversation of current.conversations ?? []) {
    const normalized = normalizeConversation(conversation, { conversationIdMap: currentConversationIdMap });
    if (normalized) byId.set(normalized.id, normalized);
  }
  for (const conversation of backup.conversations ?? []) {
    const normalized = normalizeConversation(conversation);
    if (normalized) byId.set(normalized.id, normalized);
  }

  const customTemplates = new Map();
  for (const template of normalizeCustomTemplates(current.promptTemplates)) {
    customTemplates.set(template.id, template);
  }
  for (const template of normalizeCustomTemplates(backup.promptTemplates)) {
    customTemplates.set(template.id, template);
  }

  const conversations = sortConversationsByUpdatedAt(Array.from(byId.values()));
  const currentActiveConversationId = resolveActiveConversationId(
    current.activeConversationId,
    currentConversationIdMap,
    conversations
  );
  const activeConversationId = conversations.some((item) => item.id === backup.activeConversationId)
    ? backup.activeConversationId
    : (currentActiveConversationId ?? conversations[0]?.id ?? null);

  return {
    settings: normalizeSettings({ ...current.settings, ...backup.settings }),
    conversations,
    activeConversationId,
    selectedModelId: backup.selectedModelId ?? current.selectedModelId ?? null,
    models: backup.models?.length ? backup.models : (current.models ?? []),
    promptTemplates: Array.from(customTemplates.values()),
    longTextAttachments: backup.longTextAttachments ?? [],
  };
}
