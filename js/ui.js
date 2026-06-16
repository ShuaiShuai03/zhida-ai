/**
 * DOM manipulation, component rendering, toast system.
 */

import { state } from './state.js';
import { DEFAULT_SYSTEM_PROMPT, WELCOME_PROMPTS } from './config.js';
import { formatTime, formatRelativeTime, copyToClipboard, escapeHTML } from './utils.js';
import { filterConversations, sortConversationsByUpdatedAt } from './conversation-utils.js';
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
    <span class="toast__message">${escapeHTML(message)}</span>
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

  let conversations = sortConversationsByUpdatedAt(state.conversations);

  // Filter by search query
  if (searchQuery.trim()) {
    conversations = filterConversations(conversations, searchQuery, state.models);
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
    item.dataset.title = conv.title;
    item.setAttribute('role', 'button');
    item.setAttribute('tabindex', '0');
    item.setAttribute('aria-label', `对话: ${conv.title}`);
    if (conv.id === state.activeConversationId) {
      item.setAttribute('aria-current', 'true');
    }

    const modelDef = state.models.find((m) => m.id === conv.modelId);
    const modelName = modelDef?.name ?? (conv.modelId ? `${conv.modelId}（模型不可用）` : '模型不可用');
    const tags = Array.isArray(conv.tags) ? conv.tags : [];
    const escapedConversationId = escapeHTML(String(conv.id ?? ''));
    const tagHtml = tags.length
      ? `<div class="conversation-item__tags">${tags.map((tag) => `<span>#${escapeHTML(tag)}</span>`).join('')}</div>`
      : '';

    item.innerHTML = `
      <div class="conversation-item__content">
        <div class="conversation-item__title">${conv.pinned ? '<span class="conversation-item__pin-mark" aria-label="已置顶">★</span>' : ''}<span class="conversation-item__title-text">${escapeHTML(conv.title)}</span></div>
        ${tagHtml}
        <div class="conversation-item__meta">
          <span class="conversation-item__model-tag">${escapeHTML(modelName)}</span>
          <span>${formatRelativeTime(conv.updatedAt ?? conv.createdAt)}</span>
        </div>
      </div>
      <div class="conversation-item__actions">
        <button class="conversation-item__action conversation-item__rename" data-id="${escapedConversationId}" aria-label="重命名对话" title="重命名">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        </button>
        <button class="conversation-item__action conversation-item__pin" data-id="${escapedConversationId}" aria-label="${conv.pinned ? '取消置顶对话' : '置顶对话'}" title="${conv.pinned ? '取消置顶' : '置顶'}" aria-pressed="${conv.pinned ? 'true' : 'false'}">
          <svg viewBox="0 0 24 24" fill="${conv.pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27z"/></svg>
        </button>
        <button class="conversation-item__action conversation-item__tags-btn" data-id="${escapedConversationId}" aria-label="编辑对话标签" title="编辑标签">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41 12 22l-10-10V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
        </button>
        <button class="conversation-item__action conversation-item__delete" data-id="${escapedConversationId}" aria-label="删除对话" title="删除对话">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
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
  updateRuntimeSettingsSummary();
}

export function updateComposerCapabilityControls() {
  const webSearchToggle = $('#web-search-toggle');
  const webSearchControl = $('.tool-toggle');
  const reasoningSelect = $('#reasoning-effort-select');
  const reasoningControl = $('.reasoning-control');
  const webSearchContextSelect = $('#web-search-context-select');
  const webSearchContextControl = $('.search-context-control');
  const model = state.selectedModel;
  const modelUnavailable = Boolean(model?.unavailable);
  const webSearchSupported = Boolean(model?.supportsWebSearch);
  const reasoningSupported = Boolean(model?.supportsReasoningEffort);
  const webSearchDisabled = modelUnavailable || !webSearchSupported;
  const searchContextDisabled = webSearchDisabled || !state.webSearchEnabled;
  const reasoningDisabled = modelUnavailable || !reasoningSupported;

  // Preserve the user's stored preference, but only expose controls when the
  // selected model can actually use the corresponding Responses capability.
  if (webSearchToggle) {
    webSearchToggle.checked = !webSearchDisabled && Boolean(state.webSearchEnabled);
    webSearchToggle.disabled = webSearchDisabled;
    webSearchToggle.setAttribute('aria-disabled', String(webSearchDisabled));
  }
  if (webSearchControl) {
    webSearchControl.classList.toggle('disabled', webSearchDisabled);
    webSearchControl.title = modelUnavailable
      ? '请先选择一个可用模型'
      : webSearchSupported
      ? '使用 Responses API 的网络搜索工具'
      : '当前模型不支持网络搜索';
  }
  if (reasoningSelect) {
    reasoningSelect.value = state.reasoningEffort;
    reasoningSelect.disabled = reasoningDisabled;
    reasoningSelect.setAttribute('aria-disabled', String(reasoningDisabled));
    reasoningSelect.title = modelUnavailable
      ? '请先选择一个可用模型'
      : reasoningSupported
      ? '通过 Responses API 设置推理深度'
      : '当前模型不支持推理深度';
  }
  if (reasoningControl) {
    reasoningControl.classList.toggle('disabled', reasoningDisabled);
    reasoningControl.title = modelUnavailable
      ? '请先选择一个可用模型'
      : reasoningSupported
      ? '通过 Responses API 设置推理深度'
      : '当前模型不支持推理深度';
  }
  if (webSearchContextSelect) {
    webSearchContextSelect.value = state.webSearchContextSize;
    webSearchContextSelect.disabled = searchContextDisabled;
    webSearchContextSelect.setAttribute('aria-disabled', String(searchContextDisabled));
    webSearchContextSelect.title = modelUnavailable
      ? '请先选择一个可用模型'
      : webSearchSupported && state.webSearchEnabled
      ? '设置网络搜索上下文范围'
      : webSearchSupported
      ? '开启网络搜索后可设置搜索范围'
      : '当前模型不支持网络搜索';
  }
  if (webSearchContextControl) {
    webSearchContextControl.classList.toggle('disabled', searchContextDisabled);
    webSearchContextControl.title = modelUnavailable
      ? '请先选择一个可用模型'
      : webSearchSupported && state.webSearchEnabled
      ? '设置网络搜索上下文范围'
      : webSearchSupported
      ? '开启网络搜索后可设置搜索范围'
      : '当前模型不支持网络搜索';
  }
  updateRuntimeSettingsSummary();
  updateRuntimeTemperatureUI();
}

export function updateRuntimeSettingsSummary() {
  const summary = $('#runtime-model-summary');
  const capability = $('#runtime-model-capability');
  const composerModelPill = $('#composer-model-pill');
  const model = state.selectedModel;
  if (summary) {
    const capabilityText = [
      model.supportsWebSearch ? '支持联网' : '不支持联网',
      model.supportsReasoningEffort ? '支持推理深度' : '无推理深度',
    ].join(' · ');
    summary.innerHTML = `
      <span class="runtime-summary__name">${escapeHTML(model.name)}</span>
      <span class="runtime-summary__desc">${escapeHTML(model.description || capabilityText)}</span>
    `;
  }
  if (capability) {
    capability.textContent = model.unavailable
      ? '不可用'
      : model.supportsResponses
      ? 'Responses'
      : 'Chat';
  }
  if (composerModelPill) {
    const searchState = model.supportsWebSearch && state.webSearchEnabled ? '联网开启' : '联网关闭';
    composerModelPill.textContent = `${model.name} · ${searchState}`;
    composerModelPill.title = `${model.name} · ${model.description || searchState}`;
  }
}

export function updateRuntimeTemperatureUI() {
  const runtimeTemperature = $('#runtime-temperature');
  const runtimeTemperatureValue = $('#runtime-temperature-value');
  if (runtimeTemperature) {
    runtimeTemperature.value = String(state.temperature);
  }
  if (runtimeTemperatureValue) {
    runtimeTemperatureValue.textContent = state.temperature.toFixed(1);
  }
}

export function openRuntimeSettings() {
  const panel = $('#runtime-settings-panel');
  const backdrop = $('.runtime-backdrop');
  const trigger = $('#runtime-settings-btn');
  if (!panel || !trigger) return;

  updateComposerCapabilityControls();
  panel.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');
  trigger.setAttribute('aria-expanded', 'true');
  backdrop?.classList.add('visible');
  requestAnimationFrame(() => {
    panel.querySelector('input, select, button')?.focus();
  });
}

export function closeRuntimeSettings() {
  const panel = $('#runtime-settings-panel');
  const backdrop = $('.runtime-backdrop');
  const trigger = $('#runtime-settings-btn');
  if (!panel || !trigger) return;

  panel.classList.remove('open');
  panel.setAttribute('aria-hidden', 'true');
  trigger.setAttribute('aria-expanded', 'false');
  backdrop?.classList.remove('visible');
}

export function isRuntimeSettingsOpen() {
  return Boolean($('#runtime-settings-panel')?.classList.contains('open'));
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
  const backendStatus = getWelcomeBackendStatus();
  const backendStatusClass = getWelcomeStatusClass(backendStatus.badge);
  const cards = WELCOME_PROMPTS.map((p) =>
    `<button class="welcome-card" data-prompt="${escapeHTML(p.text)}" aria-label="插入建议：${escapeHTML(p.title)}">
      <span class="welcome-card__icon" aria-hidden="true">${escapeHTML(p.icon)}</span>
      <span class="welcome-card__body">
        <span class="welcome-card__title">${escapeHTML(p.title)}</span>
        <span class="welcome-card__text">${escapeHTML(p.text)}</span>
      </span>
    </button>`
  ).join('');

  container.innerHTML = `
    <div class="welcome-screen">
      <div class="welcome-screen__hero">
        <div class="welcome-screen__logo" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/>
            <path d="M2 17l10 5 10-5"/>
            <path d="M2 12l10 5 10-5"/>
          </svg>
        </div>
        <p class="welcome-screen__eyebrow">AI workspace</p>
        <h1 class="welcome-screen__title">智答 AI</h1>
        <p class="welcome-screen__subtitle">选择一个任务入口，或直接在下方输入问题开始工作。</p>
        <div class="welcome-screen__model">
          <span class="badge ${model.badgeClass}">${model.badge}</span>
          <span>${escapeHTML(model.name)}</span>
        </div>
      </div>
      <div class="welcome-screen__section-heading">
        <span>常用任务</span>
      </div>
      <div class="welcome-screen__cards">${cards}</div>
      <div id="welcome-backend-status-wrap" class="welcome-screen__backend-status welcome-screen__backend-status--${backendStatusClass}">
        <div class="welcome-screen__backend-status-row">
          <span id="welcome-backend-status-badge" class="welcome-screen__backend-status-badge">${escapeHTML(backendStatus.title)}</span>
          <span class="welcome-screen__backend-state">${escapeHTML(backendStatus.stateText)}</span>
        </div>
        <p id="welcome-backend-status" class="welcome-screen__backend-status-message">
          ${escapeHTML(backendStatus.message)}
        </p>
        <div class="welcome-screen__actions">
          <button id="welcome-focus-input-btn" type="button" class="btn btn--primary" aria-label="开始提问">
            开始提问
          </button>
          <button id="welcome-open-settings-btn" type="button" class="btn btn--secondary" aria-label="配置 API">
            配置 API
          </button>
          <button id="welcome-import-data-btn" type="button" class="btn btn--ghost" aria-label="导入数据">
            导入数据
          </button>
        </div>
      </div>
    </div>
  `;
}

function getWelcomeBackendStatus() {
  if (state.backendAvailable === false) {
    return {
      title: '后端状态',
      stateText: '静态服务器',
      message: state.backendError || '当前是纯静态服务器，缺少 Node 后端代理，不能保存 API key、获取模型或聊天。',
      badge: 'error',
    };
  }

  if (state.backendAvailable === true && state.isApiConfigured) {
    const displayedEndpoint = formatApiBaseUrlForDisplay(state.apiBaseUrl);
    const configuredEndpoint = displayedEndpoint ? `，当前地址 ${displayedEndpoint}` : '';
    return {
      title: '后端状态',
      stateText: '后端可用 · 已配置',
      message: `后端代理已可用${configuredEndpoint}，可直接开始对话。`,
      badge: 'configured',
    };
  }

  if (state.backendAvailable === true) {
    return {
      title: '后端状态',
      stateText: '后端可用',
      message: '后端已就绪，但尚未配置 API 地址与密钥。请先打开设置完成配置。',
      badge: 'ready',
    };
  }

  return {
    title: '后端状态',
    stateText: '检测中',
    message: '正在检测后端运行状态，请稍候…',
    badge: 'loading',
  };
}

function formatApiBaseUrlForDisplay(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function getWelcomeStatusClass(value) {
  return ['error', 'configured', 'ready', 'loading'].includes(value) ? value : 'loading';
}

export function updateWelcomeBackendStatus() {
  const statusWrap = $('#welcome-backend-status-wrap');
  const statusBadge = $('#welcome-backend-status-badge');
  const statusState = $('#welcome-backend-status-wrap .welcome-screen__backend-state');
  const statusText = $('#welcome-backend-status');
  if (!statusWrap || !statusBadge || !statusState || !statusText) return;

  const status = getWelcomeBackendStatus();
  statusWrap.className = `welcome-screen__backend-status welcome-screen__backend-status--${getWelcomeStatusClass(status.badge)}`;
  statusBadge.textContent = status.title;
  statusState.textContent = status.stateText;
  statusText.textContent = status.message;
}

/**
 * Create a DOM element for a single message.
 * @param {Object} msg
 * @returns {HTMLElement}
 */
function createMessageElement(msg) {
  const wrapper = document.createElement('div');
  const fileResultsHTML = createFileResultsModule(msg);

  if (msg.role === 'user') {
    wrapper.className = 'message message--user';
    wrapper.innerHTML = `
      <div class="message__avatar" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
      </div>
      <div class="message__bubble">
        <div class="message__text">${escapeHTML(msg.content)}</div>
        ${fileResultsHTML}
        <div class="message__time">${formatTime(msg.timestamp)}</div>
        <div class="message__actions">
          <button type="button" class="message__action-btn" data-action="copy" data-content="" aria-label="复制消息">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            <span>复制</span>
          </button>
        </div>
      </div>
    `;
    const copyBtn = wrapper.querySelector('[data-action="copy"]');
    if (copyBtn) {
      copyBtn.dataset.content = msg.content;
    }
  } else if (msg.role === 'error') {
    wrapper.className = 'message message--error';
    wrapper.setAttribute('role', 'alert');
    wrapper.setAttribute('aria-live', 'assertive');
    wrapper.innerHTML = `
      <div class="message__avatar" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      </div>
      <div class="message__bubble">
        <span class="error-icon">!</span>
        <span>${escapeHTML(msg.content)}</span>
      </div>
    `;
  } else {
    // AI message
    wrapper.className = 'message message--ai';
    wrapper.dataset.id = msg.id;

    let thinkingHTML = '';
    if (msg.thinking) {
      const escapedMessageId = escapeHTML(String(msg.id ?? ''));
      thinkingHTML = `
        <div class="thinking-block" data-msg-id="${escapedMessageId}">
          <button class="thinking-block__toggle" aria-expanded="false" aria-controls="thinking-content-${escapedMessageId}" aria-label="查看思考过程">
            <span class="thinking-block__toggle-icon">▶</span>
            <span>查看思考过程</span>
          </button>
          <div class="thinking-block__content" id="thinking-content-${escapedMessageId}">
            <div class="message__content">${renderMarkdown(msg.thinking)}</div>
          </div>
        </div>
      `;
    }

    const renderedContent = renderMarkdown(msg.content);
    const summaryText = getMessageSummary(msg.content);
    const citationsHTML = createCitationModule(msg.content);

    wrapper.innerHTML = `
      <div class="message__avatar" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
      </div>
      <article class="message__bubble ai-response-card" aria-label="AI 回复">
        <header class="ai-response-card__header">
          <div>
            <span class="ai-response-card__eyebrow">回答摘要</span>
            <p class="ai-response-card__summary">${escapeHTML(summaryText)}</p>
          </div>
        </header>
        ${thinkingHTML}
        <div class="ai-response-card__body">
          <div class="message__content">${renderedContent}</div>
        </div>
        ${citationsHTML}
        ${fileResultsHTML}
        <footer class="ai-response-card__footer">
          <div class="message__time">${formatTime(msg.timestamp)}</div>
          <div class="message__actions">
          <button type="button" class="message__action-btn" data-action="copy" data-content="" aria-label="复制消息">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            <span>复制</span>
          </button>
          <button type="button" class="message__action-btn" data-action="regenerate" aria-label="重新生成">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            <span>重新生成</span>
          </button>
          <button type="button" class="message__action-btn" data-action="follow-up" data-content="" aria-label="追问">
            <span>追问</span>
          </button>
          <button type="button" class="message__action-btn" data-action="export-section" data-content="" aria-label="导出此段">
            <span>导出此段</span>
          </button>
          </div>
        </footer>
      </article>
    `;

    // Store raw content for copy
    wrapper.querySelectorAll('[data-content]').forEach((btn) => {
      btn.dataset.content = msg.content;
    });
  }

  return wrapper;
}

function getMessageSummary(content) {
  const plain = String(content || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#>*_`~-]/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  if (!plain) return '回复已生成。';
  return plain.length > 120 ? `${plain.slice(0, 118)}…` : plain;
}

function createCitationModule(content) {
  const raw = String(content || '');
  const sourceIndex = raw.search(/\n#{2,3}\s*来源\b/);
  if (sourceIndex < 0) return '';

  const sourceText = raw.slice(sourceIndex);
  const matches = [...sourceText.matchAll(/\d+\.\s+\[([^\]]+)\]\(([^)]+)\)/g)];
  if (matches.length === 0) return '';

  const items = matches.slice(0, 6).map((match) => `
    <li>
      <a href="${escapeHTML(match[2])}" target="_blank" rel="noopener noreferrer">${escapeHTML(match[1])}</a>
    </li>
  `).join('');

  return `
    <section class="ai-response-card__module" aria-label="引用来源">
      <button type="button" class="ai-response-card__module-toggle" aria-expanded="false">
        <span>引用来源</span>
        <span>${matches.length} 条</span>
      </button>
      <ol class="ai-response-card__sources">${items}</ol>
    </section>
  `;
}

function createFileResultsModule(msg) {
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  if (attachments.length === 0) return '';

  const items = attachments.slice(0, 6).map((att) => {
    const name = att.name || '未命名文件';
    const type = att.type || '文件';
    return `<li><span>${escapeHTML(name)}</span><small>${escapeHTML(type)}</small></li>`;
  }).join('');

  return `
    <section class="ai-response-card__module message-file-results" aria-label="文件结果">
      <div class="ai-response-card__module-title">文件结果</div>
      <ul>${items}</ul>
    </section>
  `;
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
  wrapper.setAttribute('aria-live', 'polite');
  wrapper.setAttribute('aria-busy', 'true');
  wrapper.innerHTML = `
    <div class="message__avatar" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
    </div>
    <article class="message__bubble ai-response-card ai-response-card--streaming" aria-label="AI 正在回复">
      <header class="ai-response-card__header">
        <div>
          <span class="ai-response-card__eyebrow">正在生成</span>
          <p class="ai-response-card__summary">正在组织结论和正文。</p>
        </div>
      </header>
      <div class="thinking-block expanded hidden" id="streaming-thinking">
        <button class="thinking-block__toggle" aria-expanded="true" aria-controls="streaming-thinking-content">
          <span class="thinking-block__toggle-icon">▶</span>
          <span>思考中...</span>
        </button>
        <div class="thinking-block__content" id="streaming-thinking-content">
          <div class="message__content streaming-thinking-content"></div>
        </div>
      </div>
      <div class="ai-response-card__body">
        <div class="message__content streaming-content">
          <div class="loading-indicator" role="status" aria-label="正在生成回复">
            <span class="loading-indicator__dot"></span>
            <span class="loading-indicator__dot"></span>
            <span class="loading-indicator__dot"></span>
          </div>
        </div>
      </div>
      <div class="streaming-status hidden" aria-live="polite"></div>
    </article>
  `;

  container.appendChild(wrapper);
  scrollToBottom();

  const contentEl = wrapper.querySelector('.streaming-content');
  const statusEl = wrapper.querySelector('.streaming-status');
  const thinkingEl = wrapper.querySelector('.streaming-thinking-content');
  const thinkingBlock = wrapper.querySelector('#streaming-thinking');
  let hasContent = false;
  let hasThinking = false;
  let pendingFrameId = null;
  let pendingContentText = null;
  let pendingThinkingText = null;

  const renderThinking = (text) => {
    if (!hasThinking) {
      hasThinking = true;
      thinkingBlock.classList.remove('hidden');
    }
    thinkingEl.innerHTML = renderStreamingMarkdown(text);
  };

  const renderContent = (text) => {
    if (!hasContent) {
      hasContent = true;
      const loader = contentEl.querySelector('.loading-indicator');
      if (loader) loader.remove();
    }
    contentEl.innerHTML = renderStreamingMarkdown(text);
    contentEl.classList.add('streaming-cursor');
  };

  const flushPendingRender = () => {
    if (pendingThinkingText !== null) {
      renderThinking(pendingThinkingText);
      pendingThinkingText = null;
    }
    if (pendingContentText !== null) {
      renderContent(pendingContentText);
      pendingContentText = null;
    }
    autoScrollIfNeeded();
  };

  const cancelPendingFrame = () => {
    if (pendingFrameId === null) return;
    cancelAnimationFrame(pendingFrameId);
    pendingFrameId = null;
  };

  const scheduleRender = () => {
    if (pendingFrameId !== null) return;
    pendingFrameId = requestAnimationFrame(() => {
      pendingFrameId = null;
      flushPendingRender();
    });
  };

  return {
    element: wrapper,

    updateThinking(text) {
      pendingThinkingText = text;
      scheduleRender();
    },

    updateContent(text) {
      pendingContentText = text;
      scheduleRender();
    },

    updateStatus(text) {
      if (!statusEl) return;
      const value = String(text || '').trim();
      statusEl.textContent = value;
      statusEl.classList.toggle('hidden', !value);
      autoScrollIfNeeded();
    },

    finalize() {
      cancelPendingFrame();
      flushPendingRender();
      wrapper.setAttribute('aria-busy', 'false');
      contentEl.classList.remove('streaming-cursor');
      statusEl?.classList.add('hidden');

      // Collapse thinking block
      if (hasThinking && thinkingBlock) {
        thinkingBlock.classList.remove('expanded');
        thinkingBlock.removeAttribute('id');
        const toggleBtn = thinkingBlock.querySelector('.thinking-block__toggle');
        if (toggleBtn) {
          toggleBtn.querySelector('span:last-child').textContent = '查看思考过程';
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
  const maxHeight = 180;
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
    btn.setAttribute('aria-disabled', String(!enabled));
  }
}

/**
 * Sync visible composer feedback when attachments are queued.
 * @param {number} attachmentCount
 */
export function updateComposerAttachmentStatus(attachmentCount = 0) {
  if (state.isStreaming) return;

  const composer = $('#composer');
  const statusText = $('#composer-status-text');
  const supportStatus = $('#composer-support-status');
  const tokenChip = $('#composer-token-chip');
  const dot = $('#composer-status-dot');
  const textarea = $('#chat-input');

  composer?.classList.toggle('has-attachments', attachmentCount > 0);
  dot?.classList.remove('is-busy');
  if (textarea) {
    textarea.readOnly = false;
    textarea.removeAttribute('aria-readonly');
  }

  if (attachmentCount > 0) {
    if (statusText) statusText.textContent = `已添加 ${attachmentCount} 个附件，发送前可继续编辑`;
    if (supportStatus) supportStatus.textContent = '上传状态：附件队列显示在输入内容上方。';
    if (tokenChip) tokenChip.textContent = `${attachmentCount} 个附件`;
    return;
  }

  if (statusText) statusText.textContent = '准备就绪，可以输入问题';
  if (supportStatus) supportStatus.textContent = '默认状态：输入框可编辑，发送按钮可用。';
  if (tokenChip) tokenChip.textContent = '可添加附件';
}

/**
 * Show or hide the stop generation button.
 * @param {boolean} show
 */
export function showStopButton(show) {
  const sendBtn = $('#send-btn');
  const stopBtn = $('#stop-btn');
  const chatArea = $('.chat-area');
  const composerStatus = $('#composer-status');
  const composer = $('#composer');
  const dot = $('#composer-status-dot');
  const statusText = $('#composer-status-text');
  const supportStatus = $('#composer-support-status');
  const tokenChip = $('#composer-token-chip');
  const textarea = $('#chat-input');
  if (sendBtn) sendBtn.classList.toggle('hidden', show);
  if (stopBtn) {
    stopBtn.classList.toggle('hidden', !show);
    stopBtn.setAttribute('aria-hidden', String(!show));
  }
  if (sendBtn) {
    sendBtn.setAttribute('aria-hidden', String(show));
  }
  if (chatArea) {
    chatArea.setAttribute('aria-busy', String(show));
  }
  composer?.classList.toggle('is-generating', show);
  dot?.classList.toggle('is-busy', show);
  if (textarea) {
    textarea.readOnly = show;
    if (show) {
      textarea.setAttribute('aria-readonly', 'true');
    } else {
      textarea.removeAttribute('aria-readonly');
    }
  }
  if (statusText) {
    statusText.textContent = show ? '智答 AI 正在生成，可随时停止' : '准备就绪，可以输入问题';
  }
  if (supportStatus) {
    supportStatus.textContent = show
      ? '生成中状态：发送按钮已切换为停止生成。'
      : '默认状态：输入框可编辑，发送按钮可用。';
  }
  if (tokenChip) {
    tokenChip.textContent = show ? '流式输出' : '可添加附件';
  }
  if (composerStatus) {
    composerStatus.textContent = show ? '正在生成回复，可使用停止生成按钮中断。' : '';
  }
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

    let plainText;
    try {
      plainText = decodeURIComponent(codeData);
    } catch {
      plainText = codeData;
    }

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
