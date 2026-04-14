/**
 * Pure conversation helpers shared by chat, storage, and tests.
 */

function truncateText(text, maxLength) {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '…';
}

export function sortConversationsByUpdatedAt(conversations) {
  return [...conversations].sort(
    (a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0)
  );
}

export function deriveConversationTitle(text, attachments = [], options = {}) {
  const {
    fallbackTitle = '新对话',
    maxLength = 20,
  } = options;

  const trimmed = text.trim();
  if (trimmed) {
    return truncateText(trimmed, maxLength);
  }

  if (attachments.length === 1 && attachments[0]?.name) {
    return truncateText(`📎 ${attachments[0].name}`, maxLength);
  }

  if (attachments.length > 1) {
    return truncateText(`📎 ${attachments.length} 个附件`, maxLength);
  }

  return fallbackTitle;
}

export function parseThinkingContent(text) {
  let thinking = '';
  let content = text;

  const thinkOpenIdx = text.indexOf('<think>');
  if (thinkOpenIdx !== -1) {
    const thinkCloseIdx = text.indexOf('</think>');
    if (thinkCloseIdx !== -1) {
      thinking = text.substring(thinkOpenIdx + 7, thinkCloseIdx).trim();
      content = (text.substring(0, thinkOpenIdx) + text.substring(thinkCloseIdx + 8)).trim();
    } else {
      thinking = text.substring(thinkOpenIdx + 7).trim();
      content = text.substring(0, thinkOpenIdx).trim();
    }
  }

  return { thinking, content };
}

export function buildAssistantMessageFromBuffers(options) {
  const {
    contentBuffer = '',
    reasoningBuffer = '',
    wasStopped = false,
  } = options;

  const hasThinkTags = contentBuffer.includes('<think>');
  const parsed = hasThinkTags
    ? parseThinkingContent(contentBuffer)
    : { content: contentBuffer, thinking: reasoningBuffer };

  let content = parsed.content ?? '';
  const thinking = parsed.thinking?.trim() ? parsed.thinking : '';

  if (!content.trim() && thinking) {
    content = wasStopped
      ? '*(已停止生成，未返回最终答案)*'
      : '*(模型仅返回了思考过程)*';
  }

  return {
    content,
    thinking: thinking || undefined,
    hasVisibleOutput: Boolean(content.trim() || thinking),
  };
}

export function resolveConversationModel(models, conversationModelId, fallbackModel) {
  return models.find((model) => model.id === conversationModelId) ?? fallbackModel;
}
