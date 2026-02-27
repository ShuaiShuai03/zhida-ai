/**
 * API communication — SSE streaming, error handling.
 */

import { API_ENDPOINT, REQUEST_TIMEOUT } from './config.js';
import { state } from './state.js';

/**
 * @typedef {Object} StreamCallbacks
 * @property {function(string): void} onToken - Called for each content token
 * @property {function(string): void} [onThinking] - Called for reasoning_content tokens
 * @property {function(): void} onDone - Called when stream completes
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

  const timeoutId = setTimeout(() => {
    controller.abort();
    callbacks.onError(new ChatError('请求超时，请重试', 'timeout'));
  }, REQUEST_TIMEOUT);

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

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw classifyHTTPError(response.status, errorBody);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new ChatError('响应格式异常', 'parse');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process SSE lines
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;

        if (trimmed === 'data: [DONE]') {
          callbacks.onDone();
          state.abortController = null;
          return;
        }

        if (trimmed.startsWith('data: ')) {
          const jsonStr = trimmed.slice(6);
          try {
            const parsed = JSON.parse(jsonStr);
            const delta = parsed.choices?.[0]?.delta;
            if (!delta) continue;

            // Handle reasoning_content (OpenAI-compatible thinking)
            if (delta.reasoning_content && model.type === 'thinking') {
              callbacks.onThinking?.(delta.reasoning_content);
            }

            // Handle regular content
            if (delta.content) {
              callbacks.onToken(delta.content);
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
    }

    // Stream ended without [DONE]
    callbacks.onDone();
    state.abortController = null;
  } catch (err) {
    clearTimeout(timeoutId);
    state.abortController = null;

    if (err instanceof ChatError) {
      callbacks.onError(err);
    } else if (err.name === 'AbortError') {
      // User-cancelled, do nothing
      callbacks.onDone();
    } else if (!navigator.onLine) {
      callbacks.onError(new ChatError('网络连接失败，请检查网络后重试', 'network'));
    } else {
      callbacks.onError(new ChatError('网络连接失败，请检查网络后重试', 'network'));
    }
  }
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
