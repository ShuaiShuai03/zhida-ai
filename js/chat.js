/**
 * Chat logic — message handling, thinking block parsing, send/receive flow.
 */

import { state } from './state.js';
import { generateId, copyToClipboard } from './utils.js';
import { TITLE_MAX_LENGTH, DEFAULT_SYSTEM_PROMPT } from './config.js';
import {
  buildAssistantMessageFromBuffers,
  deriveConversationTitle,
  resolveConversationModel,
} from './conversation-utils.js';
import { streamChatCompletion } from './api.js';
import {
  saveConversation,
  saveConversations,
  saveActiveConversationId,
  saveSelectedModel,
} from './storage.js';
import {
  renderMessages,
  appendUserMessage,
  createStreamingMessage,
  replaceStreamingMessage,
  showStopButton,
  updateSendButton,
  scrollToBottom,
  showToast,
  renderConversationList,
  renderModelDropdown,
  updateModelTrigger,
  updateSystemPromptIndicator,
} from './ui.js';

/**
 * Create a new conversation and set it as active.
 */
export function createNewConversation() {
  // Abort any current stream
  state.abortStream();

  const conv = {
    id: generateId(),
    title: '新对话',
    modelId: state.selectedModelId,
    systemPrompt: state.systemPrompt,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  if (!saveConversation(conv)) {
    showToast('新对话保存失败，请清理本地存储后重试', 'error');
    return;
  }

  state.activeConversationId = conv.id;
  saveActiveConversationId();
  renderMessages();
  renderConversationList();
  updateSystemPromptIndicator();

  // Focus input
  const textarea = document.querySelector('#chat-input');
  textarea?.focus();
}

/**
 * Switch to an existing conversation.
 * @param {string} conversationId
 */
export function switchConversation(conversationId) {
  if (state.isStreaming) {
    state.abortStream();
  }

  state.activeConversationId = conversationId;
  saveActiveConversationId();

  // Load conversation's system prompt
  const conv = state.activeConversation;
  if (conv) {
    state.systemPrompt = conv.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    const model = resolveConversationModel(state.models, conv.modelId, state.selectedModel);
    state.selectedModelId = model.id;
    saveSelectedModel();
  }

  renderModelDropdown();
  updateModelTrigger();
  renderMessages();
  renderConversationList();
  updateSystemPromptIndicator();
}

/**
 * Delete a conversation by ID.
 * @param {string} conversationId
 */
export function deleteConversation(conversationId) {
  const wasActive = state.activeConversationId === conversationId;

  if (wasActive && state.isStreaming) {
    state.abortStream();
    state.currentRequestId = null;
  }

  const nextConversations = state.conversations.filter((c) => c.id !== conversationId);
  if (!saveConversations(nextConversations)) {
    showToast('删除失败：本地存储写入失败', 'error');
    return;
  }

  if (wasActive) {
    state.activeConversationId = null;
    saveActiveConversationId();
  }

  renderMessages();
  renderConversationList();
  showToast('对话已删除', 'success');
}

/**
 * Rename a conversation by ID.
 * @param {string} conversationId
 * @param {string} newTitle
 */
export function renameConversation(conversationId, newTitle) {
  const conv = state.conversations.find((c) => c.id === conversationId);
  if (!conv) return;

  const trimmed = newTitle.trim();
  if (!trimmed || trimmed === conv.title) return;

  const nextConv = {
    ...conv,
    title: deriveConversationTitle(trimmed, [], { maxLength: TITLE_MAX_LENGTH }),
    updatedAt: Date.now(),
  };
  if (!saveConversation(nextConv)) {
    showToast('重命名失败：本地存储写入失败', 'error');
    return;
  }
  renderConversationList();
  showToast('对话已重命名', 'success');
}

/**
 * Send a user message and stream the AI response.
 * @param {string} text - User input text
 * @param {Array} [attachments=[]] - File attachments ({ type, name, content, dataUrl })
 */
export async function sendMessage(text, attachments = []) {
  const trimmed = text.trim();
  if (!trimmed && attachments.length === 0) return;
  if (state.isStreaming) return;

  // Ensure we have an active conversation
  if (!state.activeConversation) {
    createNewConversation();
  }

  const conv = state.activeConversation;
  if (!conv) return;

  // Generate unique request ID to prevent race conditions
  const requestId = generateId();
  state.currentRequestId = requestId;

  // Build display content: user text + text file contents + image markers
  let displayContent = trimmed;
  const imageDataUrls = [];

  for (const att of attachments) {
    if (att.type === 'text') {
      displayContent += `\n\n📎 ${att.name}:\n\`\`\`\n${att.content}\n\`\`\``;
    } else if (att.type === 'image') {
      displayContent += `\n\n📎 [图片: ${att.name}]`;
      imageDataUrls.push(att.dataUrl);
    }
  }

  // Create user message
  const userMsg = {
    id: generateId(),
    role: 'user',
    content: displayContent,
    images: imageDataUrls.length > 0 ? imageDataUrls : undefined,
    timestamp: Date.now(),
  };

  const nextMessages = [...conv.messages, userMsg];

  // Auto-title from first message
  const nextTitle = nextMessages.filter((m) => m.role === 'user').length === 1
    ? deriveConversationTitle(trimmed, attachments, { maxLength: TITLE_MAX_LENGTH })
    : conv.title;

  const requestConv = {
    ...conv,
    modelId: state.selectedModelId,
    title: nextTitle,
    messages: nextMessages,
    updatedAt: Date.now(),
  };

  if (!saveConversation(requestConv)) {
    clearCurrentStreamRequest(requestId);
    showToast('消息保存失败，请清理本地存储后重试', 'error');
    return;
  }

  // Display user message
  appendUserMessage(userMsg);
  renderConversationList();

  // Clear input
  const textarea = document.querySelector('#chat-input');
  if (textarea) {
    textarea.value = '';
    textarea.style.height = 'auto';
  }
  updateSendButton(false);

  // Start streaming
  state.isStreaming = true;
  showStopButton(true);

  // Build messages array for API
  const apiMessages = buildAPIMessages(requestConv);

  // Create streaming UI
  const streaming = createStreamingMessage();
  let contentBuffer = '';
  let reasoningBuffer = '';
  const isThinkingModel = state.selectedModel.type === 'thinking';

  await streamChatCompletion(apiMessages, {
    onToken(token) {
      // Ignore if this is not the current request
      if (!isCurrentStreamRequest(requestId)) return;
      contentBuffer += token;
      updateStreamingBuffers(streaming, contentBuffer, reasoningBuffer, isThinkingModel);
    },

    onThinking(token) {
      // Ignore if this is not the current request
      if (!isCurrentStreamRequest(requestId)) return;
      reasoningBuffer += token;
      updateStreamingBuffers(streaming, contentBuffer, reasoningBuffer, isThinkingModel);
    },

    onDone() {
      finalizeStreamingResult({
        conv: requestConv,
        streaming,
        contentBuffer,
        reasoningBuffer,
        textarea,
        wasStopped: false,
        syncUi: isCurrentStreamRequest(requestId) && state.activeConversationId === requestConv.id,
        requestId,
        afterMessageId: userMsg.id,
      });
    },

    onAbort() {
      finalizeStreamingResult({
        conv: requestConv,
        streaming,
        contentBuffer,
        reasoningBuffer,
        textarea,
        wasStopped: true,
        syncUi: isCurrentStreamRequest(requestId) && state.activeConversationId === requestConv.id,
        requestId,
        afterMessageId: userMsg.id,
      });
    },

    onError(err) {
      commitStreamingError({
        conv: requestConv,
        streaming,
        err,
        textarea,
        syncUi: isCurrentStreamRequest(requestId) && state.activeConversationId === requestConv.id,
        requestId,
        afterMessageId: userMsg.id,
      });
    },
  });
}

/**
 * Regenerate the last AI response.
 */
export async function regenerateLastResponse() {
  const conv = state.activeConversation;
  if (!conv || state.isStreaming) return;

  // Remove the last AI/error message
  const nextMessages = [...conv.messages];
  while (nextMessages.length > 0) {
    const last = nextMessages[nextMessages.length - 1];
    if (last.role === 'ai' || last.role === 'error') {
      nextMessages.pop();
    } else {
      break;
    }
  }

  // Find the last user message
  const lastUserMsg = [...nextMessages].reverse().find((m) => m.role === 'user');
  if (!lastUserMsg) return;

  const requestConv = {
    ...conv,
    messages: nextMessages,
    updatedAt: Date.now(),
  };

  if (!saveConversation(requestConv)) {
    showToast('重新生成失败：本地存储写入失败', 'error');
    return;
  }
  renderMessages();

  // Re-send with current context
  const requestId = generateId();
  state.currentRequestId = requestId;
  state.isStreaming = true;
  showStopButton(true);
  updateSendButton(false);

  const apiMessages = buildAPIMessages(requestConv);
  const streaming = createStreamingMessage();
  let contentBuffer = '';
  let reasoningBuffer = '';
  const isThinkingModel = state.selectedModel.type === 'thinking';
  const textarea = document.querySelector('#chat-input');

  await streamChatCompletion(apiMessages, {
    onToken(token) {
      if (!isCurrentStreamRequest(requestId)) return;
      contentBuffer += token;
      updateStreamingBuffers(streaming, contentBuffer, reasoningBuffer, isThinkingModel);
    },

    onThinking(token) {
      if (!isCurrentStreamRequest(requestId)) return;
      reasoningBuffer += token;
      updateStreamingBuffers(streaming, contentBuffer, reasoningBuffer, isThinkingModel);
    },

    onDone() {
      finalizeStreamingResult({
        conv: requestConv,
        streaming,
        contentBuffer,
        reasoningBuffer,
        textarea,
        wasStopped: false,
        syncUi: isCurrentStreamRequest(requestId) && state.activeConversationId === requestConv.id,
        requestId,
        afterMessageId: lastUserMsg.id,
      });
    },

    onAbort() {
      finalizeStreamingResult({
        conv: requestConv,
        streaming,
        contentBuffer,
        reasoningBuffer,
        textarea,
        wasStopped: true,
        syncUi: isCurrentStreamRequest(requestId) && state.activeConversationId === requestConv.id,
        requestId,
        afterMessageId: lastUserMsg.id,
      });
    },

    onError(err) {
      commitStreamingError({
        conv: requestConv,
        streaming,
        err,
        textarea,
        syncUi: isCurrentStreamRequest(requestId) && state.activeConversationId === requestConv.id,
        requestId,
        afterMessageId: lastUserMsg.id,
      });
    },
  });
}

/**
 * Build the API messages array from a conversation.
 * @param {Object} conv
 * @returns {Array<{role: string, content: string|Array}>}
 */
function buildAPIMessages(conv) {
  const messages = [];

  // System prompt
  const sysPrompt = conv.systemPrompt || state.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  messages.push({ role: 'system', content: sysPrompt });

  // Chat history (only user and ai messages)
  for (const msg of conv.messages) {
    if (msg.role === 'user') {
      if (msg.images && msg.images.length > 0) {
        // Multimodal message: text + images
        const parts = [{ type: 'text', text: msg.content }];
        for (const dataUrl of msg.images) {
          parts.push({ type: 'image_url', image_url: { url: dataUrl } });
        }
        messages.push({ role: 'user', content: parts });
      } else {
        messages.push({ role: 'user', content: msg.content });
      }
    } else if (msg.role === 'ai') {
      messages.push({ role: 'assistant', content: msg.content });
    }
    // Skip error messages
  }

  return messages;
}

/**
 * Update the streaming bubble with the latest buffers.
 */
function updateStreamingBuffers(streaming, contentBuffer, reasoningBuffer, isThinkingModel) {
  const partial = buildAssistantMessageFromBuffers({
    contentBuffer,
    reasoningBuffer,
    wasStopped: false,
  });

  if (isThinkingModel && partial.thinking) {
    streaming.updateThinking(partial.thinking);
  }

  if (partial.content) {
    streaming.updateContent(partial.content);
  } else if (!isThinkingModel && contentBuffer) {
    streaming.updateContent(contentBuffer);
  }
}

function isCurrentStreamRequest(requestId) {
  return state.currentRequestId === requestId;
}

function clearCurrentStreamRequest(requestId) {
  if (requestId && isCurrentStreamRequest(requestId)) {
    state.currentRequestId = null;
  }
}

function appendMessageAfterAnchor(conversationId, message, afterMessageId) {
  const currentConv = state.conversations.find((c) => c.id === conversationId);
  if (!currentConv) return false;

  const messages = [...currentConv.messages];
  const anchorIndex = afterMessageId
    ? messages.findIndex((m) => m.id === afterMessageId)
    : messages.length - 1;

  if (anchorIndex < 0) return false;

  messages.splice(anchorIndex + 1, 0, message);
  return saveConversation({
    ...currentConv,
    messages,
    updatedAt: Date.now(),
  });
}

/**
 * Finalize a streaming response into a persisted AI message when appropriate.
 */
function finalizeStreamingResult(options) {
  const {
    conv,
    streaming,
    contentBuffer,
    reasoningBuffer,
    textarea,
    wasStopped,
    syncUi = true,
    requestId = null,
    afterMessageId = null,
  } = options;

  // Stale callbacks still need to clean up their own UI/message, but they must
  // not override the controls for a newer active request.
  if (syncUi) {
    state.isStreaming = false;
    showStopButton(false);
    updateSendButton(true);
  }
  clearCurrentStreamRequest(requestId);
  streaming.finalize();

  const finalMessage = buildAssistantMessageFromBuffers({
    contentBuffer,
    reasoningBuffer,
    wasStopped,
  });

  if (!finalMessage.hasVisibleOutput) {
    streaming.element.remove();
    if (syncUi) {
      textarea?.focus();
    }
    return;
  }

  const aiMsg = {
    id: generateId(),
    role: 'ai',
    content: finalMessage.content,
    thinking: finalMessage.thinking,
    timestamp: Date.now(),
  };

  const saved = appendMessageAfterAnchor(conv.id, aiMsg, afterMessageId);
  if (!saved) {
    if (streaming.element.isConnected) {
      streaming.element.remove();
    }
    if (syncUi) {
      showToast('回复保存失败，请清理本地存储后重试', 'error');
      textarea?.focus();
    }
    return;
  }

  if (streaming.element.isConnected) {
    replaceStreamingMessage(streaming.element, aiMsg);
  }

  renderConversationList();
  if (syncUi) {
    scrollToBottom();
    textarea?.focus();
  }
}

function commitStreamingError(options) {
  const {
    conv,
    streaming,
    err,
    textarea,
    syncUi = true,
    requestId = null,
    afterMessageId = null,
  } = options;

  if (syncUi) {
    state.isStreaming = false;
    showStopButton(false);
    updateSendButton(true);
  }
  clearCurrentStreamRequest(requestId);

  const errorMsg = {
    id: generateId(),
    role: 'error',
    content: err.message ?? '发生未知错误',
    timestamp: Date.now(),
  };

  const saved = appendMessageAfterAnchor(conv.id, errorMsg, afterMessageId);
  if (!saved) {
    if (streaming.element.isConnected) {
      streaming.element.remove();
    }
    if (syncUi) {
      showToast('错误消息保存失败，请清理本地存储后重试', 'error');
      textarea?.focus();
    }
    return;
  }

  if (streaming.element.isConnected) {
    replaceStreamingMessage(streaming.element, errorMsg);
  } else if (syncUi && state.activeConversationId === conv.id) {
    renderMessages();
  }

  renderConversationList();

  if (syncUi) {
    scrollToBottom();
    showToast(errorMsg.content, 'error');
    textarea?.focus();
  }
}

/**
 * Export the current conversation as a Markdown file.
 */
export function exportConversation() {
  const conv = state.activeConversation;
  if (!conv) {
    showToast('没有可导出的对话', 'warning');
    return;
  }

  // Use conversation's own model, not the currently selected one
  const model = state.models.find((m) => m.id === conv.modelId) ?? {
    id: conv.modelId,
    name: conv.modelId || '未知模型',
  };
  let md = `# ${conv.title}\n\n`;
  md += `- **模型**: ${model.name}\n`;
  md += `- **创建时间**: ${new Date(conv.createdAt).toLocaleString('zh-CN')}\n`;
  md += `- **消息数**: ${conv.messages.length}\n\n---\n\n`;

  for (const msg of conv.messages) {
    const time = new Date(msg.timestamp).toLocaleString('zh-CN');
    if (msg.role === 'user') {
      md += `## 👤 用户 (${time})\n\n${msg.content}\n\n`;
    } else if (msg.role === 'ai') {
      md += `## 🤖 AI (${time})\n\n`;
      if (msg.thinking) {
        md += `<details>\n<summary>💭 思考过程</summary>\n\n${msg.thinking}\n\n</details>\n\n`;
      }
      md += `${msg.content}\n\n`;
    } else if (msg.role === 'error') {
      md += `## ⚠️ 错误 (${time})\n\n${msg.content}\n\n`;
    }
    md += '---\n\n';
  }

  // Download file
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${conv.title.replace(/[^\w\u4e00-\u9fa5]/g, '_')}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast('导出成功', 'success');
}

/**
 * Handle message action button clicks (copy, regenerate).
 * @param {Event} e
 */
export function handleMessageAction(e) {
  const btn = e.target.closest('.message__action-btn');
  if (!btn) return;

  const action = btn.dataset.action;

  if (action === 'copy') {
    const content = btn.dataset.content;
    if (content) {
      copyToClipboard(content).then((ok) => {
        if (ok) showToast('已复制到剪贴板', 'success');
      });
    }
  } else if (action === 'regenerate') {
    regenerateLastResponse();
  }
}

/**
 * Handle thinking block toggle clicks.
 * @param {Event} e
 */
export function handleThinkingToggle(e) {
  const toggleBtn = e.target.closest('.thinking-block__toggle');
  if (!toggleBtn) return;

  const block = toggleBtn.closest('.thinking-block');
  if (!block) return;

  const isExpanded = block.classList.contains('expanded');
  block.classList.toggle('expanded');

  const label = toggleBtn.querySelector('span:last-child');
  if (label) {
    label.textContent = isExpanded ? '💭 查看思考过程' : '💭 收起思考过程';
  }
  toggleBtn.setAttribute('aria-expanded', !isExpanded);
}
