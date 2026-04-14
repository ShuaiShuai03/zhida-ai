/**
 * Application state management — single source of truth.
 */

import { MODELS, DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS, DEFAULT_SYSTEM_PROMPT, DEFAULT_API_BASE_URL, DEFAULT_API_KEY } from './config.js';

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
  /** @type {string} */
  #apiKey = DEFAULT_API_KEY;

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
  get sidebarOpen() { return this.#sidebarOpen; }
  get temperature() { return this.#temperature; }
  get maxTokens() { return this.#maxTokens; }
  get systemPrompt() { return this.#systemPrompt; }
  get apiBaseUrl() { return this.#apiBaseUrl; }
  get apiKey() { return this.#apiKey; }

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
    return this.#models.find((m) => m.id === this.#selectedModelId) ?? this.#models[0];
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

  set apiKey(value) {
    this.#apiKey = value;
    this.#notify('settings');
  }

  /**
   * Check whether the API is configured (both base URL and key present).
   * @returns {boolean}
   */
  get isApiConfigured() {
    return Boolean(this.#apiBaseUrl && this.#apiKey);
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
