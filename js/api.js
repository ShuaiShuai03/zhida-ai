/**
 * API communication — SSE streaming, error handling.
 */

import { DEFAULT_REASONING_EFFORT, REQUEST_TIMEOUT } from './config.js';
import { state } from './state.js';

export const BACKEND_UNAVAILABLE_MESSAGE = '当前是纯静态服务器，缺少 Node 后端代理，不能保存 API key、获取模型或聊天。请用 ZHIDA_CONFIG_SECRET="..." node server/server.js 或 bash scripts/start.sh 启动。';

// Stream safety limits
const MAX_STREAM_ITERATIONS = 10000;
const MAX_STREAM_DATA_SIZE = 50 * 1024 * 1024; // 50MB

function isJsonResponse(response) {
  return (response.headers.get('Content-Type') ?? '').toLowerCase().includes('application/json');
}

function createBackendUnavailableError() {
  const error = new ChatError(BACKEND_UNAVAILABLE_MESSAGE, 'backend_unavailable');
  error.backendUnavailable = true;
  return error;
}

function isLikelyStaticServerResponse(response, body) {
  const contentType = (response.headers?.get('Content-Type') ?? '').toLowerCase();
  if (response.status === 404 || response.status === 405 || response.status === 501) {
    if (!contentType.includes('application/json')) return true;
    if (/not found|unsupported method|method not allowed/i.test(body || '')) return true;
  }
  return response.ok && contentType && !contentType.includes('application/json');
}

async function parseApiError(response, fallbackMessage) {
  const body = await response.text().catch(() => '');
  if (isLikelyStaticServerResponse(response, body)) {
    throw createBackendUnavailableError();
  }

  let apiMessage = '';
  if (isJsonResponse(response)) {
    try {
      const parsed = JSON.parse(body || '{}');
      apiMessage = parsed.error?.message || parsed.message || '';
    } catch {
      apiMessage = '';
    }
  } else if (body && body.length < 500) {
    apiMessage = body.trim();
  }

  return apiMessage || fallbackMessage;
}

/**
 * @typedef {Object} StreamCallbacks
 * @property {function(string): void} onToken - Called for each content token
 * @property {function(string): void} [onThinking] - Called for reasoning_content tokens
 * @property {function(): void} onDone - Called when stream completes successfully
 * @property {function(): void} [onAbort] - Called when stream is cancelled by the user
 * @property {function(Error): void} onError - Called on error
 * @property {function(string): void} [onStatus] - Called for transient tool/search status
 * @property {function(Array<{url: string, title?: string}>): void} [onCitations] - Called when citations are received
 */

export function shouldUseResponsesRoute({ model, webSearchEnabled, reasoningEffort } = {}) {
  return getRequestRouteDecision({ model, webSearchEnabled, reasoningEffort }).route === 'responses';
}

export function getRequestRouteDecision({ model, webSearchEnabled, reasoningEffort } = {}) {
  if (!model || model.unavailable) {
    return {
      route: 'blocked',
      reason: '当前会话使用的模型不可用。请重新选择一个可用模型后重试。',
      requestOptions: {},
    };
  }

  if (webSearchEnabled && !model.supportsWebSearch) {
    return {
      route: 'blocked',
      reason: model.capabilityReason || '当前模型不支持 Responses API，无法使用网络搜索。请切换支持网络搜索的模型后重试。',
      requestOptions: {},
    };
  }

  const includeReasoning = Boolean(reasoningEffort && model.supportsReasoningEffort);
  if (webSearchEnabled || includeReasoning) {
    return {
      route: 'responses',
      reason: webSearchEnabled ? 'web_search' : 'reasoning_effort',
      requestOptions: {
        includeWebSearch: Boolean(webSearchEnabled && model.supportsWebSearch),
        includeReasoning,
      },
    };
  }

  return {
    route: 'chat',
    reason: 'chat_completions',
    requestOptions: {},
  };
}

export async function streamModelResponse(messages, callbacks) {
  const decision = getRequestRouteDecision({
    model: state.selectedModel,
    webSearchEnabled: state.webSearchEnabled,
    reasoningEffort: state.reasoningEffort || DEFAULT_REASONING_EFFORT,
    apiBaseUrl: state.apiBaseUrl,
  });

  if (decision.route === 'blocked') {
    callbacks.onError(new ChatError(decision.reason, 'capability'));
    return;
  }

  if (decision.route === 'responses') {
    return streamResponsesAPI(messages, callbacks, decision.requestOptions);
  }
  return streamChatCompletion(messages, callbacks);
}

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

    const response = await fetch('/api/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    resetTimeout();

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw classifyHTTPError(response.status, errorBody, response.headers.get('Content-Type') ?? '');
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

export async function streamResponsesAPI(messages, callbacks, requestOptions = {}) {
  const controller = new AbortController();
  state.abortController = controller;

  let timeoutId = null;
  let responseId = null;
  let streamFinished = false;
  let sawSseData = false;
  let emittedContent = false;
  const citations = [];

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
    if (state.currentResponseId === responseId) {
      state.currentResponseId = null;
    }
  };

  const emitCitations = (next) => {
    const merged = mergeCitations(citations, next);
    citations.length = 0;
    citations.push(...merged);
    if (next.length > 0) callbacks.onCitations?.([...citations]);
  };

  const processEvent = (eventName, payload) => {
    const type = eventName || payload.type || '';
    if (type === 'response.created') {
      responseId = payload.response?.id || payload.id || responseId;
      state.currentResponseId = responseId;
      return;
    }
    if (type === 'done') {
      streamFinished = true;
      callbacks.onDone();
      clearAbortController();
      return;
    }
    if (type === 'response.output_text.delta') {
      const token = typeof payload.delta === 'string' ? payload.delta : '';
      if (token) {
        callbacks.onToken(token);
        emittedContent = true;
      }
      return;
    }
    if (type === 'response.output_item.added' && payload.item?.type === 'web_search_call') {
      callbacks.onStatus?.('正在搜索网络');
      return;
    }
    if (/web_search_call/.test(type)) {
      callbacks.onStatus?.('正在搜索网络');
      return;
    }
    if (type === 'response.output_text.annotation.added') {
      emitCitations(extractUrlCitations(payload.annotation || payload));
      return;
    }
    if (type === 'response.completed') {
      emitCitations(extractUrlCitations(payload.response || payload));
      streamFinished = true;
      callbacks.onDone();
      clearAbortController();
      return;
    }
    if (type === 'response.failed' || type === 'response.incomplete') {
      throw new ChatError('Responses API 返回失败或不完整', 'server');
    }
  };

  resetTimeout();

  const model = state.selectedModel;
  const body = {
    model: state.selectedModelId,
    input: convertMessagesForResponses(messages),
    stream: true,
  };

  if (state.maxTokens > 0) {
    body.max_output_tokens = state.maxTokens;
  }
  if (requestOptions.includeWebSearch) {
    body.tools = [{ type: 'web_search' }];
  }
  if (requestOptions.includeReasoning && model.supportsReasoningEffort) {
    body.reasoning = { effort: state.reasoningEffort || DEFAULT_REASONING_EFFORT };
  }

  try {
    if (!state.isApiConfigured) {
      throw new ChatError('请先在设置中配置 API 地址和密钥', 'auth');
    }

    const response = await fetch('/api/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    resetTimeout();

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw classifyHTTPError(response.status, errorBody, response.headers.get('Content-Type') ?? '');
    }

    const contentType = response.headers.get('Content-Type') ?? '';
    if (contentType.toLowerCase().includes('application/json')) {
      const parsed = await response.json();
      responseId = parsed.id || parsed.response?.id || responseId;
      emitResponseOutput(parsed, callbacks);
      emitCitations(extractUrlCitations(parsed));
      callbacks.onDone();
      clearAbortController();
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) throw new ChatError('响应格式异常', 'parse');

    const decoder = new TextDecoder();
    let buffer = '';
    let rawText = '';
    let iterations = 0;
    let totalBytes = 0;

    try {
      while (true) {
        if (++iterations > MAX_STREAM_ITERATIONS) {
          throw new ChatError('响应数据过多，已中止', 'overflow');
        }
        const { done, value } = await reader.read();
        if (done) break;
        resetTimeout();
        totalBytes += value.length;
        if (totalBytes > MAX_STREAM_DATA_SIZE) {
          throw new ChatError('响应数据超出限制', 'overflow');
        }
        const chunk = decoder.decode(value, { stream: true });
        rawText += chunk;
        buffer += chunk;

        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? '';
        for (const block of blocks) {
          const parsed = parseSseBlock(block);
          if (!parsed) continue;
          sawSseData = true;
          processEvent(parsed.event, parsed.data);
          if (streamFinished) return;
        }
      }

      buffer += decoder.decode();
      if (buffer.trim()) {
        const parsed = parseSseBlock(buffer);
        if (parsed) {
          sawSseData = true;
          processEvent(parsed.event, parsed.data);
          if (streamFinished) return;
        }
      }

      if (!sawSseData) {
        const parsed = JSON.parse(rawText);
        responseId = parsed.id || parsed.response?.id || responseId;
        emittedContent = emitResponseOutput(parsed, callbacks) || emittedContent;
        emitCitations(extractUrlCitations(parsed));
      } else if (!emittedContent) {
        callbacks.onStatus?.('');
      }

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
      if (responseId) cancelResponse(responseId);
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

function convertMessagesForResponses(messages) {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    return {
      role: message.role,
      content: message.content.map((part) => {
        if (part?.type === 'text') return { type: 'input_text', text: part.text || '' };
        if (part?.type === 'image_url') return { type: 'input_image', image_url: part.image_url?.url || '' };
        return part;
      }),
    };
  });
}

function parseSseBlock(block) {
  let event = '';
  const dataLines = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  const rawData = dataLines.join('\n');
  if (rawData === '[DONE]') return { event: 'done', data: {} };
  try {
    return { event, data: JSON.parse(rawData) };
  } catch {
    return null;
  }
}

function emitResponseOutput(payload, callbacks) {
  const text = payload.output_text || extractResponseText(payload);
  if (text) {
    callbacks.onToken(text);
    return true;
  }
  return false;
}

function extractResponseText(value) {
  const output = value?.response?.output || value?.output || [];
  const parts = [];
  for (const item of output) {
    for (const content of item.content || []) {
      if (typeof content.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('');
}

function extractUrlCitations(value) {
  const citations = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'url_citation' && typeof node.url === 'string') {
      citations.push({
        url: node.url,
        title: typeof node.title === 'string' ? node.title : node.url,
      });
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
  return citations;
}

function mergeCitations(current, next) {
  const byUrl = new Map();
  for (const citation of [...current, ...next]) {
    if (!citation?.url || byUrl.has(citation.url)) continue;
    byUrl.set(citation.url, citation);
  }
  return Array.from(byUrl.values());
}

function cancelResponse(responseId) {
  fetch(`/api/responses/${encodeURIComponent(responseId)}/cancel`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
  }).catch(() => {});
}

// ---- Model Fetching ----

/** Patterns for non-chat models to exclude from the list */
const EXCLUDE_MODEL_RE = /embed|tts|whisper|dall-e|moderation|davinci-|babbage-|ada-\d|text-(?!.*chat)/i;

/**
 * Fetch available models through the same-origin backend proxy.
 * @returns {Promise<Array>} Normalised model definitions
 */
export async function fetchAvailableModels() {
  const response = await fetch('/api/models');

  if (!response.ok) {
    const message = await parseApiError(response, `获取模型列表失败 (${response.status})`);
    throw new ChatError(message, response.status === 401 || response.status === 403 ? 'auth' : 'server');
  }

  if (!isJsonResponse(response)) {
    throw createBackendUnavailableError();
  }

  const json = await response.json().catch(() => {
    throw new ChatError('模型列表响应不是合法 JSON', 'parse');
  });
  return normalizeModelsResponse(json);
}

export async function fetchConfigStatus() {
  const response = await fetch('/api/config/status', {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const message = await parseApiError(response, `读取配置状态失败 (${response.status})`);
    throw new ChatError(message, 'server');
  }
  if (!isJsonResponse(response)) {
    throw createBackendUnavailableError();
  }
  return response.json().catch(() => {
    throw createBackendUnavailableError();
  });
}

export async function saveApiConfig({ apiBaseUrl, apiKey }) {
  const response = await fetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ apiBaseUrl, apiKey }),
  });
  if (!response.ok) {
    const message = await parseApiError(response, `保存 API 配置失败 (${response.status})`);
    throw new ChatError(message, 'server');
  }
  if (!isJsonResponse(response)) {
    throw createBackendUnavailableError();
  }
  return response.json().catch(() => {
    throw new ChatError('保存 API 配置响应不是合法 JSON', 'parse');
  });
}

function normalizeModelsResponse(json) {
  return (json.data || [])
    .filter((m) => !EXCLUDE_MODEL_RE.test(m.id))
    .map((model) => normalizeModel(model, { apiBaseUrl: state.apiBaseUrl }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Convert a raw API model object into the app's model definition format.
 */
export function normalizeModel(apiModel, options = {}) {
  const id = apiModel.id;
  const name = formatModelName(id);
  const { badge, badgeClass, type } = classifyModel(id);
  const owner = apiModel.owned_by || '';
  const description = owner ? `${owner} — ${id}` : id;
  const capabilities = deriveModelCapabilities(apiModel, {
    ...options,
    modelType: type,
  });
  return {
    id,
    name,
    badge,
    badgeClass,
    type,
    description,
    ...capabilities,
  };
}

function deriveModelCapabilities(apiModel, options = {}) {
  const callMethods = normalizeStringArray(
    apiModel.call_methods || apiModel.callMethods || apiModel.capabilities?.call_methods
  );
  const hasExplicitCallMethods = callMethods.length > 0;
  const supportsResponsesFromCallMethods = callMethods.some((method) => {
    const normalized = method.toLowerCase().replace(/[_-]/g, '.');
    return normalized === 'responses' || normalized === 'response' || normalized.endsWith('.responses');
  });
  const officialOpenAIModel = isOfficialOpenAIBaseUrl(options.apiBaseUrl) && isKnownOpenAIResponsesModel(apiModel.id);
  const supportsResponses = hasExplicitCallMethods
    ? supportsResponsesFromCallMethods
    : officialOpenAIModel;

  const supportsWebSearch = supportsResponses;
  const supportsReasoningEffort = supportsResponses && hasExplicitReasoningSupport(apiModel, officialOpenAIModel);
  const capabilityReason = supportsWebSearch
    ? ''
    : hasExplicitCallMethods
    ? '当前模型不支持 Responses API，无法使用网络搜索。请切换支持网络搜索的模型后重试。'
    : '当前 API 服务未声明该模型支持 Responses API，无法使用网络搜索。请切换支持网络搜索的模型后重试。';

  return {
    callMethods,
    supportsResponses,
    supportsWebSearch,
    supportsReasoningEffort,
    capabilityReason,
  };
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function isOfficialOpenAIBaseUrl(apiBaseUrl = '') {
  if (!apiBaseUrl) return false;
  try {
    const hostname = new URL(apiBaseUrl).hostname.toLowerCase();
    return hostname === 'api.openai.com' || hostname.endsWith('.api.openai.com');
  } catch {
    return false;
  }
}

function isKnownOpenAIResponsesModel(id = '') {
  const lower = String(id).toLowerCase();
  return /^(gpt-5|gpt-4\.1|o[1-9]|o\d-|o\d\b)/.test(lower);
}

function hasExplicitReasoningSupport(apiModel, officialOpenAIModel) {
  if (officialOpenAIModel) return /^(gpt-5|o[1-9]|o\d-|o\d\b)/i.test(apiModel.id);

  const supportedParameters = normalizeStringArray(apiModel.supported_parameters);
  if (supportedParameters.some((param) => /^(reasoning|reasoning\.effort|reasoning_effort)$/i.test(param))) {
    return true;
  }

  if (apiModel.supports_reasoning_effort === true) return true;
  if (apiModel.capabilities?.reasoning === true || apiModel.capabilities?.reasoning_effort === true) return true;
  return false;
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
function classifyHTTPError(status, body, contentType = '') {
  if ((status === 404 || status === 405 || status === 501) && !contentType.toLowerCase().includes('application/json')) {
    return createBackendUnavailableError();
  }

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
