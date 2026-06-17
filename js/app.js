/**
 * Main entry point — initialization, event binding, keyboard shortcuts.
 */

import { state } from './state.js';
import { initTheme, toggleTheme, cleanupTheme } from './theme.js';
import { initMarkdown } from './markdown.js';
import {
  DISPLAY_FONT_OPTIONS,
  FILE_INPUT_ACCEPT,
  LONG_TEXT_AUTO_MD_THRESHOLD,
  SUPPORTED_TEXT_FILE_EXTENSIONS,
} from './config.js';
import {
  loadConversations,
  loadActiveConversationId,
  loadSelectedModel,
  loadSettings,
  loadCachedModels,
  saveConversation,
  saveCachedModels,
  saveSelectedModel,
  saveSettings,
  clearAllData,
  checkStorageSoftLimit,
  getStorageSummary,
  exportAllDataPayload,
  importAllData,
  pruneStoredConversations,
  loadCustomPromptTemplates,
  saveCustomPromptTemplates,
} from './storage.js';
import {
  deleteCustomTemplate,
  mergeTemplates,
  upsertCustomTemplate,
} from './prompt-templates.js';
import { BACKEND_UNAVAILABLE_MESSAGE, fetchAvailableModels, fetchConfigStatus, saveApiConfig } from './api.js';
import {
  renderConversationList,
  renderModelDropdown,
  updateModelTrigger,
  renderMessages,
  showToast,
  autoResizeTextarea,
  updateSendButton,
  showStopButton,
  openModal,
  closeModal,
  isModalOpen,
  showConfirm,
  toggleSidebar,
  closeSidebar,
  initScrollTracking,
  initCodeBlockCopy,
  initNetworkStatus,
  updateSystemPromptIndicator,
  initCustomSelectControls,
  updateComposerCapabilityControls,
  updateComposerAttachmentStatus,
  updateWelcomeBackendStatus,
  updateRuntimeTemperatureUI,
  openRuntimeSettings,
  closeRuntimeSettings,
  isRuntimeSettingsOpen,
  cleanupUI,
} from './ui.js';
import {
  createNewConversation,
  switchConversation,
  deleteConversation,
  renameConversation,
  toggleConversationPinned,
  updateConversationTags,
  sendMessage,
  exportConversation,
  handleMessageAction,
  handleThinkingToggle,
} from './chat.js';
import { debounce, isMac, escapeHTML } from './utils.js';
import {
  createGeneratedMdAttachment,
  getLongTextContent,
  saveLongTextAttachment,
} from './long-text.js';

// ---- DOM References ----
const $ = (sel) => document.querySelector(sel);

// ---- Event Cleanup Manager ----
/** @type {AbortController|null} */
let eventController = null;
let globalErrorHandlersRegistered = false;
let lastGlobalErrorMessage = '';
let lastGlobalErrorTime = 0;
const GLOBAL_ERROR_TOAST_DEDUPE_MS = 3000;
const DIAGNOSTIC_EVENT_LIMIT = 8;
const diagnosticEvents = [];

/**
 * Initialize event controller for cleanup.
 */
function initEventController() {
  eventController = new AbortController();
  return eventController.signal;
}

function getGlobalErrorMessage(errorLike) {
  if (errorLike instanceof Error) return errorLike.message || errorLike.name;
  if (typeof errorLike === 'string') return errorLike;
  if (errorLike?.message) return String(errorLike.message);
  return '未知错误';
}

function showUnexpectedErrorToastOnce(errorMessage) {
  const now = Date.now();
  if (
    errorMessage === lastGlobalErrorMessage &&
    now - lastGlobalErrorTime < GLOBAL_ERROR_TOAST_DEDUPE_MS
  ) {
    return;
  }
  lastGlobalErrorMessage = errorMessage;
  lastGlobalErrorTime = now;
  showToast('发生意外错误，请刷新后重试', 'error');
}

function logUnexpectedError(label, errorLike, meta = {}) {
  const stack = errorLike instanceof Error ? errorLike.stack : undefined;
  console.error(label, errorLike, stack, meta);
  diagnosticEvents.unshift({
    time: new Date().toLocaleString('zh-CN', { hour12: false }),
    label,
    message: getGlobalErrorMessage(errorLike),
  });
  diagnosticEvents.splice(DIAGNOSTIC_EVENT_LIMIT);
}

function registerGlobalErrorHandlers() {
  if (globalErrorHandlersRegistered) return;
  globalErrorHandlersRegistered = true;

  window.onerror = (message, source, lineno, colno, error) => {
    const originalError = error ?? message;
    logUnexpectedError('Unhandled window error:', originalError, { source, lineno, colno });
    showUnexpectedErrorToastOnce(getGlobalErrorMessage(originalError));
    return false;
  };

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    logUnexpectedError('Unhandled promise rejection:', reason);
    showUnexpectedErrorToastOnce(getGlobalErrorMessage(reason));
  });
}

/**
 * Cleanup all event listeners.
 */
function cleanup() {
  if (eventController) {
    eventController.abort();
    eventController = null;
  }
  cleanupTheme();
  cleanupUI();
}

function applyDesktopMode() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('desktop') !== '1') return;
  document.documentElement.dataset.desktopApp = 'true';
  document.body.classList.add('desktop-app');
}

// ---- Pending Attachments ----
/** @type {Array<{type: string, name: string, content?: string, dataUrl?: string}>} */
let pendingAttachments = [];
const MAX_TEXT_FILE_SIZE = 100 * 1024;  // 100 KB
const MAX_IMAGE_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const TEXT_EXTENSIONS = new Set(SUPPORTED_TEXT_FILE_EXTENSIONS);

function normalizeApiBaseUrl(value) {
  return value.trim().replace(/\/+$/, '');
}

function getSettingsApiConfig() {
  const apiBaseUrlInput = $('#settings-api-base-url');
  const apiKeyInput = $('#settings-api-key');
  return {
    apiBaseUrl: apiBaseUrlInput ? normalizeApiBaseUrl(apiBaseUrlInput.value) : '',
    apiKey: apiKeyInput ? apiKeyInput.value.trim() : '',
  };
}

function getCurrentSearchQuery() {
  return $('#sidebar-search')?.value ?? '';
}

function updateBackendStatusUI() {
  const statusNode = $('#backend-status');
  const fetchModelsBtn = $('#fetch-models-btn');
  const headerStatus = $('#header-connection-status');
  const headerStatusText = $('#header-connection-status-text');
  const errorCard = $('#settings-config-error-card');
  const errorMessage = $('#settings-config-error-message');

  let headerClass = 'header-status header-status--checking';
  let headerText = '检测后端';
  let configError = '';

  if (state.backendAvailable === false) {
    headerClass = 'header-status header-status--error';
    headerText = '后端不可用';
    configError = state.backendError || BACKEND_UNAVAILABLE_MESSAGE;
    if (statusNode) {
      statusNode.textContent = configError;
      statusNode.hidden = false;
    }
    if (fetchModelsBtn) {
      fetchModelsBtn.disabled = true;
      fetchModelsBtn.title = '需要先启动 Node 后端代理';
    }
  } else {
    if (state.backendAvailable === true && state.isApiConfigured) {
      headerClass = 'header-status header-status--configured';
      headerText = '后端已连接';
    } else if (state.backendAvailable === true) {
      headerClass = 'header-status header-status--ready';
      headerText = '待配置 API';
      configError = '后端已运行，但还没有保存 API 地址和密钥。';
    }
    if (statusNode) {
      statusNode.hidden = true;
      statusNode.textContent = '';
    }
    if (fetchModelsBtn) {
      fetchModelsBtn.disabled = false;
      fetchModelsBtn.title = '';
    }
  }

  if (headerStatus) headerStatus.className = headerClass;
  if (headerStatusText) headerStatusText.textContent = headerText;
  if (errorCard && errorMessage) {
    errorCard.hidden = !configError;
    errorMessage.textContent = configError;
  }

  updateWelcomeBackendStatus();
}

function showApiConfigSaveError(err) {
  const message = err?.message || 'API 配置保存失败';
  const isMissingSecret = message.includes('ZHIDA_CONFIG_SECRET');
  const displayMessage = isMissingSecret
    ? `保存失败：${message}。请在启动 Node 后端时设置 ZHIDA_CONFIG_SECRET。`
    : message;
  const statusNode = $('#backend-status');
  if (isMissingSecret && statusNode) {
    statusNode.textContent = displayMessage;
    statusNode.hidden = false;
  }
  const errorCard = $('#settings-config-error-card');
  const errorMessage = $('#settings-config-error-message');
  if (errorCard && errorMessage) {
    errorCard.hidden = false;
    errorMessage.textContent = displayMessage;
  }
  showToast(displayMessage, 'error', isMissingSecret ? 6000 : 3000);
}

function openSettingsModal() {
  const apiBaseUrlInput = $('#settings-api-base-url');
  const apiKeyInput = $('#settings-api-key');
  const sysPromptInput = $('#settings-system-prompt');
  const displayFontSelect = $('#settings-display-font');
  const tempSlider = $('#settings-temperature');
  const tempValue = $('#temp-value');
  const maxTokensInput = $('#settings-max-tokens');

  if (apiBaseUrlInput) apiBaseUrlInput.value = state.apiBaseUrl;
  if (apiKeyInput) {
    apiKeyInput.value = '';
    apiKeyInput.type = 'password';
  }
  if (sysPromptInput) sysPromptInput.value = state.systemPrompt;
  if (displayFontSelect) displayFontSelect.value = state.displayFont;
  if (tempSlider) tempSlider.value = state.temperature;
  if (tempValue) tempValue.textContent = state.temperature.toFixed(1);
  if (maxTokensInput) maxTokensInput.value = state.maxTokens;
  updateRuntimeTemperatureUI();
  updateBackendStatusUI();
  openModal('settings-modal');
}

function downloadJSON(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function insertPromptIntoInput(content) {
  const textarea = $('#chat-input');
  if (!textarea) return;

  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const prefix = textarea.value.slice(0, start);
  const suffix = textarea.value.slice(end);
  const needsBreak = prefix && !prefix.endsWith('\n') ? '\n\n' : '';
  textarea.value = `${prefix}${needsBreak}${content}${suffix}`;
  const cursor = prefix.length + needsBreak.length + content.length;
  textarea.focus();
  textarea.setSelectionRange(cursor, cursor);
  autoResizeTextarea(textarea);
  updateSendButton(canSend());
}

function renderDataStats() {
  const container = $('#data-stats');
  if (!container) return;
  const summary = getStorageSummary();
  container.innerHTML = `
    <div class="data-stat"><span class="data-stat__value">${summary.usageMB.toFixed(2)} MB</span><span class="data-stat__label">本地存储占用</span></div>
    <div class="data-stat"><span class="data-stat__value">${summary.conversationCount}</span><span class="data-stat__label">对话数量</span></div>
    <div class="data-stat"><span class="data-stat__value">${summary.promptTemplateCount}</span><span class="data-stat__label">自定义模板</span></div>
  `;
}

function resetTemplateForm() {
  const idInput = $('#prompt-template-id');
  const nameInput = $('#prompt-template-name');
  const contentInput = $('#prompt-template-content');
  if (idInput) idInput.value = '';
  if (nameInput) nameInput.value = '';
  if (contentInput) contentInput.value = '';
  nameInput?.focus();
}

function renderPromptTemplates() {
  const list = $('#prompt-template-list');
  if (!list) return;
  const templates = mergeTemplates(loadCustomPromptTemplates());
  list.innerHTML = templates.map((template) => `
    <article class="template-item" data-template-id="${escapeHTML(template.id)}">
      <div>
        <h4 class="template-item__name">${escapeHTML(template.name)}${template.builtin ? ' <span class="badge badge--standard">内置</span>' : ''}</h4>
        <p class="template-item__content">${escapeHTML(template.content)}</p>
      </div>
      <div class="template-item__actions">
        <button type="button" class="template-item__action" data-template-action="insert" aria-label="插入模板：${escapeHTML(template.name)}" title="插入">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
        </button>
        ${template.builtin ? '' : `
        <button type="button" class="template-item__action" data-template-action="edit" aria-label="编辑模板：${escapeHTML(template.name)}" title="编辑">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        </button>
        <button type="button" class="template-item__action template-item__action--danger" data-template-action="delete" aria-label="删除模板：${escapeHTML(template.name)}" title="删除">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
        </button>`}
      </div>
    </article>
  `).join('');
}

function setModelSelectorOpen(modelSelector, isOpen) {
  if (!modelSelector) return;
  modelSelector.classList.toggle('open', isOpen);
  const trigger = modelSelector.querySelector('#model-trigger');
  trigger?.setAttribute('aria-expanded', String(isOpen));
  if (isOpen) {
    requestAnimationFrame(() => modelSelector.querySelector('#model-search')?.focus());
  }
}

function updateShortcutLabels() {
  const label = isMac() ? 'Cmd' : 'Ctrl';
  document.querySelectorAll('[data-shortcut-mod]').forEach((node) => {
    node.textContent = label;
  });
}

function applyDisplayFontPreference(fontId = state.displayFont) {
  const nextFont = DISPLAY_FONT_OPTIONS.includes(fontId) ? fontId : 'system';
  document.documentElement.dataset.displayFont = nextFont;
}

/**
 * Fetch models from the API and update UI.
 * @param {boolean} [silent=true] - If false, show toast on success/failure
 */
async function refreshModels(options = {}) {
  const {
    silent = true,
    rethrow = false,
  } = options;

  try {
    const models = await fetchAvailableModels();
    if (models.length > 0) {
      state.models = models;
      saveCachedModels();

      // With no hard-coded list, the selection may be empty or point at a
      // model from a previous provider. Fall back to the first available model.
      if (!models.some((m) => m.id === state.selectedModelId)) {
        state.selectedModelId = models[0].id;
        saveSelectedModel();
      }

      renderModelDropdown();
      updateModelTrigger();
      updateComposerCapabilityControls();
      renderConversationList();

      if (!silent) showToast(`已获取 ${models.length} 个可用模型`, 'success');
      return { ok: true, count: models.length };
    } else if (!silent) {
      showToast('未获取到可用模型', 'warning');
    }
    return { ok: true, count: 0 };
  } catch (err) {
    console.warn('Failed to fetch models:', err);
    if (err?.backendUnavailable) {
      state.backendAvailable = false;
      state.backendError = err.message || BACKEND_UNAVAILABLE_MESSAGE;
      updateBackendStatusUI();
    }
    if (rethrow) throw err;
    if (!silent) showToast(err.message || '获取模型列表失败，请检查 API 配置', 'error');
    return { ok: false, count: 0, error: err };
  }
}

async function refreshConfigStatus({ silent = true } = {}) {
  try {
    const status = await fetchConfigStatus();
    state.backendAvailable = true;
    state.backendError = '';
    state.apiConfigured = Boolean(status.configured);
    state.apiBaseUrl = status.apiBaseUrl || '';
    saveSettings();
    updateBackendStatusUI();
    return status;
  } catch (err) {
    console.warn('Failed to load config status:', err);
    if (err?.backendUnavailable) {
      state.backendAvailable = false;
      state.backendError = err.message || BACKEND_UNAVAILABLE_MESSAGE;
      state.apiConfigured = false;
    } else {
      state.backendAvailable = true;
      state.backendError = '';
      state.apiConfigured = false;
    }
    updateBackendStatusUI();
    if (!silent) showToast(err.message || '读取 API 配置状态失败', 'error');
    return { configured: false, apiBaseUrl: '' };
  }
}

function renderDiagnosticList(rows) {
  return rows.map(([label, value]) => `
    <dt>${escapeHTML(label)}</dt>
    <dd>${escapeHTML(value ?? '未设置')}</dd>
  `).join('');
}

function renderDiagnostics() {
  const grid = $('#diagnostics-grid');
  if (!grid) return;

  const storage = getStorageSummary();
  const selectedModel = state.selectedModel;
  const isDesktop = document.documentElement.dataset.desktopApp === 'true';
  const recentEvents = diagnosticEvents.length > 0
    ? diagnosticEvents.map((item) => `${item.time} ${item.label} ${item.message}`).join('\n')
    : '暂无前端异常记录';

  const cards = [
    {
      title: '后端连接',
      rows: [
        ['连接状态', state.backendAvailable ? '已连接' : '未连接'],
        ['配置状态', state.isApiConfigured ? '已配置' : '未配置'],
        ['API 地址', state.apiBaseUrl || '未设置'],
      ],
    },
    {
      title: '工作区',
      rows: [
        ['对话数量', String(storage.conversationCount)],
        ['自定义模板', String(storage.promptTemplateCount)],
        ['本地存储', `${storage.usageMB.toFixed(2)} MB`],
      ],
    },
    {
      title: '模型',
      rows: [
        ['当前模型', selectedModel?.name || selectedModel?.id || '未选择'],
        ['模型数量', String(state.models.length)],
        ['网络搜索', selectedModel?.supportsResponses ? '可用' : '不可用'],
      ],
    },
    {
      title: '运行环境',
      rows: [
        ['桌面模式', isDesktop ? '是' : '否'],
        ['在线状态', navigator.onLine ? '在线' : '离线'],
        ['主题', document.documentElement.dataset.theme || '跟随系统'],
      ],
    },
  ];

  grid.innerHTML = `
    ${cards.map((card) => `
      <section class="diagnostics-card">
        <h4 class="diagnostics-card__title">${escapeHTML(card.title)}</h4>
        <dl class="diagnostics-list">${renderDiagnosticList(card.rows)}</dl>
      </section>
    `).join('')}
    <section class="diagnostics-card diagnostics-card--wide">
      <h4 class="diagnostics-card__title">最近前端异常</h4>
      <pre class="diagnostics-log">${escapeHTML(recentEvents)}</pre>
    </section>
  `;
}

function openDiagnosticsModal() {
  renderDiagnostics();
  openModal('diagnostics-modal');
}

async function saveServerApiConfigFromForm({ requireKey = false } = {}) {
  if (state.backendAvailable === false) {
    throw new Error(state.backendError || BACKEND_UNAVAILABLE_MESSAGE);
  }

  const apiConfig = getSettingsApiConfig();
  const urlChanged = apiConfig.apiBaseUrl !== state.apiBaseUrl;
  const shouldSaveApiConfig = apiConfig.apiKey || urlChanged || !state.isApiConfigured || requireKey;

  if (!shouldSaveApiConfig) return null;
  if (!apiConfig.apiBaseUrl || !apiConfig.apiKey) {
    throw new Error('请填写 API 地址和 API 密钥');
  }

  let result;
  try {
    result = await saveApiConfig(apiConfig);
  } catch (err) {
    if (err?.backendUnavailable) {
      state.backendAvailable = false;
      state.backendError = err.message || BACKEND_UNAVAILABLE_MESSAGE;
      state.apiConfigured = false;
      updateBackendStatusUI();
    }
    throw err;
  }
  state.backendAvailable = true;
  state.backendError = '';
  state.apiConfigured = Boolean(result.configured);
  state.apiBaseUrl = result.apiBaseUrl || apiConfig.apiBaseUrl;
  const apiKeyInput = $('#settings-api-key');
  if (apiKeyInput) {
    apiKeyInput.value = '';
    apiKeyInput.type = 'password';
  }
  saveSettings();
  updateBackendStatusUI();
  return result;
}

/**
 * Boot the application.
 */
async function init() {
  applyDesktopMode();

  // Initialize event controller for cleanup
  initEventController();
  registerGlobalErrorHandlers();

  // Initialize subsystems
  initTheme();
  initMarkdown();
  initScrollTracking();
  initCodeBlockCopy();
  initNetworkStatus();

  // Load persisted state
  loadCachedModels();
  loadConversations();
  loadSettings();
  applyDisplayFontPreference();
  loadSelectedModel();
  loadActiveConversationId();
  checkStorageSoftLimit();
  await refreshConfigStatus();

  // Render initial UI
  renderModelDropdown();
  updateModelTrigger();
  initCustomSelectControls(eventController?.signal);
  updateComposerCapabilityControls();
  renderConversationList();
  renderMessages();
  updateSystemPromptIndicator();
  showStopButton(false);

  // Bind events
  bindInputEvents();
  bindSidebarEvents();
  bindHeaderEvents();
  bindModalEvents();
  bindKeyboardShortcuts();
  bindPasteHandler();
  bindStorageWarning();
  updateShortcutLabels();

  // Initial send button state
  updateSendButton(canSend());
  updateComposerAttachmentStatus(pendingAttachments.length);

  // First-run: prompt to configure API if not set
  if (state.backendAvailable === false) {
    showToast(state.backendError || BACKEND_UNAVAILABLE_MESSAGE, 'error', 6000);
  } else if (!state.isApiConfigured) {
    showToast('请先配置 API 地址和密钥', 'warning', 3000);
  } else {
    // Auto-refresh models from the API in background
    refreshModels();
  }

  document.documentElement.dataset.appReady = 'true';
}

// ============================================
// Input Events
// ============================================

function canSend() {
  const textarea = $('#chat-input');
  return (textarea?.value.trim().length > 0 || pendingAttachments.length > 0) && !state.isStreaming;
}

async function doSend() {
  const textarea = $('#chat-input');
  if (!canSend()) return;

  if (textarea && textarea.value.length > LONG_TEXT_AUTO_MD_THRESHOLD) {
    const created = await addLongTextAttachmentFromContent(textarea.value);
    if (!created) return;
    textarea.value = '';
    textarea.style.height = 'auto';
  }

  const attachments = [...pendingAttachments];
  pendingAttachments = [];
  renderAttachmentPreview();
  sendMessage(textarea?.value || '', attachments);
}

function bindInputEvents() {
  const signal = eventController?.signal;
  const composer = $('#composer');
  const textarea = $('#chat-input');
  const sendBtn = $('#send-btn');
  const stopBtn = $('#stop-btn');
  const uploadBtn = $('#upload-btn');
  const expandBtn = $('#composer-expand-btn');
  const inputTemplateBtn = $('#input-template-btn');
  const fileInput = $('#file-input');
  const webSearchToggle = $('#web-search-toggle');
  const reasoningSelect = $('#reasoning-effort-select');
  const webSearchContextSelect = $('#web-search-context-select');
  const runtimeTemperature = $('#runtime-temperature');

  // chat.js 只负责流式状态，最终可发送条件统一回到这里计算，避免遗漏附件态。
  document.addEventListener('composer-state-sync', () => {
    updateSendButton(canSend());
    updateComposerAttachmentStatus(pendingAttachments.length);
  }, { signal });

  if (textarea) {
    // Auto-resize on input
    textarea.addEventListener('input', () => {
      autoResizeTextarea(textarea);
      updateSendButton(canSend());
    }, { signal });

    // Enter to send, Shift+Enter for newline
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        doSend();
      }
    }, { signal });
  }

  if (expandBtn && composer && textarea) {
    expandBtn.addEventListener('click', () => {
      const expanded = !composer.classList.contains('composer--expanded');
      composer.classList.toggle('composer--expanded', expanded);
      expandBtn.setAttribute('aria-pressed', String(expanded));
      expandBtn.setAttribute('aria-label', expanded ? '收起输入框' : '展开输入框');
      expandBtn.title = expanded ? '收起输入框' : '展开输入框';
      autoResizeTextarea(textarea);
      textarea.focus();
    }, { signal });
  }

  if (composer) {
    composer.addEventListener('submit', (e) => {
      e.preventDefault();
      doSend();
    }, { signal });
  } else if (sendBtn) {
    sendBtn.addEventListener('click', doSend, { signal });
  }

  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      state.abortStream();
    }, { signal });
  }

  if (webSearchToggle) {
    webSearchToggle.addEventListener('change', () => {
      if (webSearchToggle.disabled) {
        updateComposerCapabilityControls();
        return;
      }
      state.webSearchEnabled = webSearchToggle.checked;
      saveSettings();
      updateComposerCapabilityControls();
    }, { signal });
  }

  if (reasoningSelect) {
    reasoningSelect.addEventListener('change', () => {
      state.reasoningEffort = reasoningSelect.value;
      saveSettings();
      updateComposerCapabilityControls();
    }, { signal });
  }

  if (webSearchContextSelect) {
    webSearchContextSelect.addEventListener('change', () => {
      state.webSearchContextSize = webSearchContextSelect.value;
      saveSettings();
      updateComposerCapabilityControls();
    }, { signal });
  }

  if (runtimeTemperature) {
    runtimeTemperature.addEventListener('input', () => {
      state.temperature = parseFloat(runtimeTemperature.value);
      updateRuntimeTemperatureUI();
      const settingsTempSlider = $('#settings-temperature');
      const tempValue = $('#temp-value');
      if (settingsTempSlider) settingsTempSlider.value = state.temperature;
      if (tempValue) tempValue.textContent = state.temperature.toFixed(1);
    }, { signal });
    runtimeTemperature.addEventListener('change', () => {
      saveSettings();
    }, { signal });
  }

  if (inputTemplateBtn) {
    inputTemplateBtn.addEventListener('click', () => {
      renderPromptTemplates();
      openModal('prompt-templates-modal');
    }, { signal });
  }

  // File upload
  if (uploadBtn && fileInput) {
    fileInput.accept = FILE_INPUT_ACCEPT;
    uploadBtn.addEventListener('click', () => fileInput.click(), { signal });
    fileInput.addEventListener('change', () => {
        handleFileSelection(fileInput.files);
        fileInput.value = '';
      }, { signal });
  }

  // Drag & drop files onto input area
  const inputArea = document.querySelector('.input-area');
  if (inputArea) {
    inputArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      inputArea.classList.add('drag-over');
      composer?.classList.add('is-drag');
    }, { signal });
    inputArea.addEventListener('dragleave', () => {
      inputArea.classList.remove('drag-over');
      composer?.classList.remove('is-drag');
    }, { signal });
    inputArea.addEventListener('drop', (e) => {
      e.preventDefault();
      inputArea.classList.remove('drag-over');
      composer?.classList.remove('is-drag');
      if (e.dataTransfer?.files.length) {
        handleFileSelection(e.dataTransfer.files, { source: 'drop' });
      }
    }, { signal });
  }
}

// ============================================
// Sidebar Events
// ============================================

function bindSidebarEvents() {
  const signal = eventController?.signal;
  const newChatBtn = $('#new-chat-btn');
  const conversationList = $('#conversation-list');
  const searchInput = $('#sidebar-search');
  const clearAllBtn = $('#clear-all-btn');
  const exportBtn = $('#export-btn');
  const sidebarOverlay = $('.sidebar-overlay');
  const shortcutsBtn = $('#shortcuts-btn');
  const dataManagementBtn = $('#data-management-btn');
  const promptTemplatesBtn = $('#prompt-templates-btn');

  if (newChatBtn) {
    newChatBtn.addEventListener('click', () => {
      createNewConversation();
      closeSidebar();
    }, { signal });
  }

  if (conversationList) {
    conversationList.addEventListener('click', async (e) => {
      const renameBtn = e.target.closest('.conversation-item__rename');
      if (renameBtn) {
        e.stopPropagation();
        const item = renameBtn.closest('.conversation-item');
        if (item) startConversationRename(item);
        return;
      }

      // Delete button
      const delBtn = e.target.closest('.conversation-item__delete');
      if (delBtn) {
        e.stopPropagation();
        const id = delBtn.dataset.id;
        const confirmed = await showConfirm('确定要删除这个对话吗？');
        if (confirmed) {
          deleteConversation(id);
        }
        return;
      }

      const pinBtn = e.target.closest('.conversation-item__pin');
      if (pinBtn) {
        e.stopPropagation();
        toggleConversationPinned(pinBtn.dataset.id);
        renderConversationList(getCurrentSearchQuery());
        return;
      }

      const tagsBtn = e.target.closest('.conversation-item__tags-btn');
      if (tagsBtn) {
        e.stopPropagation();
        const conv = state.conversations.find((item) => item.id === tagsBtn.dataset.id);
        if (!conv) return;
        const value = window.prompt('输入标签，用逗号或空格分隔', (conv.tags ?? []).join(', '));
        if (value !== null) {
          updateConversationTags(conv.id, value);
          renderConversationList(getCurrentSearchQuery());
        }
        return;
      }

      // Conversation item
      const item = e.target.closest('.conversation-item');
      if (item) {
        const id = item.dataset.id;
        switchConversation(id);
        closeSidebar();
      }
    }, { signal });

    // Double-click to rename conversation title
    conversationList.addEventListener('dblclick', (e) => {
      const titleEl = e.target.closest('.conversation-item__title');
      if (!titleEl) return;

      const item = titleEl.closest('.conversation-item');
      if (!item) return;

      e.preventDefault();
      e.stopPropagation();
      startConversationRename(item);
    }, { signal });

    // Keyboard navigation for conversation items
    conversationList.addEventListener('keydown', (e) => {
      if (e.target.closest('.conversation-item__action, .conversation-item__rename-input')) {
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        const item = e.target.closest('.conversation-item');
        if (item) {
          e.preventDefault();
          item.click();
        }
      }
    }, { signal });
  }

  if (searchInput) {
    const debouncedSearch = debounce((value) => {
      renderConversationList(value);
    }, 300);

    searchInput.addEventListener('input', (e) => {
      debouncedSearch(e.target.value);
    }, { signal });
  }

  if (clearAllBtn) {
    clearAllBtn.addEventListener('click', async () => {
      const confirmed = await showConfirm('确定要清空所有对话吗？此操作不可撤销。');
      if (confirmed) {
        if (state.isStreaming) state.abortStream();
        clearAllData();
        renderMessages();
        renderConversationList();
        showToast('所有对话已清空', 'success');
      }
    }, { signal });
  }

  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      exportConversation();
    }, { signal });
  }

  if (sidebarOverlay) {
    sidebarOverlay.addEventListener('click', closeSidebar, { signal });
  }

  if (shortcutsBtn) {
    shortcutsBtn.addEventListener('click', () => {
      openModal('shortcuts-modal');
    }, { signal });
  }

  if (dataManagementBtn) {
    dataManagementBtn.addEventListener('click', () => {
      renderDataStats();
      openModal('data-management-modal');
    }, { signal });
  }

  if (promptTemplatesBtn) {
    promptTemplatesBtn.addEventListener('click', () => {
      renderPromptTemplates();
      openModal('prompt-templates-modal');
    }, { signal });
  }
}

function startConversationRename(item) {
  const id = item?.dataset?.id;
  const titleEl = item?.querySelector('.conversation-item__title');
  if (!id || !titleEl || item.querySelector('.conversation-item__rename-input')) return;

  const currentTitle = item.dataset.title || titleEl.querySelector('.conversation-item__title-text')?.textContent || titleEl.textContent || '';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'conversation-item__rename-input';
  input.value = currentTitle;
  input.setAttribute('aria-label', '重命名对话');

  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let finished = false;
  const restoreList = () => {
    renderConversationList(getCurrentSearchQuery());
  };
  const commit = () => {
    if (finished) return;
    finished = true;
    const newTitle = input.value.trim();
    if (newTitle && newTitle !== currentTitle) {
      renameConversation(id, newTitle);
    } else {
      restoreList();
    }
  };
  const cancel = () => {
    if (finished) return;
    finished = true;
    restoreList();
  };

  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (ke) => {
    if (ke.key === 'Enter') {
      ke.preventDefault();
      commit();
    } else if (ke.key === 'Escape') {
      ke.preventDefault();
      cancel();
    }
  });

  input.addEventListener('blur', commit, { once: true });
}

// ============================================
// Header Events
// ============================================

function bindHeaderEvents() {
  const signal = eventController?.signal;
  const sidebarToggle = $('#sidebar-toggle');
  const themeToggle = $('#theme-toggle');
  const settingsBtn = $('#settings-btn');
  const diagnosticsBtn = $('#diagnostics-btn');
  const runtimeSettingsBtn = $('#runtime-settings-btn');
  const runtimeSettingsCloseBtn = $('#runtime-settings-close-btn');
  const runtimeBackdrop = $('.runtime-backdrop');
  const modelSelector = $('.model-selector');
  const modelTrigger = $('#model-trigger');
  const modelList = $('#model-list');
  const modelSearch = $('#model-search');

  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', toggleSidebar, { signal });
  }

  if (themeToggle) {
    themeToggle.addEventListener('click', toggleTheme, { signal });
  }

  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      openSettingsModal();
    }, { signal });
  }

  if (diagnosticsBtn) {
    diagnosticsBtn.addEventListener('click', () => {
      openDiagnosticsModal();
    }, { signal });
  }

  if (runtimeSettingsBtn) {
    runtimeSettingsBtn.addEventListener('click', () => {
      if (isRuntimeSettingsOpen()) {
        closeRuntimeSettings();
      } else {
        openRuntimeSettings();
      }
    }, { signal });
  }

  if (runtimeSettingsCloseBtn) {
    runtimeSettingsCloseBtn.addEventListener('click', closeRuntimeSettings, { signal });
  }

  if (runtimeBackdrop) {
    runtimeBackdrop.addEventListener('click', closeRuntimeSettings, { signal });
  }

  // Model selector dropdown
  if (modelTrigger && modelSelector) {
    modelTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      setModelSelectorOpen(modelSelector, !modelSelector.classList.contains('open'));
    }, { signal });

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (!modelSelector.contains(e.target)) {
        setModelSelectorOpen(modelSelector, false);
      }
    }, { signal });
  }

  if (modelList) {
    const selectModelItem = (item) => {
      const modelId = item?.dataset.modelId;
      if (!modelId) return;
      const previousModelId = state.selectedModelId;
      state.selectedModelId = modelId;

      if (state.activeConversation) {
        const nextConv = {
          ...state.activeConversation,
          modelId,
          updatedAt: Date.now(),
        };
        if (!saveConversation(nextConv)) {
          state.selectedModelId = previousModelId;
          showToast('模型切换保存失败，请清理本地存储后重试', 'error');
          renderModelDropdown();
          updateModelTrigger();
          return;
        }
      }

      saveSelectedModel();
      renderModelDropdown();
      updateModelTrigger();
      updateComposerCapabilityControls();
      renderMessages(); // Update welcome screen model display
      renderConversationList();

      setModelSelectorOpen(modelSelector, false);
    };

    modelList.addEventListener('click', (e) => {
      const item = e.target.closest('.model-selector__item');
      if (!item) return;

      selectModelItem(item);
    }, { signal });

    modelList.addEventListener('keydown', (e) => {
      const current = e.target.closest('.model-selector__item');
      if (!current) return;
      const items = Array.from(modelList.querySelectorAll('.model-selector__item'));
      const index = items.indexOf(current);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const nextIndex = e.key === 'ArrowDown'
          ? Math.min(items.length - 1, index + 1)
          : Math.max(0, index - 1);
        items[nextIndex]?.focus();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectModelItem(current);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setModelSelectorOpen(modelSelector, false);
        modelTrigger?.focus();
      }
    }, { signal });
  }

  if (modelSearch) {
    modelSearch.addEventListener('click', (e) => e.stopPropagation(), { signal });
    modelSearch.addEventListener('input', () => renderModelDropdown(), { signal });
    modelSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        modelSearch.value = '';
        renderModelDropdown();
        setModelSelectorOpen(modelSelector, false);
        modelTrigger?.focus();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        modelList?.querySelector('.model-selector__item')?.focus();
      }
    }, { signal });
  }

  // System prompt indicator click
  const sysPromptIndicator = $('.system-prompt-indicator');
  if (sysPromptIndicator) {
    sysPromptIndicator.addEventListener('click', () => {
      openSettingsModal();
    }, { signal });
  }
}

// ============================================
// Modal Events
// ============================================

function bindModalEvents() {
  const signal = eventController?.signal;
  // Close modal on overlay click
  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    }, { signal });
  });

  // Close buttons
  document.querySelectorAll('.modal__close').forEach((btn) => {
    btn.addEventListener('click', closeModal, { signal });
  });

  // Settings modal — save
  // API key visibility toggle
  const toggleKeyBtn = $('#toggle-api-key-visibility');
  const apiKeyField = $('#settings-api-key');
  if (toggleKeyBtn && apiKeyField) {
    toggleKeyBtn.addEventListener('click', () => {
      const isPassword = apiKeyField.type === 'password';
      apiKeyField.type = isPassword ? 'text' : 'password';
    }, { signal });
  }

  const settingsSaveBtn = $('#settings-save-btn');
  if (settingsSaveBtn) {
    settingsSaveBtn.addEventListener('click', async () => {
      const sysPromptInput = $('#settings-system-prompt');
      const displayFontSelect = $('#settings-display-font');
      const tempSlider = $('#settings-temperature');
      const maxTokensInput = $('#settings-max-tokens');

      if (sysPromptInput) state.systemPrompt = sysPromptInput.value;
      if (displayFontSelect) state.displayFont = displayFontSelect.value;
      if (tempSlider) state.temperature = parseFloat(tempSlider.value);
      if (maxTokensInput) state.maxTokens = parseInt(maxTokensInput.value, 10) || 4096;
      applyDisplayFontPreference();

      if (state.activeConversation) {
        const nextConv = {
          ...state.activeConversation,
          systemPrompt: state.systemPrompt,
          updatedAt: Date.now(),
        };
        if (!saveConversation(nextConv)) {
          showToast('系统提示词保存失败，请清理本地存储后重试', 'error');
          return;
        }
      }

      settingsSaveBtn.disabled = true;
      const originalText = settingsSaveBtn.textContent;
      settingsSaveBtn.textContent = '保存中...';
      try {
        await saveServerApiConfigFromForm();
      } catch (err) {
        showApiConfigSaveError(err);
        settingsSaveBtn.disabled = false;
        settingsSaveBtn.textContent = originalText;
        return;
      }

      if (!saveSettings()) {
        showToast('设置保存失败，请清理本地存储后重试', 'error');
        settingsSaveBtn.disabled = false;
        settingsSaveBtn.textContent = originalText;
        return;
      }
      updateSystemPromptIndicator();
      closeModal();
      settingsSaveBtn.disabled = false;
      settingsSaveBtn.textContent = originalText;
      showToast('设置已保存', 'success');

      // Refresh model list from new API config
      if (state.isApiConfigured) {
        refreshModels({ silent: false });
      }
    }, { signal });
  }

  // Fetch models button
  const fetchModelsBtn = $('#fetch-models-btn');
  if (fetchModelsBtn) {
    fetchModelsBtn.addEventListener('click', async () => {
      if (state.backendAvailable === false) {
        showToast(state.backendError || BACKEND_UNAVAILABLE_MESSAGE, 'error', 6000);
        updateBackendStatusUI();
        return;
      }

      fetchModelsBtn.disabled = true;
      fetchModelsBtn.textContent = '保存并获取中...';

      let savedConfig = false;
      try {
        await saveServerApiConfigFromForm({ requireKey: true });
        savedConfig = true;
        const result = await refreshModels({ silent: true, rethrow: true });
        if (result.count > 0) {
          showToast(`配置已保存，已获取 ${result.count} 个可用模型`, 'success');
        } else {
          showToast('配置已保存，但未获取到可用模型', 'warning');
        }
      } catch (err) {
        console.warn('Failed to fetch models from settings form:', err);
        const message = err.message || '获取模型列表失败，请检查 API 配置';
        showToast(savedConfig ? `配置已保存，但模型列表获取失败：${message}` : message, savedConfig ? 'warning' : 'error', 6000);
      }

      fetchModelsBtn.disabled = state.backendAvailable === false;
      fetchModelsBtn.textContent = '保存配置并获取模型列表';
      updateBackendStatusUI();
    }, { signal });
  }

  const retryConnectionBtn = $('#settings-retry-connection-btn');
  if (retryConnectionBtn) {
    retryConnectionBtn.addEventListener('click', async () => {
      retryConnectionBtn.disabled = true;
      retryConnectionBtn.textContent = '重试中...';
      try {
        await refreshConfigStatus();
        if (state.isApiConfigured) {
          await refreshModels({ silent: false });
        }
      } finally {
        retryConnectionBtn.disabled = false;
        retryConnectionBtn.textContent = '重试连接';
        updateBackendStatusUI();
      }
    }, { signal });
  }

  const checkConfigBtn = $('#settings-check-config-btn');
  if (checkConfigBtn) {
    checkConfigBtn.addEventListener('click', () => {
      $('#settings-api-base-url')?.focus();
    }, { signal });
  }

  // Display font applies immediately because it is local-only UI state.
  const displayFontSelect = $('#settings-display-font');
  if (displayFontSelect) {
    displayFontSelect.addEventListener('change', () => {
      state.displayFont = displayFontSelect.value;
      applyDisplayFontPreference();
      if (!saveSettings()) {
        showToast('显示字体保存失败，请清理本地存储后重试', 'error');
        return;
      }
      showToast('显示字体已更新', 'success', 1600);
    }, { signal });
  }

  // Temperature slider live update
  const tempSlider = $('#settings-temperature');
  const tempValue = $('#temp-value');
  if (tempSlider && tempValue) {
    tempSlider.addEventListener('input', () => {
      tempValue.textContent = parseFloat(tempSlider.value).toFixed(1);
      const runtimeTemperature = $('#runtime-temperature');
      const runtimeTemperatureValue = $('#runtime-temperature-value');
      if (runtimeTemperature) runtimeTemperature.value = tempSlider.value;
      if (runtimeTemperatureValue) runtimeTemperatureValue.textContent = parseFloat(tempSlider.value).toFixed(1);
    }, { signal });
  }

  const exportAllDataBtn = $('#export-all-data-btn');
  if (exportAllDataBtn) {
    exportAllDataBtn.addEventListener('click', async () => {
      const payload = await exportAllDataPayload();
      const stamp = payload.exportedAt.replace(/[/:\\\s]/g, '-');
      downloadJSON(`zhida-ai-backup-${stamp}-BJT.json`, payload);
      showToast('全部数据已导出', 'success');
    }, { signal });
  }

  const importDataBtn = $('#import-data-btn');
  const importDataInput = $('#import-data-input');
  if (importDataBtn && importDataInput) {
    importDataBtn.addEventListener('click', () => importDataInput.click(), { signal });
    importDataInput.addEventListener('change', async () => {
      const file = importDataInput.files?.[0];
      importDataInput.value = '';
      if (!file) return;

      const confirmed = window.confirm('导入会合并当前数据；同 ID 对话会被备份文件覆盖。确定继续吗？');
      if (!confirmed) return;

      try {
        const raw = await file.text();
        const result = await importAllData(raw);
        renderModelDropdown();
        updateModelTrigger();
        updateComposerCapabilityControls();
        applyDisplayFontPreference();
        renderConversationList(getCurrentSearchQuery());
        renderMessages();
        renderPromptTemplates();
        renderDataStats();
        updateSystemPromptIndicator();
        showToast(`导入完成：${result.conversations} 个对话，${result.promptTemplates} 个自定义模板`, 'success', 3000);
      } catch (err) {
        showToast(err.message || '导入失败', 'error', 3000);
      }
    }, { signal });
  }

  const pruneBtn = $('#prune-conversations-btn');
  if (pruneBtn) {
    pruneBtn.addEventListener('click', async () => {
      const limit = Number.parseInt($('#prune-conversation-limit')?.value ?? '0', 10);
      const confirmed = window.confirm(`确定清理旧对话并最多保留 ${limit} 个吗？置顶对话会优先保留。`);
      if (!confirmed) return;
      const result = pruneStoredConversations(limit);
      if (!result.ok) {
        showToast('清理失败：本地存储写入失败', 'error');
        return;
      }
      renderConversationList(getCurrentSearchQuery());
      renderMessages();
      renderDataStats();
      showToast(`已清理 ${result.removed.length} 个旧对话`, 'success');
    }, { signal });
  }

  const templateList = $('#prompt-template-list');
  if (templateList) {
    templateList.addEventListener('click', async (e) => {
      const actionBtn = e.target.closest('[data-template-action]');
      if (!actionBtn) return;

      const templateId = actionBtn.closest('.template-item')?.dataset.templateId;
      const templates = mergeTemplates(loadCustomPromptTemplates());
      const template = templates.find((item) => item.id === templateId);
      if (!template) return;

      const action = actionBtn.dataset.templateAction;
      if (action === 'insert') {
        insertPromptIntoInput(template.content);
        closeModal();
        showToast('模板已插入输入框', 'success');
      } else if (action === 'edit' && !template.builtin) {
        $('#prompt-template-id').value = template.id;
        $('#prompt-template-name').value = template.name;
        $('#prompt-template-content').value = template.content;
        $('#prompt-template-name')?.focus();
      } else if (action === 'delete' && !template.builtin) {
        const confirmed = window.confirm('确定要删除这个自定义模板吗？');
        if (confirmed) {
          saveCustomPromptTemplates(deleteCustomTemplate(loadCustomPromptTemplates(), template.id));
          renderPromptTemplates();
          renderDataStats();
          showToast('模板已删除', 'success');
        }
      }
    }, { signal });
  }

  const templateForm = $('#prompt-template-form');
  if (templateForm) {
    templateForm.addEventListener('submit', (e) => {
      e.preventDefault();
      try {
        const next = upsertCustomTemplate(loadCustomPromptTemplates(), {
          id: $('#prompt-template-id')?.value || undefined,
          name: $('#prompt-template-name')?.value,
          content: $('#prompt-template-content')?.value,
        });
        saveCustomPromptTemplates(next);
        renderPromptTemplates();
        renderDataStats();
        resetTemplateForm();
        showToast('模板已保存', 'success');
      } catch (err) {
        showToast(err.message || '模板保存失败', 'error');
      }
    }, { signal });
  }

  const templateResetBtn = $('#prompt-template-reset-btn');
  if (templateResetBtn) {
    templateResetBtn.addEventListener('click', resetTemplateForm, { signal });
  }

  // Chat messages area — action buttons & thinking toggles
  const chatMessagesInner = $('#chat-messages-inner');
  if (chatMessagesInner) {
    chatMessagesInner.addEventListener('click', (e) => {
      const focusInputBtn = e.target.closest('#welcome-focus-input-btn');
      if (focusInputBtn) {
        $('#chat-input')?.focus();
        return;
      }

      const openSettingsBtn = e.target.closest('#welcome-open-settings-btn');
      if (openSettingsBtn) {
        openSettingsModal();
        return;
      }

      const importDataBtn = e.target.closest('#welcome-import-data-btn');
      if (importDataBtn) {
        renderDataStats();
        openModal('data-management-modal');
        return;
      }

      handleMessageAction(e);
      handleThinkingToggle(e);

      // Welcome card prompt click
      const card = e.target.closest('.welcome-card');
      if (card) {
        const prompt = card.dataset.prompt;
        if (prompt) {
          const textarea = $('#chat-input');
          if (textarea) {
            textarea.value = prompt;
            autoResizeTextarea(textarea);
            updateSendButton(canSend());
            textarea.focus();
          }
        }
      }
    }, { signal });
  }
}

// ============================================
// Keyboard Shortcuts
// ============================================

function bindKeyboardShortcuts() {
  const signal = eventController?.signal;
  const modKey = isMac() ? 'metaKey' : 'ctrlKey';

  document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd + N — New conversation
    if (e[modKey] && e.key === 'n') {
      e.preventDefault();
      createNewConversation();
      return;
    }

    // Ctrl/Cmd + Shift + S — Toggle sidebar
    if (e[modKey] && e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      toggleSidebar();
      return;
    }

    // Ctrl/Cmd + Shift + L — Toggle theme
    if (e[modKey] && e.shiftKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      toggleTheme();
      return;
    }

    // Escape — Close modal or stop generation
    if (e.key === 'Escape') {
      if (isModalOpen()) {
        closeModal();
      } else if (isRuntimeSettingsOpen()) {
        closeRuntimeSettings();
      } else if (state.isStreaming) {
        state.abortStream();
      } else {
        // Close model selector dropdown
        setModelSelectorOpen(document.querySelector('.model-selector'), false);
      }
      return;
    }
  }, { signal });
}

// ============================================
// Paste Handler (long text and image detection)
// ============================================

function bindPasteHandler() {
  const signal = eventController?.signal;
  const textarea = $('#chat-input');
  if (!textarea) return;

  textarea.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text/plain') || '';
    if (text.length > LONG_TEXT_AUTO_MD_THRESHOLD) {
      e.preventDefault();
      addLongTextAttachmentFromContent(text).then((created) => {
        if (created) updateSendButton(canSend());
      });
      return;
    }

    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) handleFileSelection([file], { source: 'paste' });
        return;
      }
    }
  }, { signal });
}

// ============================================
// Storage Warning
// ============================================

function bindStorageWarning() {
  const signal = eventController?.signal;
  window.addEventListener('storage-error', (e) => {
    const detail = e.detail;
    showToast(`存储${detail.operation === 'read' ? '读取' : '写入'}失败`, 'error');
  }, { signal });
}

// ============================================
// File Upload Handling
// ============================================

/**
 * Process selected files and add to pending attachments.
 * @param {FileList|Array<File>} files
 * @param {{source?: 'upload'|'drop'|'paste'}} [options]
 */
function handleFileSelection(files, options = {}) {
  const source = options.source || 'upload';
  let acceptedCount = 0;

  for (const [index, file] of Array.from(files).entries()) {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    const isImage = file.type.startsWith('image/');

    if (isImage) {
      if (file.size > MAX_IMAGE_FILE_SIZE) {
        showToast(`图片 ${file.name} 超过 5MB 限制`, 'warning');
        continue;
      }
      readFileAsDataUrl(file).then((dataUrl) => {
        pendingAttachments.push({
          type: 'image',
          name: getAttachmentFileName(file, index),
          size: file.size,
          dataUrl,
        });
        renderAttachmentPreview();
        updateSendButton(canSend());
        if (source === 'paste') showToast('已粘贴图片到输入框', 'success', 1800);
      });
      acceptedCount += 1;
    } else if (TEXT_EXTENSIONS.has(ext)) {
      if (file.size > MAX_TEXT_FILE_SIZE) {
        showToast(`文件 ${file.name} 超过 100KB 限制`, 'warning');
        continue;
      }
      readFileAsText(file).then((content) => {
        pendingAttachments.push({
          type: 'text',
          name: getAttachmentFileName(file, index),
          size: file.size,
          content,
        });
        renderAttachmentPreview();
        updateSendButton(canSend());
      });
      acceptedCount += 1;
    } else {
      showToast(`不支持的文件类型: .${ext}`, 'warning');
    }
  }

  if (source === 'drop' && acceptedCount > 0) {
    showToast(`已添加 ${acceptedCount} 个附件`, 'success', 1800);
  }
}

/**
 * Read a file as text.
 * @param {File} file
 * @returns {Promise<string>}
 */
function readFileAsText(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve('');
    reader.readAsText(file);
  });
}

/**
 * Read a file as data URL (base64).
 * @param {File} file
 * @returns {Promise<string>}
 */
function readFileAsDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  });
}

function getAttachmentFileName(file, index) {
  const name = String(file.name || '').trim();
  if (name) return name;

  const typeParts = String(file.type || '').split('/');
  const rawExt = typeParts.length > 1 ? typeParts[1].split(';')[0] : '';
  const ext = rawExt === 'jpeg' ? 'jpg' : (rawExt || 'bin');
  const prefix = String(file.type || '').startsWith('image/') ? 'pasted-image' : 'attachment';
  return `${prefix}-${Date.now()}-${index + 1}.${ext}`;
}

function formatFileSize(bytes = 0) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getAttachmentIconHTML(type) {
  if (type === 'image') {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="8.5" cy="10" r="1.5"/><path d="m21 15-4.2-4.2a2 2 0 0 0-2.8 0L7 18"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h5"/><path d="M8 13h8"/><path d="M8 17h5"/></svg>';
}

async function addLongTextAttachmentFromContent(content) {
  try {
    const attachment = createGeneratedMdAttachment(content);
    await saveLongTextAttachment(attachment, content);
    pendingAttachments.push(attachment);
    renderAttachmentPreview();
    showToast('长文本已转换为本地 md 附件（引用模式）', 'success', 2200);
    return true;
  } catch (err) {
    showToast(err.message || '长文本附件保存失败', 'error', 3000);
    return false;
  }
}

async function downloadLongTextAttachment(att) {
  const content = await getLongTextContent(att.id);
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = att.name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Render the attachment preview chips.
 */
function getAttachmentChipIcon(type) {
  if (type === 'image') {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 14 2.4-2.4a2 2 0 0 1 2.8 0L18 16"/><circle cx="8.5" cy="8.5" r="1.5"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>';
}

function renderAttachmentPreview() {
  const container = $('#attachment-preview');
  if (!container) return;
  const composer = $('.composer');

  if (pendingAttachments.length === 0) {
    container.classList.add('hidden');
    composer?.classList.remove('composer--has-attachments');
    container.innerHTML = '';
    updateComposerAttachmentStatus(0);
    return;
  }

  container.classList.remove('hidden');
  composer?.classList.add('composer--has-attachments');
  container.innerHTML = pendingAttachments.map((att, i) => {
    const sizeLabel = formatFileSize(att.size);
    if (att.type === 'generated-md') {
      const modeLabel = att.mode === 'full' ? '全文' : '引用';
      const warning = att.mode === 'full' ? '<span class="attachment-chip__meta attachment-chip__meta--warning">会消耗更多 tokens</span>' : '';
      return `
        <div class="attachment-chip file-chip attachment-chip--generated">
          <span class="attachment-chip__thumb attachment-chip__thumb--icon">${getAttachmentIconHTML('text')}</span>
          <span class="attachment-chip__body">
            <span class="attachment-chip__name">${escapeHTML(att.name)}</span>
            <span class="attachment-chip__meta">${att.charCount} 字${warning ? ' · ' : ''}${warning}</span>
          </span>
          <span class="attachment-chip__actions">
            <button type="button" class="attachment-chip__mode" data-action="toggle-mode" data-index="${i}" aria-label="切换长文本发送模式">${modeLabel}</button>
            <button type="button" class="attachment-chip__download" data-action="download" data-index="${i}" aria-label="下载 ${escapeHTML(att.name)}">下载</button>
            <button type="button" class="attachment-chip__remove" data-action="remove" data-index="${i}" aria-label="移除">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </span>
        </div>
      `;
    }
    const thumb = att.type === 'image' && att.dataUrl
      ? `<img class="attachment-chip__thumb attachment-chip__thumb--image" src="${escapeHTML(att.dataUrl)}" alt="" loading="lazy" />`
      : `<span class="attachment-chip__thumb attachment-chip__thumb--icon">${getAttachmentIconHTML(att.type)}</span>`;
    const meta = [att.type === 'image' ? '图片' : '文本', sizeLabel].filter(Boolean).join(' · ');
    return `
      <div class="attachment-chip file-chip${att.type === 'image' ? ' attachment-chip--image' : ''}">
        ${thumb}
        <span class="attachment-chip__body">
          <span class="attachment-chip__name">${escapeHTML(att.name)}</span>
          <span class="attachment-chip__meta">${escapeHTML(meta)}</span>
        </span>
        <button type="button" class="attachment-chip__remove" data-action="remove" data-index="${i}" aria-label="移除">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    `;
  }).join('');
  updateComposerAttachmentStatus(pendingAttachments.length);

  container.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = Number.parseInt(btn.dataset.index, 10);
      const att = pendingAttachments[idx];
      if (!att) return;
      if (btn.dataset.action === 'remove') {
        pendingAttachments.splice(idx, 1);
      } else if (btn.dataset.action === 'toggle-mode') {
        att.mode = att.mode === 'full' ? 'reference' : 'full';
        if (att.mode === 'full') {
          showToast('已切换为全文模式，本次请求会发送完整 md 内容', 'warning', 2600);
        }
      } else if (btn.dataset.action === 'download') {
        await downloadLongTextAttachment(att);
      }
      renderAttachmentPreview();
      updateSendButton(canSend());
    });
  });
}

// ============================================
// Boot
// ============================================

// Wait for DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Cleanup on page unload
window.addEventListener('beforeunload', cleanup);
