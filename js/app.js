/**
 * Main entry point — initialization, event binding, keyboard shortcuts.
 */

import { state } from './state.js';
import { initTheme, toggleTheme, cleanupTheme } from './theme.js';
import { initMarkdown } from './markdown.js';
import {
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
  isStorageNearFull,
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
  updateComposerCapabilityControls,
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

/**
 * Initialize event controller for cleanup.
 */
function initEventController() {
  eventController = new AbortController();
  return eventController.signal;
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
  if (!statusNode) return;

  if (state.backendAvailable === false) {
    statusNode.textContent = state.backendError || BACKEND_UNAVAILABLE_MESSAGE;
    statusNode.hidden = false;
    if (fetchModelsBtn) {
      fetchModelsBtn.disabled = true;
      fetchModelsBtn.title = '需要先启动 Node 后端代理';
    }
    return;
  }

  statusNode.hidden = true;
  statusNode.textContent = '';
  if (fetchModelsBtn) {
    fetchModelsBtn.disabled = false;
    fetchModelsBtn.title = '';
  }
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
}

function updateShortcutLabels() {
  const label = isMac() ? 'Cmd' : 'Ctrl';
  document.querySelectorAll('[data-shortcut-mod]').forEach((node) => {
    node.textContent = label;
  });
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
  // Initialize event controller for cleanup
  initEventController();

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
  loadSelectedModel();
  loadActiveConversationId();
  await refreshConfigStatus();

  // Render initial UI
  renderModelDropdown();
  updateModelTrigger();
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
  const textarea = $('#chat-input');
  updateSendButton(textarea?.value.trim().length > 0);

  // Check storage
  if (isStorageNearFull()) {
    showToast('本地存储空间即将用完，建议清理旧对话', 'warning');
  }

  // First-run: prompt to configure API if not set
  if (state.backendAvailable === false) {
    showToast(state.backendError || BACKEND_UNAVAILABLE_MESSAGE, 'error', 6000);
  } else if (!state.isApiConfigured) {
    showToast('请先点击右上角设置按钮，配置 API 地址和密钥', 'warning', 3000);
  } else {
    // Auto-refresh models from the API in background
    refreshModels();
  }
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
  const textarea = $('#chat-input');
  const sendBtn = $('#send-btn');
  const stopBtn = $('#stop-btn');
  const uploadBtn = $('#upload-btn');
  const inputTemplateBtn = $('#input-template-btn');
  const fileInput = $('#file-input');
  const webSearchToggle = $('#web-search-toggle');
  const reasoningSelect = $('#reasoning-effort-select');

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

  if (sendBtn) {
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
        showToast(state.selectedModel.capabilityReason || '当前模型不支持网络搜索', 'warning', 2000);
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
    }, { signal });
    inputArea.addEventListener('dragleave', () => {
      inputArea.classList.remove('drag-over');
    }, { signal });
    inputArea.addEventListener('drop', (e) => {
      e.preventDefault();
      inputArea.classList.remove('drag-over');
      if (e.dataTransfer?.files.length) {
        handleFileSelection(e.dataTransfer.files);
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

      const id = item.dataset.id;
      const currentTitle = titleEl.textContent;

      // Replace title with inline input
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'conversation-item__rename-input';
      input.value = currentTitle;
      input.setAttribute('aria-label', '重命名对话');

      titleEl.replaceWith(input);
      input.focus();
      input.select();

      const commit = () => {
        const newTitle = input.value.trim();
        if (newTitle && newTitle !== currentTitle) {
          renameConversation(id, newTitle);
        } else {
          // Restore original title element
          const restored = document.createElement('div');
          restored.className = 'conversation-item__title';
          restored.textContent = currentTitle;
          input.replaceWith(restored);
        }
      };

      input.addEventListener('keydown', (ke) => {
        if (ke.key === 'Enter') {
          ke.preventDefault();
          commit();
        } else if (ke.key === 'Escape') {
          ke.preventDefault();
          // Restore original
          const restored = document.createElement('div');
          restored.className = 'conversation-item__title';
          restored.textContent = currentTitle;
          input.replaceWith(restored);
        }
      });

      input.addEventListener('blur', commit, { once: true });
    }, { signal });

    // Keyboard navigation for conversation items
    conversationList.addEventListener('keydown', (e) => {
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

// ============================================
// Header Events
// ============================================

function bindHeaderEvents() {
  const signal = eventController?.signal;
  const sidebarToggle = $('#sidebar-toggle');
  const themeToggle = $('#theme-toggle');
  const settingsBtn = $('#settings-btn');
  const modelSelector = $('.model-selector');
  const modelTrigger = $('#model-trigger');
  const modelList = $('#model-list');

  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', toggleSidebar, { signal });
  }

  if (themeToggle) {
    themeToggle.addEventListener('click', toggleTheme, { signal });
  }

  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      // Populate settings form with current values
      const apiBaseUrlInput = $('#settings-api-base-url');
      const apiKeyInput = $('#settings-api-key');
      const sysPromptInput = $('#settings-system-prompt');
      const tempSlider = $('#settings-temperature');
      const tempValue = $('#temp-value');
      const maxTokensInput = $('#settings-max-tokens');

      if (apiBaseUrlInput) apiBaseUrlInput.value = state.apiBaseUrl;
      if (apiKeyInput) {
        apiKeyInput.value = '';
        apiKeyInput.type = 'password';
      }
      if (sysPromptInput) sysPromptInput.value = state.systemPrompt;
      if (tempSlider) tempSlider.value = state.temperature;
      if (tempValue) tempValue.textContent = state.temperature.toFixed(1);
      if (maxTokensInput) maxTokensInput.value = state.maxTokens;
      updateBackendStatusUI();

      openModal('settings-modal');
    }, { signal });
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
    modelList.addEventListener('click', (e) => {
      const item = e.target.closest('.model-selector__item');
      if (!item) return;

      const modelId = item.dataset.modelId;
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
    }, { signal });
  }

  // System prompt indicator click
  const sysPromptIndicator = $('.system-prompt-indicator');
  if (sysPromptIndicator) {
    sysPromptIndicator.addEventListener('click', () => {
      settingsBtn?.click();
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
      const tempSlider = $('#settings-temperature');
      const maxTokensInput = $('#settings-max-tokens');

      if (sysPromptInput) state.systemPrompt = sysPromptInput.value;
      if (tempSlider) state.temperature = parseFloat(tempSlider.value);
      if (maxTokensInput) state.maxTokens = parseInt(maxTokensInput.value, 10) || 4096;

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
        showToast(err.message || 'API 配置保存失败', 'error');
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

  // Temperature slider live update
  const tempSlider = $('#settings-temperature');
  const tempValue = $('#temp-value');
  if (tempSlider && tempValue) {
    tempSlider.addEventListener('input', () => {
      tempValue.textContent = parseFloat(tempSlider.value).toFixed(1);
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
          }
          sendMessage(prompt);
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
        if (file) handleFileSelection([file]);
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
  window.addEventListener('storage-full', () => {
    showToast('本地存储空间已满，请清理旧对话', 'error');
  }, { signal });
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
 */
function handleFileSelection(files) {
  for (const file of files) {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    const isImage = file.type.startsWith('image/');

    if (isImage) {
      if (file.size > MAX_IMAGE_FILE_SIZE) {
        showToast(`图片 ${file.name} 超过 5MB 限制`, 'warning');
        continue;
      }
      readFileAsDataUrl(file).then((dataUrl) => {
        pendingAttachments.push({ type: 'image', name: file.name, dataUrl });
        renderAttachmentPreview();
        updateSendButton(canSend());
      });
    } else if (TEXT_EXTENSIONS.has(ext)) {
      if (file.size > MAX_TEXT_FILE_SIZE) {
        showToast(`文件 ${file.name} 超过 100KB 限制`, 'warning');
        continue;
      }
      readFileAsText(file).then((content) => {
        pendingAttachments.push({ type: 'text', name: file.name, content });
        renderAttachmentPreview();
        updateSendButton(canSend());
      });
    } else {
      showToast(`不支持的文件类型: .${ext}`, 'warning');
    }
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
function renderAttachmentPreview() {
  const container = $('#attachment-preview');
  if (!container) return;

  if (pendingAttachments.length === 0) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }

  container.classList.remove('hidden');
  container.innerHTML = pendingAttachments.map((att, i) => {
    if (att.type === 'generated-md') {
      const modeLabel = att.mode === 'full' ? '全文' : '引用';
      const warning = att.mode === 'full' ? '<span class="attachment-chip__meta">会消耗更多 tokens</span>' : '';
      return `
        <div class="attachment-chip attachment-chip--generated">
          <span class="attachment-chip__icon">📄</span>
          <span class="attachment-chip__name">${escapeHTML(att.name)}</span>
          <span class="attachment-chip__meta">${att.charCount} 字</span>
          ${warning}
          <button type="button" class="attachment-chip__mode" data-action="toggle-mode" data-index="${i}" aria-label="切换长文本发送模式">模式：${modeLabel}</button>
          <button type="button" class="attachment-chip__download" data-action="download" data-index="${i}" aria-label="下载 ${escapeHTML(att.name)}">下载</button>
          <button type="button" class="attachment-chip__remove" data-action="remove" data-index="${i}" aria-label="移除">&times;</button>
        </div>
      `;
    }
    return `
      <div class="attachment-chip${att.type === 'image' ? ' attachment-chip--image' : ''}">
        <span class="attachment-chip__icon">${att.type === 'image' ? '🖼️' : '📄'}</span>
        <span class="attachment-chip__name">${escapeHTML(att.name)}</span>
        <button type="button" class="attachment-chip__remove" data-action="remove" data-index="${i}" aria-label="移除">&times;</button>
      </div>
    `;
  }).join('');

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
