import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildResponsesRequestBody,
  getRequestRouteDecision,
  normalizeModel,
  shouldUseResponsesRoute,
} from '../js/api.js';
import { buildAPIMessages } from '../js/chat.js';
import {
  MAX_STORAGE_MB,
  REASONING_EFFORTS,
  STORAGE_KEYS,
  WEB_SEARCH_CONTEXT_SIZES,
} from '../js/config.js';
import {
  buildLongTextPromptBlock,
  createGeneratedMdAttachment,
} from '../js/long-text.js';
import {
  createBackupPayload,
  parseBackupPayload,
} from '../js/backup-utils.js';
import { state } from '../js/state.js';
import {
  checkStorageSoftLimit,
  saveConversations,
} from '../js/storage.js';

function installLocalStorageMock({ initial = {}, setItem } = {}) {
  const store = new Map(Object.entries(initial));
  const mock = {
    get length() {
      return store.size;
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null;
    },
    getItem(key) {
      return store.has(String(key)) ? store.get(String(key)) : null;
    },
    setItem(key, value) {
      if (setItem) return setItem(key, value);
      store.set(String(key), String(value));
      return undefined;
    },
    removeItem(key) {
      store.delete(String(key));
    },
    clear() {
      store.clear();
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: mock,
    configurable: true,
  });
  return mock;
}

function installToastDom() {
  const toasts = [];
  const container = {
    appendChild(node) {
      toasts.push(node);
    },
  };

  Object.defineProperty(globalThis, 'document', {
    value: {
      querySelector(selector) {
        return selector === '#toast-container' ? container : null;
      },
      createElement() {
        const node = {
          attributes: {},
          className: '',
          innerHTML: '',
          classList: {
            add(className) {
              node.className = `${node.className} ${className}`.trim();
            },
          },
          setAttribute(name, value) {
            node.attributes[name] = value;
          },
          addEventListener() {},
          remove() {},
        };
        return node;
      },
    },
    configurable: true,
  });

  return toasts;
}

function installImmediateTimeout() {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback) => {
    callback();
    return 0;
  };
  return () => {
    globalThis.setTimeout = originalSetTimeout;
  };
}

function restoreGlobal(name, originalDescriptor) {
  if (originalDescriptor) {
    Object.defineProperty(globalThis, name, originalDescriptor);
  } else {
    delete globalThis[name];
  }
}

test('long text md attachment uses BJT filename and bounded excerpt', () => {
  const content = 'a'.repeat(2500) + '\n' + 'b'.repeat(2500);
  const attachment = createGeneratedMdAttachment(content, new Date('2026-05-14T01:02:03Z'));

  assert.equal(attachment.name, 'long-text-20260514-090203-BJT.md');
  assert.equal(attachment.type, 'generated-md');
  assert.equal(attachment.mode, 'reference');
  assert.equal(attachment.charCount, content.length);
  assert.equal(attachment.lineCount, 2);
  assert.equal(attachment.excerpt.length, 1200);
});

test('long text reference mode omits full content and full mode includes it', () => {
  const content = `alpha ${'x'.repeat(4500)} omega`;
  const reference = createGeneratedMdAttachment(content, new Date('2026-05-14T01:02:03Z'));
  const referenceBlock = buildLongTextPromptBlock(reference, content);

  assert.match(referenceBlock, /未随请求发送/);
  assert.doesNotMatch(referenceBlock, new RegExp(`alpha ${'x'.repeat(2000)}`));

  const full = { ...reference, mode: 'full' };
  const fullBlock = buildLongTextPromptBlock(full, content);
  assert.match(fullBlock, /以下是该附件全文/);
  assert.match(fullBlock, new RegExp(`alpha ${'x'.repeat(2000)}`));
});

test('model capabilities follow call_methods and optimistic fallback rules', () => {
  const chatOnly = normalizeModel({
    id: 'claude-haiku-4-5-20251001',
    owned_by: 'compat',
    call_methods: ['chat.completions'],
  });
  assert.equal(chatOnly.supportsChatCompletions, true);
  assert.equal(chatOnly.supportsResponses, false);
  assert.equal(chatOnly.supportsWebSearch, false);

  const responsesModel = normalizeModel({
    id: 'gpt-5.5-test',
    owned_by: 'openai',
    call_methods: ['responses'],
    supported_parameters: ['reasoning'],
  });
  assert.equal(responsesModel.supportsChatCompletions, false);
  assert.equal(responsesModel.supportsResponses, true);
  assert.equal(responsesModel.supportsWebSearch, true);
  assert.equal(responsesModel.supportsReasoningEffort, true);

  const undeclaredThirdParty = normalizeModel({ id: 'qwen-compatible', owned_by: 'mock' });
  assert.equal(undeclaredThirdParty.supportsChatCompletions, true);
  assert.equal(undeclaredThirdParty.supportsResponses, true);
  assert.equal(undeclaredThirdParty.supportsWebSearch, true);

  const currentOpenAiReasoning = normalizeModel({ id: 'gpt-5.5', owned_by: 'openai' });
  assert.equal(currentOpenAiReasoning.supportsResponses, true);
  assert.equal(currentOpenAiReasoning.supportsWebSearch, true);
  assert.equal(currentOpenAiReasoning.supportsReasoningEffort, true);
});

test('request routing is capability driven and downgrades unsupported web search', () => {
  assert.equal(shouldUseResponsesRoute({
    model: { type: 'standard', supportsWebSearch: false, supportsReasoningEffort: false },
    webSearchEnabled: false,
    reasoningEffort: 'medium',
  }), false);

  const downgradedDecision = getRequestRouteDecision({
    model: { type: 'standard', supportsWebSearch: false, supportsReasoningEffort: false },
    webSearchEnabled: true,
    reasoningEffort: 'medium',
  });
  assert.equal(downgradedDecision.route, 'chat');
  assert.equal(downgradedDecision.downgraded, 'web_search_unavailable');
  assert.deepEqual(downgradedDecision.requestOptions, {});

  const responsesDecision = getRequestRouteDecision({
    model: { type: 'standard', supportsWebSearch: true, supportsReasoningEffort: false },
    webSearchEnabled: true,
    reasoningEffort: 'medium',
  });
  assert.equal(responsesDecision.route, 'responses');
  assert.deepEqual(responsesDecision.requestOptions, {
    includeWebSearch: true,
    includeReasoning: false,
    webSearchContextSize: 'medium',
  });

  const responsesOnlyDecision = getRequestRouteDecision({
    model: {
      type: 'standard',
      supportsChatCompletions: false,
      supportsResponses: true,
      supportsWebSearch: true,
      supportsReasoningEffort: false,
    },
    webSearchEnabled: false,
    reasoningEffort: 'medium',
  });
  assert.equal(responsesOnlyDecision.route, 'responses');
  assert.deepEqual(responsesOnlyDecision.requestOptions, {
    includeWebSearch: false,
    includeReasoning: false,
    webSearchContextSize: 'medium',
  });

  assert.equal(getRequestRouteDecision({
    model: { type: 'thinking', supportsWebSearch: false, supportsReasoningEffort: false },
    webSearchEnabled: false,
    reasoningEffort: 'high',
  }).route, 'chat');
});

test('responses request body carries bounded search context and current reasoning efforts', () => {
  assert.deepEqual(WEB_SEARCH_CONTEXT_SIZES, ['low', 'medium', 'high']);
  assert.deepEqual(REASONING_EFFORTS, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

  const body = buildResponsesRequestBody([
    { role: 'system', content: 'answer briefly' },
    { role: 'user', content: 'latest policy update' },
  ], {
    includeWebSearch: true,
    includeReasoning: true,
    webSearchContextSize: 'high',
  }, {
    modelId: 'gpt-5.5',
    model: { supportsReasoningEffort: true },
    maxTokens: 2048,
    reasoningEffort: 'minimal',
  });

  assert.deepEqual(body, {
    model: 'gpt-5.5',
    input: [
      { role: 'system', content: 'answer briefly' },
      { role: 'user', content: 'latest policy update' },
    ],
    stream: true,
    max_output_tokens: 2048,
    tools: [{ type: 'web_search', search_context_size: 'high' }],
    reasoning: { effort: 'minimal' },
  });
});

test('responses request body avoids unsupported minimal reasoning with gpt-5 web search', () => {
  const body = buildResponsesRequestBody([
    { role: 'user', content: 'search with reasoning' },
  ], {
    includeWebSearch: true,
    includeReasoning: true,
  }, {
    modelId: 'gpt-5',
    model: { supportsReasoningEffort: true },
    reasoningEffort: 'minimal',
  });

  assert.deepEqual(body.reasoning, { effort: 'low' });
});

test('api messages use the current system prompt over a stale conversation prompt', async () => {
  const previousSystemPrompt = state.systemPrompt;
  state.systemPrompt = 'current custom prompt';
  try {
    const messages = await buildAPIMessages({
      systemPrompt: 'old conversation prompt',
      messages: [{ role: 'user', content: 'hello' }],
    });

    assert.deepEqual(messages.slice(0, 2), [
      { role: 'system', content: 'current custom prompt' },
      { role: 'user', content: 'hello' },
    ]);
  } finally {
    state.systemPrompt = previousSystemPrompt;
  }
});

test('backup preserves non-sensitive search/reasoning settings and long text metadata', () => {
  const payload = createBackupPayload({
    settings: {
      apiBaseUrl: 'https://api.example.com',
      webSearchEnabled: true,
      webSearchContextSize: 'high',
      reasoningEffort: 'high',
      displayFont: 'serif',
      apiKey: 'must-not-export',
    },
    conversations: [],
    longTextAttachments: [{
      id: 'att-1',
      type: 'generated-md',
      name: 'long-text-20260514-090203-BJT.md',
      content: '# Full text',
      mode: 'full',
    }],
  });

  const parsed = parseBackupPayload(payload);
  assert.equal(parsed.settings.webSearchEnabled, true);
  assert.equal(parsed.settings.webSearchContextSize, 'high');
  assert.equal(parsed.settings.reasoningEffort, 'high');
  assert.equal(parsed.settings.displayFont, 'serif');
  assert.equal(parsed.settings.apiKey, undefined);
  assert.equal(parsed.longTextAttachments[0].content, '# Full text');

  const invalidFontPayload = createBackupPayload({
    settings: { displayFont: 'remote-font-url' },
    conversations: [],
  });
  assert.equal(invalidFontPayload.settings.displayFont, undefined);
});

test('conversation save catches localStorage quota errors and keeps memory state', () => {
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalWarn = console.warn;
  const restoreTimeout = installImmediateTimeout();
  const warnings = [];

  installToastDom();
  installLocalStorageMock({
    setItem() {
      const err = new Error('quota full');
      err.name = 'QuotaExceededError';
      throw err;
    },
  });
  console.warn = (...args) => warnings.push(args);
  state.clearAllConversations();

  try {
    const conversation = {
      id: 'quota-conv',
      title: 'Quota test',
      modelId: 'qwen-max-latest',
      systemPrompt: 'system',
      messages: [{ id: 'msg-1', role: 'user', content: 'hello', timestamp: 1 }],
      createdAt: 1,
      updatedAt: 2,
      pinned: false,
      tags: [],
    };

    assert.doesNotThrow(() => {
      assert.equal(saveConversations([conversation]), false);
    });
    assert.deepEqual(state.conversations, [conversation]);
    assert.equal(
      warnings.some((args) => JSON.stringify(args).includes(STORAGE_KEYS.CONVERSATIONS)),
      true
    );
  } finally {
    state.clearAllConversations();
    console.warn = originalWarn;
    restoreTimeout();
    restoreGlobal('localStorage', originalLocalStorage);
    restoreGlobal('document', originalDocument);
  }
});

test('storage soft warning triggers once above 80 percent of the limit', async () => {
  const storageModule = await import(`../js/storage.js?soft-warning-${Date.now()}`);
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const restoreTimeout = installImmediateTimeout();
  const toasts = installToastDom();
  const warningBytes = Math.ceil(MAX_STORAGE_MB * 1024 * 1024 * 0.81);

  installLocalStorageMock({
    initial: {
      [STORAGE_KEYS.CONVERSATIONS]: 'x'.repeat(warningBytes),
    },
  });

  try {
    assert.equal(storageModule.checkStorageSoftLimit(), true);
    assert.equal(storageModule.checkStorageSoftLimit(), false);
    assert.equal(toasts.length, 1);
    assert.match(toasts[0].innerHTML, /存储空间即将用满，建议导出备份/);
    assert.match(toasts[0].className, /toast--warning/);
  } finally {
    restoreTimeout();
    restoreGlobal('localStorage', originalLocalStorage);
    restoreGlobal('document', originalDocument);
  }
});
