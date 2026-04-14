import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAssistantMessageFromBuffers,
  deriveConversationTitle,
  parseThinkingContent,
  resolveConversationModel,
  sortConversationsByUpdatedAt,
} from '../js/conversation-utils.js';

test('sortConversationsByUpdatedAt sorts newest first without mutating input', () => {
  const conversations = [
    { id: 'older', updatedAt: 10, createdAt: 1 },
    { id: 'newer', updatedAt: 20, createdAt: 2 },
    { id: 'fallback-created', createdAt: 15 },
  ];

  const sorted = sortConversationsByUpdatedAt(conversations);

  assert.deepEqual(sorted.map((item) => item.id), ['newer', 'fallback-created', 'older']);
  assert.deepEqual(conversations.map((item) => item.id), ['older', 'newer', 'fallback-created']);
});

test('deriveConversationTitle prefers trimmed text and falls back to attachments', () => {
  assert.equal(
    deriveConversationTitle('  第一条消息  ', [{ name: 'ignored.md' }], { maxLength: 20 }),
    '第一条消息'
  );
  assert.equal(
    deriveConversationTitle('', [{ name: 'design-specification.md' }], { maxLength: 20 }),
    '📎 design-specificat…'
  );
  assert.equal(
    deriveConversationTitle('', [{ name: 'a.txt' }, { name: 'b.txt' }], { maxLength: 20 }),
    '📎 2 个附件'
  );
});

test('parseThinkingContent extracts think tags from mixed output', () => {
  assert.deepEqual(
    parseThinkingContent('<think>分析中</think>最终答案'),
    { thinking: '分析中', content: '最终答案' }
  );
});

test('buildAssistantMessageFromBuffers keeps thinking-only output and marks stopped replies', () => {
  assert.deepEqual(
    buildAssistantMessageFromBuffers({
      contentBuffer: '<think>逐步分析</think>结论',
      reasoningBuffer: '',
      wasStopped: false,
    }),
    {
      content: '结论',
      thinking: '逐步分析',
      hasVisibleOutput: true,
    }
  );

  assert.deepEqual(
    buildAssistantMessageFromBuffers({
      contentBuffer: '',
      reasoningBuffer: '还在思考',
      wasStopped: true,
    }),
    {
      content: '*(已停止生成，未返回最终答案)*',
      thinking: '还在思考',
      hasVisibleOutput: true,
    }
  );
});

test('resolveConversationModel prefers the conversation model over current selection', () => {
  const models = [
    { id: 'alpha', name: 'Alpha' },
    { id: 'beta', name: 'Beta' },
  ];

  assert.deepEqual(
    resolveConversationModel(models, 'beta', models[0]),
    { id: 'beta', name: 'Beta' }
  );
  assert.deepEqual(
    resolveConversationModel(models, 'missing', models[0]),
    { id: 'alpha', name: 'Alpha' }
  );
});
