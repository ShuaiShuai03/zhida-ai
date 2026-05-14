/**
 * Pure conversation helpers shared by chat, storage, and tests.
 */

function truncateText(text, maxLength) {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '…';
}

export function sortConversationsByUpdatedAt(conversations) {
  return [...conversations].sort(
    (a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) {
        return a.pinned ? -1 : 1;
      }
      return (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0);
    }
  );
}

export function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const normalized = [];

  for (const tag of tags) {
    const value = String(tag ?? '').trim().replace(/^#/, '');
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}

export function parseTagsInput(value) {
  return normalizeTags(String(value ?? '').split(/[\s,，;；]+/));
}

export function filterConversations(conversations, query, models = []) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return conversations;

  const tagFilter = q.startsWith('#') ? q.slice(1).trim() : '';
  const modelNames = new Map(models.map((model) => [model.id, model.name ?? model.id]));

  return conversations.filter((conversation) => {
    const tags = normalizeTags(conversation.tags);
    if (tagFilter) {
      return tags.some((tag) => tag.toLowerCase() === tagFilter);
    }

    const modelName = modelNames.get(conversation.modelId) ?? conversation.modelId ?? '';
    const haystack = [
      conversation.title,
      modelName,
      conversation.modelId,
      ...tags,
      ...(conversation.messages ?? []).map((message) => message.content ?? ''),
    ].join('\n').toLowerCase();

    return haystack.includes(q);
  });
}

export function pruneConversationsToLimit(conversations, limit) {
  const keepLimit = Math.max(0, Number.parseInt(limit, 10) || 0);
  const sorted = sortConversationsByUpdatedAt(conversations);
  if (sorted.length <= keepLimit) {
    return { kept: sorted, removed: [] };
  }

  const pinned = sorted.filter((conversation) => conversation.pinned);
  const regular = sorted.filter((conversation) => !conversation.pinned);
  const regularSlots = Math.max(0, keepLimit - pinned.length);
  const keptRegular = regular.slice(0, regularSlots);
  const removed = regular.slice(regularSlots);

  return {
    kept: sortConversationsByUpdatedAt([...pinned, ...keptRegular]),
    removed,
  };
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

export function resolveConversationModel(models, conversationModelId) {
  return models.find((model) => model.id === conversationModelId) ?? null;
}
