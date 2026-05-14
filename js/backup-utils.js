import { normalizeTags, sortConversationsByUpdatedAt } from './conversation-utils.js';
import { normalizeCustomTemplates } from './prompt-templates.js';

export const BACKUP_VERSION = 1;

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
    reasoningEffort: ['low', 'medium', 'high', 'xhigh'].includes(settings.reasoningEffort)
      ? settings.reasoningEffort
      : undefined,
  };
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

export function normalizeConversation(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string') return null;
  const now = Date.now();
  return {
    ...value,
    title: String(value.title ?? '新对话'),
    modelId: String(value.modelId ?? ''),
    systemPrompt: typeof value.systemPrompt === 'string' ? value.systemPrompt : '',
    messages: Array.isArray(value.messages) ? value.messages : [],
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : (value.createdAt ?? now),
    pinned: Boolean(value.pinned),
    tags: normalizeTags(value.tags),
  };
}

export function createBackupPayload(data) {
  return {
    version: BACKUP_VERSION,
    exportedAt: formatBjtTimestamp(),
    settings: normalizeSettings(data.settings),
    conversations: sortConversationsByUpdatedAt(
      (Array.isArray(data.conversations) ? data.conversations : [])
        .map(normalizeConversation)
        .filter(Boolean)
    ),
    activeConversationId: data.activeConversationId ?? null,
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
  for (const conversation of current.conversations ?? []) {
    const normalized = normalizeConversation(conversation);
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
  const activeConversationId = conversations.some((item) => item.id === backup.activeConversationId)
    ? backup.activeConversationId
    : (current.activeConversationId ?? conversations[0]?.id ?? null);

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
