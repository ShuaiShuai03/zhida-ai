/**
 * Application state management — single source of truth.
 */

import {
  MODELS,
  DEFAULT_TEMPERATURE,
  DEFAULT_MAX_TOKENS,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_API_BASE_URL,
  DEFAULT_REASONING_EFFORT,
} from './config.js';

/**
 * @typedef {Object} Message
 * @property {string} id
 * @property {'user'|'ai'|'error'} role
 * @property {string} content
 * @property {string} [thinking] - Reasoning / thinking content for thinking models
 * @property {number} timestamp
 */

/**
 * @typedef {Object} Conversation
 * @property {string} id
 * @property {string} title
 * @property {string} modelId
 * @property {string} systemPrompt
 * @property {Message[]} messages
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {boolean} [pinned]
 * @property {string[]} [tags]
 */

/**
 * Reactive state store with subscriber support.
 */
class AppState {
  /** @type {Conversation[]} */
  #conversations = [];
  /** @type {string|null} */
  #activeConversationId = null;
  /** @type {string} */
  #selectedModelId = MODELS[0].id;
  /** @type {Array} */
  #models = MODELS;
  /** @type {boolean} */
  #isStreaming = false;
  /** @type {AbortController|null} */
  #abortController = null;
  /** @type {string|null} */
  #currentRequestId = null;
  /** @type {string|null} */
  #currentResponseId = null;
  /** @type {boolean} */
  #sidebarOpen = false;
  /** @type {number} */
  #temperature = DEFAULT_TEMPERATURE;
  /** @type {number} */
  #maxTokens = DEFAULT_MAX_TOKENS;
  /** @type {string} */
  #systemPrompt = DEFAULT_SYSTEM_PROMPT;
  /** @type {string} */
  #apiBaseUrl = DEFAULT_API_BASE_URL;
  /** @type {boolean} */
  #apiConfigured = false;
  /** @type {boolean|null} */
  #backendAvailable = null;
  /** @type {string} */
  #backendError = '';
  /** @type {boolean} */
  #webSearchEnabled = false;
  /** @type {'low'|'medium'|'high'|'xhigh'} */
  #reasoningEffort = DEFAULT_REASONING_EFFORT;

  /** @type {Map<string, Set<Function>>} */
  #listeners = new Map();

  // ---- Getters ----

  get conversations() { return this.#conversations; }
  get activeConversationId() { return this.#activeConversationId; }
  get selectedModelId() { return this.#selectedModelId; }
  get models() { return this.#models; }
  get isStreaming() { return this.#isStreaming; }
  get abortController() { return this.#abortController; }
  get currentRequestId() { return this.#currentRequestId; }
  get currentResponseId() { return this.#currentResponseId; }
  get sidebarOpen() { return this.#sidebarOpen; }
  get temperature() { return this.#temperature; }
  get maxTokens() { return this.#maxTokens; }
  get systemPrompt() { return this.#systemPrompt; }
  get apiBaseUrl() { return this.#apiBaseUrl; }
  get backendAvailable() { return this.#backendAvailable; }
  get backendError() { return this.#backendError; }
  get webSearchEnabled() { return this.#webSearchEnabled; }
  get reasoningEffort() { return this.#reasoningEffort; }

  /**
   * Get the currently active conversation object.
   * @returns {Conversation|null}
   */
  get activeConversation() {
    return this.#conversations.find((c) => c.id === this.#activeConversationId) ?? null;
  }

  /**
   * Get the selected model definition.
   * @returns {Object}
   */
  get selectedModel() {
    const model = this.#models.find((m) => m.id === this.#selectedModelId);
    if (model) return model;
    return {
      id: this.#selectedModelId,
      name: this.#selectedModelId ? `${this.#selectedModelId}（模型不可用）` : '模型不可用',
      badge: '不可用',
      badgeClass: 'badge--standard',
      type: 'unavailable',
      description: '当前模型不在可用模型列表中，请重新选择模型。',
      supportsResponses: false,
      supportsWebSearch: false,
      supportsReasoningEffort: false,
      capabilityReason: '当前会话使用的模型不可用。请重新选择一个可用模型后重试。',
      unavailable: true,
    };
  }

  // ---- Setters (with notification) ----

  set conversations(value) {
    this.#conversations = value;
    this.#notify('conversations');
  }

  set activeConversationId(value) {
    this.#activeConversationId = value;
    this.#notify('activeConversation');
  }

  set selectedModelId(value) {
    this.#selectedModelId = value;
    this.#notify('selectedModel');
  }

  set models(value) {
    this.#models = value;
    this.#notify('models');
  }

  set isStreaming(value) {
    this.#isStreaming = value;
    this.#notify('streaming');
  }

  set abortController(value) {
    this.#abortController = value;
  }

  set currentRequestId(value) {
    this.#currentRequestId = value;
  }

  set currentResponseId(value) {
    this.#currentResponseId = value;
  }

  set sidebarOpen(value) {
    this.#sidebarOpen = value;
    this.#notify('sidebar');
  }

  set temperature(value) {
    this.#temperature = value;
    this.#notify('settings');
  }

  set maxTokens(value) {
    this.#maxTokens = value;
    this.#notify('settings');
  }

  set systemPrompt(value) {
    this.#systemPrompt = value;
    this.#notify('settings');
  }

  set apiBaseUrl(value) {
    this.#apiBaseUrl = value;
    this.#notify('settings');
  }

  set apiConfigured(value) {
    this.#apiConfigured = Boolean(value);
    this.#notify('settings');
  }

  set backendAvailable(value) {
    this.#backendAvailable = value === null ? null : Boolean(value);
    this.#notify('settings');
  }

  set backendError(value) {
    this.#backendError = String(value || '');
    this.#notify('settings');
  }

  set webSearchEnabled(value) {
    this.#webSearchEnabled = Boolean(value);
    this.#notify('settings');
  }

  set reasoningEffort(value) {
    const allowed = new Set(['low', 'medium', 'high', 'xhigh']);
    this.#reasoningEffort = allowed.has(value) ? value : DEFAULT_REASONING_EFFORT;
    this.#notify('settings');
  }

  /**
   * Check whether the backend reports a saved API configuration.
   * @returns {boolean}
   */
  get isApiConfigured() {
    return this.#apiConfigured;
  }

  // ---- Subscriber Pattern ----

  /**
   * Subscribe to state changes for a given key.
   * @param {string} key
   * @param {Function} callback
   * @returns {Function} Unsubscribe function
   */
  on(key, callback) {
    if (!this.#listeners.has(key)) {
      this.#listeners.set(key, new Set());
    }
    this.#listeners.get(key).add(callback);
    return () => this.#listeners.get(key)?.delete(callback);
  }

  /**
   * Notify subscribers for a given key.
   * @param {string} key
   */
  #notify(key) {
    this.#listeners.get(key)?.forEach((cb) => {
      try { cb(); } catch (e) { console.error('State listener error:', e); }
    });
  }

  // ---- Convenience Methods ----

  /**
   * Update the active conversation in the conversations array.
   * @param {Function} updater - Receives the conversation, should mutate it
   */
  updateActiveConversation(updater) {
    const conv = this.activeConversation;
    if (!conv) return;
    updater(conv);
    conv.updatedAt = Date.now();
    this.#notify('conversations');
    this.#notify('activeConversation');
  }

  /**
   * Add a conversation to the list.
   * @param {Conversation} conversation
   */
  addConversation(conversation) {
    this.#conversations.unshift(conversation);
    this.#notify('conversations');
  }

  /**
   * Remove a conversation by ID.
   * @param {string} id
   */
  removeConversation(id) {
    this.#conversations = this.#conversations.filter((c) => c.id !== id);
    if (this.#activeConversationId === id) {
      this.#activeConversationId = null;
      this.#notify('activeConversation');
    }
    this.#notify('conversations');
  }

  /**
   * Clear all conversations.
   */
  clearAllConversations() {
    this.#conversations = [];
    this.#activeConversationId = null;
    this.#notify('conversations');
    this.#notify('activeConversation');
  }

  /**
   * Abort the current streaming request.
   */
  abortStream() {
    if (this.#abortController) {
      this.#abortController.abortReason ??= 'user';
      this.#abortController.abort();
      this.#abortController = null;
    }
    this.isStreaming = false;
  }
}

export const state = new AppState();
