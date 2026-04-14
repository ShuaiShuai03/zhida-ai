/**
 * DOM manipulation, component rendering, toast system.
 */

import { state } from './state.js';
import { DEFAULT_SYSTEM_PROMPT, WELCOME_PROMPTS } from './config.js';
import { formatTime, formatRelativeTime, copyToClipboard, escapeHTML } from './utils.js';
import { renderMarkdown, renderStreamingMarkdown } from './markdown.js';

// ---- DOM References (cached) ----
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ============================================
// Toast Notifications
// ============================================

/**
 * Show a toast notification.
 * @param {string} message
 * @param {'success'|'error'|'warning'|'info'} [type='info']
 * @param {number} [duration=1000]
 */
export function showToast(message, type = 'info', duration = 1000) {
  const container = $('#toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.setAttribute('role', 'alert');
  toast.innerHTML = `
    <span class="toast__icon">${getToastIcon(type)}</span>
    <span>${escapeHTML(message)}</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('removing');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }, duration);
}

/**
 * Get SVG icon for toast type.
 * @param {string} type
 * @returns {string}
 */
function getToastIcon(type) {
  const icons = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
  };
  return icons[type] ?? icons.info;
}

// ============================================
// Sidebar Rendering
// ============================================

/**
 * Render the conversation list in the sidebar.
 * @param {string} [searchQuery='']
 */
export function renderConversationList(searchQuery = '') {
  const container = $('#conversation-list');
  if (!container) return;

  let conversations = state.conversations;

  // Filter by search query
  if (searchQuery.trim()) {
    const q = searchQuery.trim().toLowerCase();
    conversations = conversations.filter((c) =>
      c.title.toLowerCase().includes(q) ||
      c.messages.some((m) => m.content.toLowerCase().includes(q))
    );
  }

  if (conversations.length === 0) {
    container.innerHTML = `<div class="conversation-list__empty">${searchQuery ? '没有找到匹配的对话' : '暂无对话记录'}</div>`;
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const conv of conversations) {
    const item = document.createElement('div');
    item.className = `conversation-item${conv.id === state.activeConversationId ? ' active' : ''}`;
    item.dataset.id = conv.id;
    item.setAttribute('role', 'button');
    item.setAttribute('tabindex', '0');
    item.setAttribute('aria-label', `对话: ${conv.title}`);

    const modelDef = state.models.find((m) => m.id === conv.modelId);
    const modelName = modelDef?.name ?? conv.modelId;

    item.innerHTML = `
      <div class="conversation-item__content">
        <div class="conversation-item__title">${escapeHTML(conv.title)}</div>
        <div class="conversation-item__meta">
          <span class="conversation-item__model-tag">${escapeHTML(modelName)}</span>
          <span>${formatRelativeTime(conv.updatedAt ?? conv.createdAt)}</span>
        </div>
      </div>
      <button class="conversation-item__delete" data-id="${conv.id}" aria-label="删除对话" title="删除对话">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
    `;

    fragment.appendChild(item);
  }

  container.innerHTML = '';
  container.appendChild(fragment);
}

// ============================================
// Model Selector
// ============================================

/**
 * Render the model dropdown list.
 */
export function renderModelDropdown() {
  const list = $('#model-list');
  if (!list) return;

  list.innerHTML = '';
  const fragment = document.createDocumentFragment();

  for (const model of state.models) {
    const item = document.createElement('div');
    item.className = `model-selector__item${model.id === state.selectedModelId ? ' selected' : ''}`;
    item.dataset.modelId = model.id;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', model.id === state.selectedModelId);
    item.setAttribute('title', model.description);

    item.innerHTML = `
      <div class="model-selector__item-info">
        <div class="model-selector__item-name">${escapeHTML(model.name)}</div>
        <div class="model-selector__item-desc">${escapeHTML(model.description)}</div>
      </div>
      <span class="badge ${model.badgeClass}">${model.badge}</span>
      <svg class="model-selector__item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
    `;

    fragment.appendChild(item);
  }

  list.appendChild(fragment);
}

/**
 * Update the model selector trigger display.
 */
export function updateModelTrigger() {
  const trigger = $('#model-trigger');
  if (!trigger) return;

  const model = state.selectedModel;
  trigger.innerHTML = `
    <span class="model-name-text">${escapeHTML(model.name)}</span>
    <span class="badge ${model.badgeClass}">${model.badge}</span>
    <svg class="model-selector__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
  `;
}

// ============================================
// Chat Messages
// ============================================

/**
 * Render the full message list for the active conversation.
 */
export function renderMessages() {
  const container = $('#chat-messages-inner');
  if (!container) return;

  const conv = state.activeConversation;
  if (!conv || conv.messages.length === 0) {
    renderWelcomeScreen(container);
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const msg of conv.messages) {
    const el = createMessageElement(msg);
    fragment.appendChild(el);
  }

  container.innerHTML = '';
  container.appendChild(fragment);

  // Scroll to bottom
  requestAnimationFrame(() => scrollToBottom(true));
}

/**
 * Render the welcome / empty state screen.
 * @param {HTMLElement} container
 */
function renderWelcomeScreen(container) {
  const model = state.selectedModel;
  const cards = WELCOME_PROMPTS.map((p) =>
    `<button class="welcome-card" data-prompt="${escapeHTML(p.text)}" aria-label="${escapeHTML(p.text)}">
      <span class="welcome-card__icon">${p.icon}</span>
      <span class="welcome-card__text">${escapeHTML(p.text)}</span>
    </button>`
  ).join('');

  container.innerHTML = `
    <div class="welcome-screen">
      <svg class="welcome-screen__logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2L2 7l10 5 10-5-10-5z"/>
        <path d="M2 17l10 5 10-5"/>
        <path d="M2 12l10 5 10-5"/>
      </svg>
      <h1 class="welcome-screen__title">智答 AI</h1>
      <p class="welcome-screen__subtitle">你的智能 AI 助手</p>
      <div class="welcome-screen__model">
        <span class="badge ${model.badgeClass}">${model.badge}</span>
        ${escapeHTML(model.name)}
      </div>
      <div class="welcome-screen__cards">${cards}</div>
    </div>
  `;
}

/**
 * Create a DOM element for a single message.
 * @param {Object} msg
 * @returns {HTMLElement}
 */
function createMessageElement(msg) {
  const wrapper = document.createElement('div');

  if (msg.role === 'user') {
    wrapper.className = 'message message--user';
    wrapper.innerHTML = `
      <div class="message__avatar" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
      </div>
      <div class="message__bubble">
        <div class="message__text">${escapeHTML(msg.content)}</div>
        <div class="message__time">${formatTime(msg.timestamp)}</div>
        <div class="message__actions">
          <button class="message__action-btn" data-action="copy" data-content="${escapeHTML(msg.content).replace(/"/g, '&quot;')}" aria-label="复制消息">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            <span>复制</span>
          </button>
        </div>
      </div>
    `;
  } else if (msg.role === 'error') {
    wrapper.className = 'message message--error';
    wrapper.innerHTML = `
      <div class="message__avatar" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      </div>
      <div class="message__bubble">
        <span class="error-icon">⚠️</span>
        <span>${escapeHTML(msg.content)}</span>
      </div>
    `;
  } else {
    // AI message
    wrapper.className = 'message message--ai';
    wrapper.dataset.id = msg.id;

    let thinkingHTML = '';
    if (msg.thinking) {
      thinkingHTML = `
        <div class="thinking-block" data-msg-id="${msg.id}">
          <button class="thinking-block__toggle" aria-expanded="false" aria-controls="thinking-content-${msg.id}" aria-label="查看思考过程">
            <span class="thinking-block__toggle-icon">▶</span>
            <span>💭 查看思考过程</span>
          </button>
          <div class="thinking-block__content" id="thinking-content-${msg.id}">
            <div class="message__content">${renderMarkdown(msg.thinking)}</div>
          </div>
        </div>
      `;
    }

    const renderedContent = renderMarkdown(msg.content);

    wrapper.innerHTML = `
      <div class="message__avatar" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
      </div>
      <div class="message__bubble">
        ${thinkingHTML}
        <div class="message__content">${renderedContent}</div>
        <div class="message__time">${formatTime(msg.timestamp)}</div>
        <div class="message__actions">
          <button class="message__action-btn" data-action="copy" data-content="" aria-label="复制消息">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            <span>复制</span>
          </button>
          <button class="message__action-btn" data-action="regenerate" aria-label="重新生成">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            <span>重新生成</span>
          </button>
        </div>
      </div>
    `;

    // Store raw content for copy
    const copyBtn = wrapper.querySelector('[data-action="copy"]');
    if (copyBtn) {
      copyBtn.dataset.content = msg.content;
    }
  }

  return wrapper;
}

// ============================================
// Streaming Message UI
// ============================================

/**
 * Append a new AI message shell for streaming and return update functions.
 * @returns {{ updateContent: function(string): void, updateThinking: function(string): void, finalize: function(): void, element: HTMLElement }}
 */
export function createStreamingMessage() {
  const container = $('#chat-messages-inner');
  if (!container) throw new Error('Chat container not found');

  // Remove welcome screen if present
  const welcome = container.querySelector('.welcome-screen');
  if (welcome) welcome.remove();

  const wrapper = document.createElement('div');
  wrapper.className = 'message message--ai';
  wrapper.innerHTML = `
    <div class="message__avatar" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
    </div>
    <div class="message__bubble">
      <div class="thinking-block expanded hidden" id="streaming-thinking">
        <button class="thinking-block__toggle" aria-expanded="true" aria-controls="streaming-thinking-content">
          <span class="thinking-block__toggle-icon">▶</span>
          <span>💭 思考中...</span>
        </button>
        <div class="thinking-block__content" id="streaming-thinking-content">
          <div class="message__content streaming-thinking-content"></div>
        </div>
      </div>
      <div class="message__content streaming-content">
        <div class="loading-indicator">
          <span class="loading-indicator__dot"></span>
          <span class="loading-indicator__dot"></span>
          <span class="loading-indicator__dot"></span>
        </div>
      </div>
    </div>
  `;

  container.appendChild(wrapper);
  scrollToBottom();

  const contentEl = wrapper.querySelector('.streaming-content');
  const thinkingEl = wrapper.querySelector('.streaming-thinking-content');
  const thinkingBlock = wrapper.querySelector('#streaming-thinking');
  let hasContent = false;
  let hasThinking = false;

  return {
    element: wrapper,

    updateThinking(text) {
      if (!hasThinking) {
        hasThinking = true;
        thinkingBlock.classList.remove('hidden');
      }
      thinkingEl.innerHTML = renderStreamingMarkdown(text);
      autoScrollIfNeeded();
    },

    updateContent(text) {
      if (!hasContent) {
        hasContent = true;
        // Remove loading dots
        const loader = contentEl.querySelector('.loading-indicator');
        if (loader) loader.remove();
      }
      contentEl.innerHTML = renderStreamingMarkdown(text);
      contentEl.classList.add('streaming-cursor');
      autoScrollIfNeeded();
    },

    finalize() {
      contentEl.classList.remove('streaming-cursor');

      // Collapse thinking block
      if (hasThinking && thinkingBlock) {
        thinkingBlock.classList.remove('expanded');
        thinkingBlock.removeAttribute('id');
        const toggleBtn = thinkingBlock.querySelector('.thinking-block__toggle');
        if (toggleBtn) {
          toggleBtn.querySelector('span:last-child').textContent = '💭 查看思考过程';
          toggleBtn.setAttribute('aria-expanded', 'false');
        }
      }
    },
  };
}

/**
 * Append a user message to the chat UI.
 * @param {Object} msg
 */
export function appendUserMessage(msg) {
  const container = $('#chat-messages-inner');
  if (!container) return;

  const welcome = container.querySelector('.welcome-screen');
  if (welcome) welcome.remove();

  const el = createMessageElement(msg);
  container.appendChild(el);
  scrollToBottom(true);
}

/**
 * Replace the streaming message with a finalized message element.
 * @param {HTMLElement} streamingEl - The streaming wrapper to replace
 * @param {Object} msg - The finalized message data
 */
export function replaceStreamingMessage(streamingEl, msg) {
  const finalEl = createMessageElement(msg);
  streamingEl.replaceWith(finalEl);
}

// ============================================
// Auto-scroll
// ============================================

let userHasScrolledUp = false;
let scrollController = null;

/**
 * Set up scroll tracking on the chat messages container.
 */
export function initScrollTracking() {
  const container = $('#chat-messages');
  if (!container) return;

  scrollController = new AbortController();
  container.addEventListener('scroll', () => {
    const { scrollTop, scrollHeight, clientHeight } = container;
    userHasScrolledUp = scrollHeight - scrollTop - clientHeight > 100;
  }, { passive: true, signal: scrollController.signal });
}

/**
 * Scroll to the bottom of the chat messages.
 * @param {boolean} [force=false] - Force scroll even if user has scrolled up
 */
export function scrollToBottom(force = false) {
  const container = $('#chat-messages');
  if (!container) return;
  if (!force && userHasScrolledUp) return;
  container.scrollTop = container.scrollHeight;
}

/**
 * Auto-scroll if the user hasn't manually scrolled up.
 */
function autoScrollIfNeeded() {
  if (!userHasScrolledUp) {
    scrollToBottom();
  }
}

// ============================================
// Input Area
// ============================================

/**
 * Auto-resize the textarea to fit content.
 * @param {HTMLTextAreaElement} textarea
 */
export function autoResizeTextarea(textarea) {
  textarea.style.height = 'auto';
  const maxHeight = 200;
  textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + 'px';
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

/**
 * Update the send button state.
 * @param {boolean} enabled
 */
export function updateSendButton(enabled) {
  const btn = $('#send-btn');
  if (btn) {
    btn.disabled = !enabled;
  }
}

/**
 * Show or hide the stop generation button.
 * @param {boolean} show
 */
export function showStopButton(show) {
  const sendBtn = $('#send-btn');
  const stopBtn = $('#stop-btn');
  if (sendBtn) sendBtn.classList.toggle('hidden', show);
  if (stopBtn) stopBtn.classList.toggle('hidden', !show);
}

// ============================================
// Modal System
// ============================================

/** @type {HTMLElement|null} */
let activeModal = null;
let previousFocusElement = null;

/**
 * Open a modal by ID.
 * @param {string} modalId
 */
export function openModal(modalId) {
  const overlay = document.getElementById(modalId);
  if (!overlay) return;

  previousFocusElement = document.activeElement;
  activeModal = overlay;

  overlay.classList.add('visible');
  overlay.setAttribute('aria-hidden', 'false');

  // Focus first focusable element
  requestAnimationFrame(() => {
    const focusable = overlay.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    focusable?.focus();
  });

  // Trap focus
  overlay.addEventListener('keydown', trapFocus);
}

/**
 * Close the currently open modal.
 */
export function closeModal() {
  if (!activeModal) return;

  const closing = activeModal;
  const prevFocus = previousFocusElement;

  // Clear state first to prevent recursive calls
  activeModal = null;
  previousFocusElement = null;

  closing.classList.remove('visible');
  closing.setAttribute('aria-hidden', 'true');
  closing.removeEventListener('keydown', trapFocus);

  // Restore focus
  prevFocus?.focus();

  // Dispatch event so showConfirm can detect external closes (Escape key)
  closing.dispatchEvent(new CustomEvent('modal-closed'));
}

/**
 * Check if any modal is currently open.
 * @returns {boolean}
 */
export function isModalOpen() {
  return activeModal !== null;
}

/**
 * Trap focus within the modal.
 * @param {KeyboardEvent} e
 */
function trapFocus(e) {
  if (e.key !== 'Tab' || !activeModal) return;

  const focusables = activeModal.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  const first = focusables[0];
  const last = focusables[focusables.length - 1];

  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last?.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first?.focus();
  }
}

// ============================================
// Confirm Dialog
// ============================================

/**
 * Show a confirmation dialog and return a promise.
 * @param {string} message
 * @returns {Promise<boolean>}
 */
export function showConfirm(message) {
  return new Promise((resolve) => {
    const overlay = $('#confirm-modal');
    const messageEl = $('#confirm-message');
    const confirmBtn = $('#confirm-ok-btn');
    const cancelBtn = $('#confirm-cancel-btn');

    if (!overlay || !messageEl) {
      resolve(window.confirm(message));
      return;
    }

    messageEl.textContent = message;

    let resolved = false;
    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      confirmBtn?.removeEventListener('click', onConfirm);
      cancelBtn?.removeEventListener('click', onCancel);
      // Remove close-button and overlay-click watchers
      overlay.querySelectorAll('.modal__close').forEach((b) =>
        b.removeEventListener('click', onDismiss)
      );
      overlay.removeEventListener('click', onOverlayClick);
      // Remove modal-closed listener BEFORE closeModal() to prevent
      // onDismiss from resolving the promise prematurely via the
      // synchronous 'modal-closed' event dispatch.
      overlay.removeEventListener('modal-closed', onDismiss);
      closeModal();
    };

    const onConfirm = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    const onDismiss = () => { cleanup(); resolve(false); };
    const onOverlayClick = (e) => {
      if (e.target === overlay) onDismiss();
    };

    confirmBtn?.addEventListener('click', onConfirm);
    cancelBtn?.addEventListener('click', onCancel);
    overlay.querySelectorAll('.modal__close').forEach((b) =>
      b.addEventListener('click', onDismiss)
    );
    overlay.addEventListener('click', onOverlayClick);
    // Handle external close (e.g. Escape key)
    overlay.addEventListener('modal-closed', onDismiss, { once: true });

    openModal('confirm-modal');
  });
}

// ============================================
// Sidebar Toggle
// ============================================

/**
 * Toggle sidebar visibility.
 */
export function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  const sidebar = $('.sidebar');
  const overlay = $('.sidebar-overlay');
  if (sidebar) sidebar.classList.toggle('open', state.sidebarOpen);
  if (overlay) overlay.classList.toggle('visible', state.sidebarOpen);
}

/**
 * Close the sidebar (for mobile overlay tap).
 */
export function closeSidebar() {
  state.sidebarOpen = false;
  const sidebar = $('.sidebar');
  const overlay = $('.sidebar-overlay');
  if (sidebar) sidebar.classList.remove('open');
  if (overlay) overlay.classList.remove('visible');
}

// ============================================
// System Prompt Indicator
// ============================================

/**
 * Update the system prompt indicator visibility.
 */
export function updateSystemPromptIndicator() {
  const indicator = $('.system-prompt-indicator');
  if (!indicator) return;
  const isCustom = state.systemPrompt !== DEFAULT_SYSTEM_PROMPT;
  indicator.classList.toggle('active', isCustom);
}

// ============================================
// Code Block Copy Delegation
// ============================================

let copyController = null;

/**
 * Initialise code block copy button event delegation.
 */
export function initCodeBlockCopy() {
  copyController = new AbortController();
  document.addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('.code-block__copy');
    if (!copyBtn) return;

    // Decode the escaped HTML content back to plain text
    const codeData = copyBtn.dataset.code;
    if (!codeData) return;

    const textarea = document.createElement('textarea');
    textarea.innerHTML = codeData;
    const plainText = textarea.value;

    const success = await copyToClipboard(plainText);
    if (success) {
      const span = copyBtn.querySelector('span');
      const originalText = span?.textContent;
      copyBtn.classList.add('copied');
      if (span) span.textContent = '已复制!';

      setTimeout(() => {
        copyBtn.classList.remove('copied');
        if (span) span.textContent = originalText;
      }, 2000);
    }
  }, { signal: copyController.signal });
}

// ============================================
// Network Status Banner
// ============================================

let networkController = null;

/**
 * Initialise network status monitoring.
 */
export function initNetworkStatus() {
  const banner = $('.offline-banner');
  if (!banner) return;

  const update = () => {
    banner.classList.toggle('visible', !navigator.onLine);
  };

  networkController = new AbortController();
  window.addEventListener('online', update, { signal: networkController.signal });
  window.addEventListener('offline', update, { signal: networkController.signal });
  update();
}

/**
 * Cleanup UI event listeners.
 */
export function cleanupUI() {
  if (scrollController) {
    scrollController.abort();
    scrollController = null;
  }
  if (copyController) {
    copyController.abort();
    copyController = null;
  }
  if (networkController) {
    networkController.abort();
    networkController = null;
  }
}
