/**
 * API communication — SSE streaming, error handling.
 */

import { API_ENDPOINT, REQUEST_TIMEOUT } from './config.js';
import { state } from './state.js';

// Stream safety limits
const MAX_STREAM_ITERATIONS = 10000;
const MAX_STREAM_DATA_SIZE = 50 * 1024 * 1024; // 50MB

/**
 * @typedef {Object} StreamCallbacks
 * @property {function(string): void} onToken - Called for each content token
 * @property {function(string): void} [onThinking] - Called for reasoning_content tokens
 * @property {function(): void} onDone - Called when stream completes successfully
 * @property {function(): void} [onAbort] - Called when stream is cancelled by the user
 * @property {function(Error): void} onError - Called on error
 */

/**
 * Send a chat completion request with streaming.
 * @param {Array<{role: string, content: string}>} messages - Chat history
 * @param {StreamCallbacks} callbacks
 */
export async function streamChatCompletion(messages, callbacks) {
  const controller = new AbortController();
  state.abortController = controller;

  let timeoutId = null;
  const resetTimeout = () => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      controller.abort(new Error('timeout'));
    }, REQUEST_TIMEOUT);
  };
  const clearRequestTimeout = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };
  const clearAbortController = () => {
    if (state.abortController === controller) {
      state.abortController = null;
    }
  };

  resetTimeout();

  let streamFinished = false;
  let sawSseData = false;
  let emittedContent = false;

  const processSSELine = (line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) return;

    if (trimmed === 'data: [DONE]') {
      streamFinished = true;
      callbacks.onDone();
      clearAbortController();
      return;
    }

    if (trimmed.startsWith('data: ')) {
      sawSseData = true;
      const jsonStr = trimmed.slice(6);
      try {
        const parsed = JSON.parse(jsonStr);
        emittedContent = emitChatPayload(parsed, callbacks, model) || emittedContent;
      } catch {
        // Skip malformed JSON lines
      }
    }
  };

  const model = state.selectedModel;

  const body = {
    model: state.selectedModelId,
    messages,
    stream: true,
    temperature: state.temperature,
  };

  // Qwen thinking models require enable_thinking
  if (model.type === 'thinking') {
    body.enable_thinking = true;
  }

  if (state.maxTokens > 0) {
    body.max_tokens = state.maxTokens;
  }

  try {
    if (!state.isApiConfigured) {
      throw new ChatError('请先在设置中配置 API 地址和密钥', 'auth');
    }

    const fullUrl = `${state.apiBaseUrl}${API_ENDPOINT}`;

    const response = await fetch(fullUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    resetTimeout();

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw classifyHTTPError(response.status, errorBody);
    }

    const contentType = response.headers.get('Content-Type') ?? '';
    if (contentType.toLowerCase().includes('application/json')) {
      const parsed = await response.json();
      if (!emitChatPayload(parsed, callbacks, model)) {
        throw new ChatError('响应格式异常，未收到有效内容', 'parse');
      }
      callbacks.onDone();
      clearAbortController();
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new ChatError('响应格式异常', 'parse');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let rawText = '';
    let iterations = 0;
    let totalBytes = 0;

    try {
      while (true) {
        // Safety check: prevent infinite loops
        if (++iterations > MAX_STREAM_ITERATIONS) {
          throw new ChatError('响应数据过多，已中止', 'overflow');
        }

        const { done, value } = await reader.read();
        if (done) break;
        resetTimeout();

        // Safety check: prevent excessive data
        totalBytes += value.length;
        if (totalBytes > MAX_STREAM_DATA_SIZE) {
          throw new ChatError('响应数据超出限制', 'overflow');
        }

        const chunk = decoder.decode(value, { stream: true });
        rawText += chunk;
        buffer += chunk;

        // Process SSE lines
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          processSSELine(line);
          if (streamFinished) return;
        }
      }

      buffer += decoder.decode();
      if (buffer.trim()) {
        processSSELine(buffer);
        if (streamFinished) return;
      }

      if (!sawSseData) {
        try {
          const parsed = JSON.parse(rawText);
          if (!emitChatPayload(parsed, callbacks, model)) {
            throw new ChatError('响应格式异常，未收到有效内容', 'parse');
          }
          emittedContent = true;
        } catch (err) {
          if (err instanceof ChatError) throw err;
          throw new ChatError('响应格式异常，未收到有效的流式数据', 'parse');
        }
      } else if (!emittedContent) {
        throw new ChatError('响应格式异常，未收到有效内容', 'parse');
      }

      // Stream ended without [DONE]
      callbacks.onDone();
      clearAbortController();
    } finally {
      reader.releaseLock();
    }
  } catch (err) {
    clearRequestTimeout();
    clearAbortController();

    if (err instanceof ChatError) {
      callbacks.onError(err);
    } else if (controller.signal.aborted && controller.signal.reason?.message === 'timeout') {
      callbacks.onError(new ChatError('请求超时，请重试', 'timeout'));
    } else if (err.name === 'AbortError' || controller.signal.aborted) {
      // User manually stopped the stream
      callbacks.onAbort?.();
    } else if (!navigator.onLine) {
      callbacks.onError(new ChatError('网络连接失败，请检查网络后重试', 'network'));
    } else {
      callbacks.onError(new ChatError('网络连接失败，请检查网络后重试', 'network'));
    }
  } finally {
    clearRequestTimeout();
  }
}

function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text' && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  return '';
}

function emitChatPayload(payload, callbacks, model) {
  const choice = payload.choices?.[0];
  const delta = choice?.delta;
  const message = choice?.message;
  let emitted = false;

  const reasoning = normalizeContent(delta?.reasoning_content ?? message?.reasoning_content);
  if (reasoning && model.type === 'thinking') {
    callbacks.onThinking?.(reasoning);
    emitted = true;
  }

  const content = normalizeContent(delta?.content ?? message?.content);
  if (content) {
    callbacks.onToken(content);
    emitted = true;
  }

  return emitted;
}

// ---- Model Fetching ----

/** Patterns for non-chat models to exclude from the list */
const EXCLUDE_MODEL_RE = /embed|tts|whisper|dall-e|moderation|davinci-|babbage-|ada-\d|text-(?!.*chat)/i;

/**
 * Fetch available models from the API provider's /v1/models endpoint.
 * @param {{ apiBaseUrl?: string, apiKey?: string }} [options]
 * @returns {Promise<Array>} Normalised model definitions
 */
export async function fetchAvailableModels(options = {}) {
  const apiBaseUrl = options.apiBaseUrl ?? state.apiBaseUrl;
  const apiKey = options.apiKey ?? state.apiKey;

  if (!apiBaseUrl || !apiKey) return [];

  const response = await fetch(`${apiBaseUrl}/v1/models`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    throw new ChatError(`获取模型列表失败 (${response.status})`, 'server');
  }

  const json = await response.json();
  return (json.data || [])
    .filter((m) => !EXCLUDE_MODEL_RE.test(m.id))
    .map(normalizeModel)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Convert a raw API model object into the app's model definition format.
 */
function normalizeModel(apiModel) {
  const id = apiModel.id;
  const name = formatModelName(id);
  const { badge, badgeClass, type } = classifyModel(id);
  const owner = apiModel.owned_by || '';
  const description = owner ? `${owner} — ${id}` : id;
  return { id, name, badge, badgeClass, type, description };
}

/** Known tokens that should be uppercased. */
const UPPER_TOKENS = new Set(['gpt', 'vl', 'ai', 'xl', 'rl', 'glm', 'yi', 'llm', 'api']);

/**
 * Format a model ID string into a human-friendly display name.
 * e.g. "gpt-4o-mini" → "GPT 4o Mini"
 */
function formatModelName(id) {
  return id
    .split(/[-_/]/)
    .map((part) => UPPER_TOKENS.has(part.toLowerCase())
      ? part.toUpperCase()
      : part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Classify a model ID into badge / type metadata.
 */
function classifyModel(id) {
  const lower = id.toLowerCase();

  if (/thinking|reasoner|reason|^o[13]-|deep-think/.test(lower)) {
    return { badge: '🧠 深度思考', badgeClass: 'badge--thinking', type: 'thinking' };
  }
  if (/vl|vision|multimodal/.test(lower)) {
    return { badge: '👁 多模态', badgeClass: 'badge--premium', type: 'standard' };
  }
  if (/gpt-4|max|pro|opus|large|flagship/.test(lower)) {
    return { badge: '🌟 旗舰', badgeClass: 'badge--premium', type: 'standard' };
  }
  if (/mini|lite|small|nano|flash|turbo|instant/.test(lower)) {
    return { badge: '⚡ 轻量', badgeClass: 'badge--fast', type: 'standard' };
  }
  if (/plus|sonnet|medium/.test(lower)) {
    return { badge: '⚡ 高效', badgeClass: 'badge--standard', type: 'standard' };
  }
  return { badge: '🤖 标准', badgeClass: 'badge--standard', type: 'standard' };
}

/**
 * Custom error class for chat API errors.
 */
export class ChatError extends Error {
  /**
   * @param {string} message - User-friendly message in Chinese
   * @param {string} type - Error type: 'network'|'auth'|'rate_limit'|'server'|'timeout'|'parse'
   */
  constructor(message, type = 'unknown') {
    super(message);
    this.name = 'ChatError';
    this.type = type;
  }
}

/**
 * Classify an HTTP error status into a user-friendly ChatError.
 * @param {number} status
 * @param {string} body
 * @returns {ChatError}
 */
function classifyHTTPError(status, body) {
  // Extract actual error message from API response
  let apiMessage = '';
  try {
    const parsed = JSON.parse(body);
    apiMessage = parsed.error?.message || parsed.message || '';
  } catch {
    if (body && body.length < 200) {
      apiMessage = body;
    }
  }

  if (status === 401 || status === 403) {
    return new ChatError(apiMessage || 'API 认证失败，请检查配置', 'auth');
  }
  if (status === 429) {
    return new ChatError(apiMessage || '请求过于频繁，请稍后再试', 'rate_limit');
  }
  if (status === 400) {
    return new ChatError(apiMessage || '请求参数错误', 'bad_request');
  }
  if (status >= 500) {
    return new ChatError(apiMessage || '服务器错误，请稍后重试', 'server');
  }
  if (status === 408) {
    return new ChatError(apiMessage || '请求超时，请重试', 'timeout');
  }
  return new ChatError(apiMessage || `请求失败 (${status})`, 'server');
}
