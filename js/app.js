/**
 * Main entry point — initialization, event binding, keyboard shortcuts.
 */

import { state } from './state.js';
import { MODELS } from './config.js';
import { initTheme, toggleTheme } from './theme.js';
import { initMarkdown } from './markdown.js';
import {
  loadConversations,
  loadActiveConversationId,
  loadSelectedModel,
  loadSettings,
  saveSelectedModel,
  saveSettings,
  saveConversations,
  saveActiveConversationId,
  clearAllData,
  isStorageNearFull,
} from './storage.js';
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
import { debounce, isMac } from './utils.js';

// ---- DOM References ----
const $ = (sel) => document.querySelector(sel);

/**
 * Boot the application.
 */
function init() {
  // Initialize subsystems
  initTheme();
  initMarkdown();
  initScrollTracking();
  initCodeBlockCopy();
  initNetworkStatus();

  // Load persisted state
  loadConversations();
  loadSelectedModel();
  loadSettings();
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

  // Initial send button state
  const textarea = $('#chat-input');
  updateSendButton(textarea?.value.trim().length > 0);

  // Check storage
  if (isStorageNearFull()) {
    showToast('本地存储空间即将用完，建议清理旧对话', 'warning');
  }

  // First-run: prompt to configure API if not set
  if (!state.isApiConfigured) {
    showToast('请先点击右上角设置按钮，配置 API 地址和密钥', 'warning', 6000);
  }
}

// ============================================
// Input Events
// ============================================

function bindInputEvents() {
  const textarea = $('#chat-input');
  const sendBtn = $('#send-btn');
  const stopBtn = $('#stop-btn');

  if (textarea) {
    // Auto-resize on input
    textarea.addEventListener('input', () => {
      autoResizeTextarea(textarea);
      updateSendButton(textarea.value.trim().length > 0 && !state.isStreaming);
    });

    // Enter to send, Shift+Enter for newline
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (textarea.value.trim() && !state.isStreaming) {
          sendMessage(textarea.value);
        }
      }
    });
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', () => {
      if (textarea?.value.trim() && !state.isStreaming) {
        sendMessage(textarea.value);
      }
    });
  }

  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      state.abortStream();
    });
  }
}

// ============================================
// Sidebar Events
// ============================================

function bindSidebarEvents() {
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
    });
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
    });

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
    });

    // Keyboard navigation for conversation items
    conversationList.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        const item = e.target.closest('.conversation-item');
        if (item) {
          e.preventDefault();
          item.click();
        }
      }
    });
  }

  if (searchInput) {
    const debouncedSearch = debounce((value) => {
      renderConversationList(value);
    }, 300);

    searchInput.addEventListener('input', (e) => {
      debouncedSearch(e.target.value);
    });
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
    });
  }

  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      exportConversation();
    });
  }

  if (sidebarOverlay) {
    sidebarOverlay.addEventListener('click', closeSidebar);
  }

  if (shortcutsBtn) {
    shortcutsBtn.addEventListener('click', () => {
      openModal('shortcuts-modal');
    });
  }
}

// ============================================
// Header Events
// ============================================

function bindHeaderEvents() {
  const sidebarToggle = $('#sidebar-toggle');
  const themeToggle = $('#theme-toggle');
  const settingsBtn = $('#settings-btn');
  const modelSelector = $('.model-selector');
  const modelTrigger = $('#model-trigger');
  const modelList = $('#model-list');

  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', toggleSidebar);
  }

  if (themeToggle) {
    themeToggle.addEventListener('click', toggleTheme);
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
    });
  }

  // Model selector dropdown
  if (modelTrigger && modelSelector) {
    modelTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      modelSelector.classList.toggle('open');
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (!modelSelector.contains(e.target)) {
        modelSelector.classList.remove('open');
      }
    });
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

      modelSelector?.classList.remove('open');
    });
  }

  // System prompt indicator click
  const sysPromptIndicator = $('.system-prompt-indicator');
  if (sysPromptIndicator) {
    sysPromptIndicator.addEventListener('click', () => {
      settingsBtn?.click();
    });
  }
}

// ============================================
// Modal Events
// ============================================

function bindModalEvents() {
  // Close modal on overlay click
  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });
  });

  // Close buttons
  document.querySelectorAll('.modal__close').forEach((btn) => {
    btn.addEventListener('click', closeModal);
  });

  // Settings modal — save
  // API key visibility toggle
  const toggleKeyBtn = $('#toggle-api-key-visibility');
  const apiKeyField = $('#settings-api-key');
  if (toggleKeyBtn && apiKeyField) {
    toggleKeyBtn.addEventListener('click', () => {
      const isPassword = apiKeyField.type === 'password';
      apiKeyField.type = isPassword ? 'text' : 'password';
    });
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
      if (apiBaseUrlInput) state.apiBaseUrl = apiBaseUrlInput.value.trim().replace(/\/+$/, '');
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
    });
  }

  // Temperature slider live update
  const tempSlider = $('#settings-temperature');
  const tempValue = $('#temp-value');
  if (tempSlider && tempValue) {
    tempSlider.addEventListener('input', () => {
      tempValue.textContent = parseFloat(tempSlider.value).toFixed(1);
    });
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
    });
  }
}

// ============================================
// Keyboard Shortcuts
// ============================================

function bindKeyboardShortcuts() {
  const modKey = isMac() ? 'metaKey' : 'ctrlKey';

  document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd + N — New conversation
    if (e[modKey] && e.key === 'n') {
      e.preventDefault();
      createNewConversation();
      return;
    }

    // Ctrl/Cmd + Shift + S — Toggle sidebar
    if (e[modKey] && e.shiftKey && e.key === 'S') {
      e.preventDefault();
      toggleSidebar();
      return;
    }

    // Ctrl/Cmd + Shift + L — Toggle theme
    if (e[modKey] && e.shiftKey && e.key === 'L') {
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
        document.querySelector('.model-selector')?.classList.remove('open');
      }
      return;
    }
  });
}

// ============================================
// Paste Handler (image detection)
// ============================================

function bindPasteHandler() {
  const textarea = $('#chat-input');
  if (!textarea) return;

  textarea.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        showToast('暂不支持图片输入', 'warning');
        return;
      }
    }
  });
}

// ============================================
// Storage Warning
// ============================================

function bindStorageWarning() {
  window.addEventListener('storage-full', () => {
    showToast('本地存储空间已满，请清理旧对话', 'error');
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
