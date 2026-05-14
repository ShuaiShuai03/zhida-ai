import test from 'node:test';
import assert from 'node:assert/strict';

import { getRequestRouteDecision, normalizeModel, shouldUseResponsesRoute } from '../js/api.js';
import {
  buildLongTextPromptBlock,
  createGeneratedMdAttachment,
} from '../js/long-text.js';
import {
  createBackupPayload,
  parseBackupPayload,
} from '../js/backup-utils.js';

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

test('model capabilities follow call_methods and conservative fallback rules', () => {
  const chatOnly = normalizeModel({
    id: 'claude-haiku-4-5-20251001',
    owned_by: 'compat',
    call_methods: ['chat.completions'],
  });
  assert.equal(chatOnly.supportsResponses, false);
  assert.equal(chatOnly.supportsWebSearch, false);

  const responsesModel = normalizeModel({
    id: 'gpt-5.5-test',
    owned_by: 'openai',
    call_methods: ['responses'],
    supported_parameters: ['reasoning'],
  });
  assert.equal(responsesModel.supportsResponses, true);
  assert.equal(responsesModel.supportsWebSearch, true);
  assert.equal(responsesModel.supportsReasoningEffort, true);

  const undeclaredThirdParty = normalizeModel({ id: 'qwen-compatible', owned_by: 'mock' });
  assert.equal(undeclaredThirdParty.supportsResponses, false);

  const officialOpenAI = normalizeModel(
    { id: 'gpt-5.5', owned_by: 'openai' },
    { apiBaseUrl: 'https://api.openai.com' }
  );
  assert.equal(officialOpenAI.supportsResponses, true);
  assert.equal(officialOpenAI.supportsWebSearch, true);
  assert.equal(officialOpenAI.supportsReasoningEffort, true);
});

test('request routing is capability driven and blocks unsupported web search', () => {
  assert.equal(shouldUseResponsesRoute({
    model: { type: 'standard', supportsWebSearch: false, supportsReasoningEffort: false },
    webSearchEnabled: false,
    reasoningEffort: 'medium',
  }), false);

  assert.deepEqual(getRequestRouteDecision({
    model: { type: 'standard', supportsWebSearch: false, supportsReasoningEffort: false },
    webSearchEnabled: true,
    reasoningEffort: 'medium',
  }).route, 'blocked');

  const responsesDecision = getRequestRouteDecision({
    model: { type: 'standard', supportsWebSearch: true, supportsReasoningEffort: false },
    webSearchEnabled: true,
    reasoningEffort: 'medium',
  });
  assert.equal(responsesDecision.route, 'responses');
  assert.deepEqual(responsesDecision.requestOptions, {
    includeWebSearch: true,
    includeReasoning: false,
  });

  assert.equal(getRequestRouteDecision({
    model: { type: 'thinking', supportsWebSearch: false, supportsReasoningEffort: false },
    webSearchEnabled: false,
    reasoningEffort: 'high',
  }).route, 'chat');
});

test('backup preserves non-sensitive search/reasoning settings and long text metadata', () => {
  const payload = createBackupPayload({
    settings: {
      apiBaseUrl: 'https://api.example.com',
      webSearchEnabled: true,
      reasoningEffort: 'high',
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
  assert.equal(parsed.settings.reasoningEffort, 'high');
  assert.equal(parsed.settings.apiKey, undefined);
  assert.equal(parsed.longTextAttachments[0].content, '# Full text');
});
