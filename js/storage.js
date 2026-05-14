/**
 * localStorage operations — conversation persistence with error handling.
 */

import {
  STORAGE_KEYS,
  MAX_CONVERSATIONS,
  MAX_STORAGE_MB,
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORTS,
} from './config.js';
import { pruneConversationsToLimit, sortConversationsByUpdatedAt } from './conversation-utils.js';
import { createBackupPayload, mergeBackupIntoState, parseBackupPayload } from './backup-utils.js';
import { exportLongTextAttachments, importLongTextAttachments } from './long-text.js';
import { normalizeCustomTemplates } from './prompt-templates.js';
import { state } from './state.js';
import { byteSize } from './utils.js';

/**
 * Safely read from localStorage.
 * @param {string} key
 * @returns {*} Parsed JSON or null
 */
function getItem(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn('localStorage read error:', e);
    // Emit event for UI notification
    window.dispatchEvent(new CustomEvent('storage-error', { detail: { operation: 'read', error: e } }));
    return null;
  }
}

/**
 * Safely write to localStorage with quota handling.
 * @param {string} key
 * @param {*} value
 * @returns {boolean} Success flag
 */
function setItem(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    if (e.name === 'QuotaExceededError' || e.code === 22) {
      console.warn('localStorage quota exceeded');
      // Emit a custom event so ui.js can show a toast
      window.dispatchEvent(new CustomEvent('storage-full'));
      return false;
    }
    console.warn('localStorage write error:', e);
    // Emit event for UI notification
    window.dispatchEvent(new CustomEvent('storage-error', { detail: { operation: 'write', error: e } }));
    return false;
  }
}

/**
 * Estimate total localStorage usage in megabytes.
 * @returns {number}
 */
export function getStorageUsageMB() {
  let total = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    total += byteSize(key) + byteSize(localStorage.getItem(key) ?? '');
  }
  return total / (1024 * 1024);
}

/**
 * Check if storage is near the soft limit and warn.
 * @returns {boolean}
 */
export function isStorageNearFull() {
  return getStorageUsageMB() > MAX_STORAGE_MB;
}

// ---- Conversations ----

/**
 * Load all conversations from localStorage into state.
 */
export function loadConversations() {
  const data = getItem(STORAGE_KEYS.CONVERSATIONS);
  if (Array.isArray(data)) {
    state.conversations = sortConversationsByUpdatedAt(data.map((conversation) => ({
      ...conversation,
      pinned: Boolean(conversation.pinned),
      tags: Array.isArray(conversation.tags) ? conversation.tags : [],
    })));
  }
}

/**
 * Save all conversations to localStorage (with pruning).
 * @param {Array} [conversations=state.conversations] - Desired conversation list.
 * @returns {boolean} Success flag.
 */
export function saveConversations(conversations = state.conversations) {
  let convs = sortConversationsByUpdatedAt(conversations);
  // Prune oldest conversations if over limit
  if (convs.length > MAX_CONVERSATIONS) {
    convs = convs.slice(0, MAX_CONVERSATIONS);
  }
  if (!setItem(STORAGE_KEYS.CONVERSATIONS, convs)) {
    return false;
  }
  state.conversations = convs;
  return true;
}

/**
 * Save a single conversation (update in place or insert).
 * @param {Object} conversation
 * @returns {boolean} Success flag.
 */
export function saveConversation(conversation) {
  const nextConversations = [...state.conversations];
  const idx = nextConversations.findIndex((c) => c.id === conversation.id);
  if (idx >= 0) {
    nextConversations[idx] = conversation;
  } else {
    nextConversations.unshift(conversation);
  }
  return saveConversations(nextConversations);
}

// ---- Active Conversation ID ----

/**
 * Load the active conversation ID from localStorage.
 */
export function loadActiveConversationId() {
  const id = getItem(STORAGE_KEYS.ACTIVE_CONVERSATION);
  if (id && state.conversations.some((c) => c.id === id)) {
    state.activeConversationId = id;
  }
}

/**
 * Save the active conversation ID to localStorage.
 * @returns {boolean} Success flag.
 */
export function saveActiveConversationId() {
  return setItem(STORAGE_KEYS.ACTIVE_CONVERSATION, state.activeConversationId);
}

// ---- Selected Model ----

/**
 * Load selected model from localStorage.
 */
export function loadSelectedModel() {
  const modelId = getItem(STORAGE_KEYS.SELECTED_MODEL);
  if (modelId && state.models.some((m) => m.id === modelId)) {
    state.selectedModelId = modelId;
  }
}

// ---- Cached Models ----

/**
 * Load cached model list from localStorage into state.
 */
export function loadCachedModels() {
  const data = getItem(STORAGE_KEYS.MODELS);
  if (Array.isArray(data) && data.length > 0) {
    state.models = data;
  }
}

/**
 * Save fetched model list to localStorage as cache.
 * @returns {boolean} Success flag.
 */
export function saveCachedModels() {
  return setItem(STORAGE_KEYS.MODELS, state.models);
}

/**
 * Save selected model to localStorage.
 * @returns {boolean} Success flag.
 */
export function saveSelectedModel() {
  return setItem(STORAGE_KEYS.SELECTED_MODEL, state.selectedModelId);
}

// ---- Settings ----

/**
 * Load non-sensitive settings from localStorage.
 */
export function loadSettings() {
  const data = getItem(STORAGE_KEYS.SETTINGS);
  if (data) {
    if (typeof data.temperature === 'number') state.temperature = data.temperature;
    if (typeof data.maxTokens === 'number') state.maxTokens = data.maxTokens;
    if (typeof data.systemPrompt === 'string') state.systemPrompt = data.systemPrompt;
    if (typeof data.apiBaseUrl === 'string') state.apiBaseUrl = data.apiBaseUrl;
    state.webSearchEnabled = Boolean(data.webSearchEnabled);
    state.reasoningEffort = REASONING_EFFORTS.includes(data.reasoningEffort)
      ? data.reasoningEffort
      : DEFAULT_REASONING_EFFORT;
  }
}

/**
 * Save settings to localStorage.
 * @returns {boolean} Success flag.
 */
export function saveSettings() {
  return setItem(STORAGE_KEYS.SETTINGS, {
    temperature: state.temperature,
    maxTokens: state.maxTokens,
    systemPrompt: state.systemPrompt,
    apiBaseUrl: state.apiBaseUrl,
    webSearchEnabled: state.webSearchEnabled,
    reasoningEffort: state.reasoningEffort,
  });
}

// ---- Prompt Templates ----

export function loadCustomPromptTemplates() {
  return normalizeCustomTemplates(getItem(STORAGE_KEYS.PROMPT_TEMPLATES));
}

export function saveCustomPromptTemplates(templates) {
  return setItem(STORAGE_KEYS.PROMPT_TEMPLATES, normalizeCustomTemplates(templates));
}

// ---- Data Management ----

export function getStorageSummary() {
  return {
    usageMB: getStorageUsageMB(),
    conversationCount: state.conversations.length,
    promptTemplateCount: loadCustomPromptTemplates().length,
  };
}

export async function exportAllDataPayload() {
  return createBackupPayload({
    settings: {
      temperature: state.temperature,
      maxTokens: state.maxTokens,
      systemPrompt: state.systemPrompt,
      apiBaseUrl: state.apiBaseUrl,
      webSearchEnabled: state.webSearchEnabled,
      reasoningEffort: state.reasoningEffort,
    },
    conversations: state.conversations,
    activeConversationId: state.activeConversationId,
    selectedModelId: state.selectedModelId,
    models: state.models,
    promptTemplates: loadCustomPromptTemplates(),
    longTextAttachments: await exportLongTextAttachments(state.conversations),
  });
}

export async function importAllData(rawBackup) {
  const backup = parseBackupPayload(rawBackup);
  const importedLongTextCount = await importLongTextAttachments(backup.longTextAttachments);
  const merged = mergeBackupIntoState({
    settings: {
      temperature: state.temperature,
      maxTokens: state.maxTokens,
      systemPrompt: state.systemPrompt,
      apiBaseUrl: state.apiBaseUrl,
      webSearchEnabled: state.webSearchEnabled,
      reasoningEffort: state.reasoningEffort,
    },
    conversations: state.conversations,
    activeConversationId: state.activeConversationId,
    selectedModelId: state.selectedModelId,
    models: state.models,
    promptTemplates: loadCustomPromptTemplates(),
  }, backup);

  if (typeof merged.settings.temperature === 'number') state.temperature = merged.settings.temperature;
  if (typeof merged.settings.maxTokens === 'number') state.maxTokens = merged.settings.maxTokens;
  if (typeof merged.settings.systemPrompt === 'string') state.systemPrompt = merged.settings.systemPrompt;
  if (typeof merged.settings.apiBaseUrl === 'string') state.apiBaseUrl = merged.settings.apiBaseUrl;
  state.webSearchEnabled = Boolean(merged.settings.webSearchEnabled);
  state.reasoningEffort = REASONING_EFFORTS.includes(merged.settings.reasoningEffort)
    ? merged.settings.reasoningEffort
    : DEFAULT_REASONING_EFFORT;
  state.models = merged.models;
  state.selectedModelId = merged.selectedModelId;
  state.conversations = merged.conversations;
  state.activeConversationId = merged.activeConversationId;

  saveSettings();
  saveCachedModels();
  saveSelectedModel();
  saveConversations(merged.conversations);
  saveActiveConversationId();
  saveCustomPromptTemplates(merged.promptTemplates);

  return {
    conversations: merged.conversations.length,
    promptTemplates: merged.promptTemplates.length,
    longTextAttachments: importedLongTextCount,
  };
}

export function pruneStoredConversations(limit) {
  const result = pruneConversationsToLimit(state.conversations, limit);
  if (!saveConversations(result.kept)) {
    return { ok: false, removed: [] };
  }
  if (state.activeConversationId && !result.kept.some((conversation) => conversation.id === state.activeConversationId)) {
    state.activeConversationId = result.kept[0]?.id ?? null;
    saveActiveConversationId();
  }
  return { ok: true, removed: result.removed };
}

// ---- Theme ----

/**
 * Load saved theme preference.
 * @returns {string|null} 'light' | 'dark' | null
 */
export function loadTheme() {
  return getItem(STORAGE_KEYS.THEME);
}

/**
 * Save theme preference.
 * @param {string} theme
 * @returns {boolean} Success flag.
 */
export function saveTheme(theme) {
  return setItem(STORAGE_KEYS.THEME, theme);
}

// ---- Clear All ----

/**
 * Remove all conversations from storage.
 */
export function clearAllData() {
  localStorage.removeItem(STORAGE_KEYS.CONVERSATIONS);
  localStorage.removeItem(STORAGE_KEYS.ACTIVE_CONVERSATION);
  state.clearAllConversations();
}
