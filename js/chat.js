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
import { saveConversation, saveConversations, saveActiveConversationId } from './storage.js';
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

  state.addConversation(conv);
  state.activeConversationId = conv.id;
  saveConversation(conv);
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
  }

  renderMessages();
  renderConversationList();
  updateSystemPromptIndicator();
}

/**
 * Delete a conversation by ID.
 * @param {string} conversationId
 */
export function deleteConversation(conversationId) {
  state.removeConversation(conversationId);
  saveConversations();
  saveActiveConversationId();
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

  conv.title = deriveConversationTitle(trimmed, [], { maxLength: TITLE_MAX_LENGTH });
  conv.updatedAt = Date.now();
  saveConversation(conv);
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

  // Update model if changed
  conv.modelId = state.selectedModelId;

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

  conv.messages.push(userMsg);

  // Auto-title from first message
  if (conv.messages.filter((m) => m.role === 'user').length === 1) {
    conv.title = deriveConversationTitle(trimmed, attachments, { maxLength: TITLE_MAX_LENGTH });
  }

  conv.updatedAt = Date.now();
  saveConversation(conv);

  // Display user message
  appendUserMessage(userMsg);
  renderConversationList();
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
  const apiMessages = buildAPIMessages(conv);

  // Create streaming UI
  const streaming = createStreamingMessage();
  let contentBuffer = '';
  let reasoningBuffer = '';
  const isThinkingModel = state.selectedModel.type === 'thinking';

  await streamChatCompletion(apiMessages, {
    onToken(token) {
      contentBuffer += token;
      updateStreamingBuffers(streaming, contentBuffer, reasoningBuffer, isThinkingModel);
    },

    onThinking(token) {
      reasoningBuffer += token;
      updateStreamingBuffers(streaming, contentBuffer, reasoningBuffer, isThinkingModel);
    },

    onDone() {
      finalizeStreamingResult({
        conv,
        streaming,
        contentBuffer,
        reasoningBuffer,
        textarea,
        wasStopped: false,
      });
    },

    onAbort() {
      finalizeStreamingResult({
        conv,
        streaming,
        contentBuffer,
        reasoningBuffer,
        textarea,
        wasStopped: true,
      });
    },

    onError(err) {
      state.isStreaming = false;
      showStopButton(false);
      updateSendButton(true);
      streaming.element.remove();

      const errorMsg = {
        id: generateId(),
        role: 'error',
        content: err.message ?? '发生未知错误',
        timestamp: Date.now(),
      };

      conv.messages.push(errorMsg);
      conv.updatedAt = Date.now();
      saveConversation(conv);
      renderMessages();
      renderConversationList();
      showToast(err.message, 'error');
      textarea?.focus();
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
  while (conv.messages.length > 0) {
    const last = conv.messages[conv.messages.length - 1];
    if (last.role === 'ai' || last.role === 'error') {
      conv.messages.pop();
    } else {
      break;
    }
  }

  // Find the last user message
  const lastUserMsg = [...conv.messages].reverse().find((m) => m.role === 'user');
  if (!lastUserMsg) return;

  conv.updatedAt = Date.now();
  saveConversation(conv);
  renderMessages();

  // Re-send with current context
  state.isStreaming = true;
  showStopButton(true);
  updateSendButton(false);

  const apiMessages = buildAPIMessages(conv);
  const streaming = createStreamingMessage();
  let contentBuffer = '';
  let reasoningBuffer = '';
  const isThinkingModel = state.selectedModel.type === 'thinking';

  await streamChatCompletion(apiMessages, {
    onToken(token) {
      contentBuffer += token;
      updateStreamingBuffers(streaming, contentBuffer, reasoningBuffer, isThinkingModel);
    },

    onThinking(token) {
      reasoningBuffer += token;
      updateStreamingBuffers(streaming, contentBuffer, reasoningBuffer, isThinkingModel);
    },

    onDone() {
      finalizeStreamingResult({
        conv,
        streaming,
        contentBuffer,
        reasoningBuffer,
        wasStopped: false,
      });
    },

    onAbort() {
      finalizeStreamingResult({
        conv,
        streaming,
        contentBuffer,
        reasoningBuffer,
        wasStopped: true,
      });
    },

    onError(err) {
      state.isStreaming = false;
      showStopButton(false);
      updateSendButton(true);
      streaming.element.remove();

      const errorMsg = {
        id: generateId(),
        role: 'error',
        content: err.message ?? '发生未知错误',
        timestamp: Date.now(),
      };

      conv.messages.push(errorMsg);
      conv.updatedAt = Date.now();
      saveConversation(conv);
      renderMessages();
      renderConversationList();
      showToast(err.message, 'error');
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
  } = options;

  state.isStreaming = false;
  showStopButton(false);
  updateSendButton(true);
  streaming.finalize();

  const finalMessage = buildAssistantMessageFromBuffers({
    contentBuffer,
    reasoningBuffer,
    wasStopped,
  });

  if (!finalMessage.hasVisibleOutput) {
    streaming.element.remove();
    textarea?.focus();
    return;
  }

  const aiMsg = {
    id: generateId(),
    role: 'ai',
    content: finalMessage.content,
    thinking: finalMessage.thinking,
    timestamp: Date.now(),
  };

  conv.messages.push(aiMsg);
  conv.updatedAt = Date.now();
  saveConversation(conv);

  if (streaming.element.isConnected) {
    replaceStreamingMessage(streaming.element, aiMsg);
  }

  renderConversationList();
  scrollToBottom();
  textarea?.focus();
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
