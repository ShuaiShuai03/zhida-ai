/**
 * localStorage operations — conversation persistence with error handling.
 */

import { STORAGE_KEYS, MAX_CONVERSATIONS, MAX_STORAGE_MB, DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS, DEFAULT_SYSTEM_PROMPT, MODELS } from './config.js';
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
    // Sort by updatedAt descending
    data.sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
    state.conversations = data;
  }
}

/**
 * Save all conversations to localStorage (with pruning).
 */
export function saveConversations() {
  let convs = state.conversations;
  // Prune oldest conversations if over limit
  if (convs.length > MAX_CONVERSATIONS) {
    convs = convs.slice(0, MAX_CONVERSATIONS);
    state.conversations = convs;
  }
  setItem(STORAGE_KEYS.CONVERSATIONS, convs);
}

/**
 * Save a single conversation (update in place or insert).
 * @param {Object} conversation
 */
export function saveConversation(conversation) {
  const idx = state.conversations.findIndex((c) => c.id === conversation.id);
  if (idx >= 0) {
    state.conversations[idx] = conversation;
  } else {
    state.conversations.unshift(conversation);
  }
  saveConversations();
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
 */
export function saveActiveConversationId() {
  setItem(STORAGE_KEYS.ACTIVE_CONVERSATION, state.activeConversationId);
}

// ---- Selected Model ----

/**
 * Load selected model from localStorage.
 */
export function loadSelectedModel() {
  const modelId = getItem(STORAGE_KEYS.SELECTED_MODEL);
  if (modelId && MODELS.some((m) => m.id === modelId)) {
    state.selectedModelId = modelId;
  }
}

/**
 * Save selected model to localStorage.
 */
export function saveSelectedModel() {
  setItem(STORAGE_KEYS.SELECTED_MODEL, state.selectedModelId);
}

// ---- Settings ----

/**
 * Load settings (temperature, maxTokens, systemPrompt, API config) from localStorage.
 */
export function loadSettings() {
  const data = getItem(STORAGE_KEYS.SETTINGS);
  if (data) {
    if (typeof data.temperature === 'number') state.temperature = data.temperature;
    if (typeof data.maxTokens === 'number') state.maxTokens = data.maxTokens;
    if (typeof data.systemPrompt === 'string') state.systemPrompt = data.systemPrompt;
    if (typeof data.apiBaseUrl === 'string') state.apiBaseUrl = data.apiBaseUrl;
    if (typeof data.apiKey === 'string') state.apiKey = data.apiKey;
  }
}

/**
 * Save settings to localStorage.
 */
export function saveSettings() {
  setItem(STORAGE_KEYS.SETTINGS, {
    temperature: state.temperature,
    maxTokens: state.maxTokens,
    systemPrompt: state.systemPrompt,
    apiBaseUrl: state.apiBaseUrl,
    apiKey: state.apiKey,
  });
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
 */
export function saveTheme(theme) {
  setItem(STORAGE_KEYS.THEME, theme);
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
