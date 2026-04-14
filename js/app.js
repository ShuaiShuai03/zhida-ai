/**
 * Main entry point — initialization, event binding, keyboard shortcuts.
 */

import { state } from './state.js';
import { initTheme, toggleTheme, cleanupTheme } from './theme.js';
import { initMarkdown } from './markdown.js';
import { FILE_INPUT_ACCEPT, SUPPORTED_TEXT_FILE_EXTENSIONS } from './config.js';
import {
  loadConversations,
  loadActiveConversationId,
  loadSelectedModel,
  loadSettings,
  loadCachedModels,
  saveCachedModels,
  saveSelectedModel,
  saveSettings,
  saveConversations,
  saveActiveConversationId,
  clearAllData,
  isStorageNearFull,
} from './storage.js';
import { fetchAvailableModels } from './api.js';
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
  cleanupUI,
} from './ui.js';
import {
  createNewConversation,
  switchConversation,
  deleteConversation,
  renameConversation,
  sendMessage,
  exportConversation,
  handleMessageAction,
  handleThinkingToggle,
} from './chat.js';
import { debounce, isMac, escapeHTML } from './utils.js';

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
    apiConfig = null,
  } = options;

  try {
    const models = await fetchAvailableModels(apiConfig ?? undefined);
    if (models.length > 0) {
      state.models = models;
      saveCachedModels();

      // If current selection is no longer in the list, pick the first model
      if (!models.some((m) => m.id === state.selectedModelId)) {
        state.selectedModelId = models[0].id;
        saveSelectedModel();
      }

      renderModelDropdown();
      updateModelTrigger();
      renderConversationList();

      if (!silent) showToast(`已获取 ${models.length} 个可用模型`, 'success');
    } else if (!silent) {
      showToast('未获取到可用模型', 'warning');
    }
  } catch (err) {
    console.warn('Failed to fetch models:', err);
    if (!silent) showToast('获取模型列表失败，请检查 API 配置', 'error');
  }
}

/**
 * Boot the application.
 */
function init() {
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

  // Render initial UI
  renderModelDropdown();
  updateModelTrigger();
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
  if (!state.isApiConfigured) {
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

function doSend() {
  const textarea = $('#chat-input');
  if (!canSend()) return;
  const attachments = [...pendingAttachments];
  pendingAttachments = [];
  renderAttachmentPreview();
  sendMessage(textarea.value, attachments);
}

function bindInputEvents() {
  const signal = eventController?.signal;
  const textarea = $('#chat-input');
  const sendBtn = $('#send-btn');
  const stopBtn = $('#stop-btn');
  const uploadBtn = $('#upload-btn');
  const fileInput = $('#file-input');

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
      if (apiKeyInput) apiKeyInput.value = state.apiKey;
      if (sysPromptInput) sysPromptInput.value = state.systemPrompt;
      if (tempSlider) tempSlider.value = state.temperature;
      if (tempValue) tempValue.textContent = state.temperature.toFixed(1);
      if (maxTokensInput) maxTokensInput.value = state.maxTokens;

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
      state.selectedModelId = modelId;
      saveSelectedModel();

      // Update active conversation model if applicable
      if (state.activeConversation) {
        state.activeConversation.modelId = modelId;
        saveConversations();
      }

      renderModelDropdown();
      updateModelTrigger();
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
    settingsSaveBtn.addEventListener('click', () => {
      const apiBaseUrlInput = $('#settings-api-base-url');
      const apiKeyInput = $('#settings-api-key');
      const sysPromptInput = $('#settings-system-prompt');
      const tempSlider = $('#settings-temperature');
      const maxTokensInput = $('#settings-max-tokens');

      // Save API config — strip trailing slash from base URL
      if (apiBaseUrlInput) state.apiBaseUrl = normalizeApiBaseUrl(apiBaseUrlInput.value);
      if (apiKeyInput) state.apiKey = apiKeyInput.value.trim();
      if (sysPromptInput) state.systemPrompt = sysPromptInput.value;
      if (tempSlider) state.temperature = parseFloat(tempSlider.value);
      if (maxTokensInput) state.maxTokens = parseInt(maxTokensInput.value, 10) || 4096;

      // Update active conversation's system prompt
      if (state.activeConversation) {
        state.activeConversation.systemPrompt = state.systemPrompt;
        saveConversations();
      }

      saveSettings();
      updateSystemPromptIndicator();
      closeModal();
      showToast('设置已保存', 'success');

      // Refresh model list from new API config
      if (state.isApiConfigured) {
        refreshModels();
      }
    }, { signal });
  }

  // Fetch models button
  const fetchModelsBtn = $('#fetch-models-btn');
  if (fetchModelsBtn) {
    fetchModelsBtn.addEventListener('click', async () => {
      const apiConfig = getSettingsApiConfig();
      if (!apiConfig.apiBaseUrl || !apiConfig.apiKey) {
        showToast('请先填写 API 地址和密钥', 'warning');
        return;
      }

      fetchModelsBtn.disabled = true;
      fetchModelsBtn.textContent = '获取中...';

      try {
        const models = await fetchAvailableModels(apiConfig);
        if (models.length > 0) {
          showToast(`已获取 ${models.length} 个可用模型`, 'success');
        } else {
          showToast('未获取到可用模型', 'warning');
        }
      } catch (err) {
        console.warn('Failed to fetch models from settings form:', err);
        showToast('获取模型列表失败，请检查 API 配置', 'error');
      }

      fetchModelsBtn.disabled = false;
      fetchModelsBtn.textContent = '获取模型列表';
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
// Paste Handler (image detection)
// ============================================

function bindPasteHandler() {
  const signal = eventController?.signal;
  const textarea = $('#chat-input');
  if (!textarea) return;

  textarea.addEventListener('paste', (e) => {
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
  container.innerHTML = pendingAttachments.map((att, i) => `
    <div class="attachment-chip${att.type === 'image' ? ' attachment-chip--image' : ''}">
      <span class="attachment-chip__icon">${att.type === 'image' ? '🖼️' : '📄'}</span>
      <span class="attachment-chip__name">${escapeHTML(att.name)}</span>
      <button class="attachment-chip__remove" data-index="${i}" aria-label="移除">&times;</button>
    </div>
  `).join('');

  // Bind remove buttons
  container.querySelectorAll('.attachment-chip__remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index, 10);
      pendingAttachments.splice(idx, 1);
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
