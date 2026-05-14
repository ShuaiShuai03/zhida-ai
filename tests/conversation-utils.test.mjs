import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAssistantMessageFromBuffers,
  deriveConversationTitle,
  filterConversations,
  parseTagsInput,
  pruneConversationsToLimit,
  parseThinkingContent,
  resolveConversationModel,
  sortConversationsByUpdatedAt,
} from '../js/conversation-utils.js';
import {
  createBackupPayload,
  mergeBackupIntoState,
  parseBackupPayload,
} from '../js/backup-utils.js';
import {
  BUILT_IN_PROMPT_TEMPLATES,
  deleteCustomTemplate,
  mergeTemplates,
  upsertCustomTemplate,
} from '../js/prompt-templates.js';

test('sortConversationsByUpdatedAt sorts newest first without mutating input', () => {
  const conversations = [
    { id: 'older', updatedAt: 10, createdAt: 1 },
    { id: 'newer', updatedAt: 20, createdAt: 2 },
    { id: 'fallback-created', createdAt: 15 },
    { id: 'pinned-old', updatedAt: 5, pinned: true },
  ];

  const sorted = sortConversationsByUpdatedAt(conversations);

  assert.deepEqual(sorted.map((item) => item.id), ['pinned-old', 'newer', 'fallback-created', 'older']);
  assert.deepEqual(conversations.map((item) => item.id), ['older', 'newer', 'fallback-created', 'pinned-old']);
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

test('resolveConversationModel returns null instead of silently replacing missing models', () => {
  const models = [
    { id: 'alpha', name: 'Alpha' },
    { id: 'beta', name: 'Beta' },
  ];

  assert.deepEqual(
    resolveConversationModel(models, 'beta', models[0]),
    { id: 'beta', name: 'Beta' }
  );
  assert.deepEqual(
    resolveConversationModel(models, 'missing'),
    null
  );
});

test('filterConversations searches title, messages, model names, tags, and exact #tag', () => {
  const conversations = [
    {
      id: 'a',
      title: '排查线上错误',
      modelId: 'debug-model',
      tags: ['工作', 'urgent'],
      messages: [{ content: '数据库连接超时' }],
    },
    {
      id: 'b',
      title: '读书笔记',
      modelId: 'study-model',
      tags: ['学习'],
      messages: [{ content: '深度学习章节' }],
    },
  ];
  const models = [
    { id: 'debug-model', name: 'Debug Assistant' },
    { id: 'study-model', name: 'Study Helper' },
  ];

  assert.deepEqual(filterConversations(conversations, '数据库', models).map((item) => item.id), ['a']);
  assert.deepEqual(filterConversations(conversations, 'Study Helper', models).map((item) => item.id), ['b']);
  assert.deepEqual(filterConversations(conversations, 'urgent', models).map((item) => item.id), ['a']);
  assert.deepEqual(filterConversations(conversations, '#学习', models).map((item) => item.id), ['b']);
});

test('parseTagsInput normalizes separators, hashes, and duplicates', () => {
  assert.deepEqual(parseTagsInput(' #work, 学习；work  '), ['work', '学习']);
});

test('pruneConversationsToLimit keeps pinned conversations and removes oldest regular items', () => {
  const result = pruneConversationsToLimit([
    { id: 'pinned', pinned: true, updatedAt: 1 },
    { id: 'new', updatedAt: 30 },
    { id: 'middle', updatedAt: 20 },
    { id: 'old', updatedAt: 10 },
  ], 2);

  assert.deepEqual(result.kept.map((item) => item.id), ['pinned', 'new']);
  assert.deepEqual(result.removed.map((item) => item.id), ['middle', 'old']);
});

test('backup payload rejects invalid versions and merges conversations by imported id', () => {
  assert.throws(() => parseBackupPayload('{bad'), /合法 JSON/);
  assert.throws(() => parseBackupPayload({ version: 999 }), /不支持/);

  const backup = createBackupPayload({
    conversations: [{ id: 'same', title: 'imported', messages: [], updatedAt: 20 }],
    activeConversationId: 'same',
    selectedModelId: 'model-b',
    models: [{ id: 'model-b' }],
    settings: { apiBaseUrl: 'https://api.example.com' },
    promptTemplates: [{ id: 'tpl', name: '模板', content: '内容' }],
  });

  const merged = mergeBackupIntoState({
    conversations: [
      { id: 'same', title: 'current', messages: [], updatedAt: 10 },
      { id: 'other', title: 'other', messages: [], updatedAt: 5 },
    ],
    activeConversationId: 'other',
    selectedModelId: 'model-a',
    models: [{ id: 'model-a' }],
    settings: { apiBaseUrl: 'https://old.example.com', apiKey: 'local-key', requestMode: 'direct' },
    promptTemplates: [],
  }, parseBackupPayload(backup));

  assert.equal(merged.conversations.find((item) => item.id === 'same').title, 'imported');
  assert.equal(merged.activeConversationId, 'same');
  assert.equal(merged.settings.apiBaseUrl, 'https://api.example.com');
  assert.equal(merged.settings.requestMode, undefined);
  assert.equal(merged.settings.apiKey, undefined);
  assert.equal(merged.promptTemplates.length, 1);
});

test('prompt templates keep built-ins and support custom create update delete', () => {
  const created = upsertCustomTemplate([], { id: 'custom', name: '自定义', content: '内容 {{text}}' });
  assert.equal(created.length, 1);
  assert.equal(mergeTemplates(created).length, BUILT_IN_PROMPT_TEMPLATES.length + 1);

  const updated = upsertCustomTemplate(created, { id: 'custom', name: '更新', content: '新内容' });
  assert.equal(updated[0].name, '更新');

  const deleted = deleteCustomTemplate(updated, 'custom');
  assert.deepEqual(deleted, []);
  assert.throws(() => upsertCustomTemplate([], { name: '', content: '' }), /不能为空/);
});
