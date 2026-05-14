import { generateId } from './utils.js';

export const BUILT_IN_PROMPT_TEMPLATES = [
  {
    id: 'builtin-code-review',
    name: '代码审查',
    content: '请审查以下代码，优先指出会导致错误、数据丢失、安全风险或可维护性退化的问题，并给出具体修改建议：\n\n{{code}}',
    builtin: true,
  },
  {
    id: 'builtin-summarize',
    name: '总结长文',
    content: '请用简洁的中文总结以下内容，保留关键结论、证据和待办事项：\n\n{{text}}',
    builtin: true,
  },
  {
    id: 'builtin-translate-polish',
    name: '翻译润色',
    content: '请将以下内容翻译成自然、专业的中文；如果已经是中文，请进行表达润色：\n\n{{text}}',
    builtin: true,
  },
  {
    id: 'builtin-meeting-notes',
    name: '会议纪要',
    content: '请将以下会议记录整理为：会议结论、关键讨论、行动项、负责人、截止时间：\n\n{{notes}}',
    builtin: true,
  },
  {
    id: 'builtin-study',
    name: '学习讲解',
    content: '请像教学一样解释以下主题：先给直观结论，再讲核心概念、例子、常见误区和练习建议：\n\n{{topic}}',
    builtin: true,
  },
  {
    id: 'builtin-debug',
    name: '故障排查',
    content: '请帮我排查以下问题。先列最可能原因，再给验证步骤和修复方案。背景如下：\n\n{{context}}',
    builtin: true,
  },
];

export function normalizeCustomTemplates(value) {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      id: typeof item.id === 'string' && item.id ? item.id : generateId(),
      name: String(item.name ?? '').trim(),
      content: String(item.content ?? '').trim(),
      builtin: false,
      updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
    }))
    .filter((item) => item.name && item.content);
}

export function mergeTemplates(customTemplates) {
  return [
    ...BUILT_IN_PROMPT_TEMPLATES,
    ...normalizeCustomTemplates(customTemplates),
  ];
}

export function upsertCustomTemplate(customTemplates, template) {
  const nextTemplate = {
    id: template.id || generateId(),
    name: String(template.name ?? '').trim(),
    content: String(template.content ?? '').trim(),
    builtin: false,
    updatedAt: Date.now(),
  };

  if (!nextTemplate.name || !nextTemplate.content) {
    throw new Error('模板名称和内容不能为空');
  }

  const normalized = normalizeCustomTemplates(customTemplates);
  const index = normalized.findIndex((item) => item.id === nextTemplate.id);
  if (index >= 0) {
    normalized[index] = nextTemplate;
  } else {
    normalized.unshift(nextTemplate);
  }
  return normalized;
}

export function deleteCustomTemplate(customTemplates, templateId) {
  return normalizeCustomTemplates(customTemplates).filter((item) => item.id !== templateId);
}
