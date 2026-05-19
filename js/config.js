/**
 * Application configuration — API settings, model definitions, and constants.
 * To customise, edit the values below.
 */

// ---- API Configuration ----
// Users configure API_BASE_URL and API_KEY at runtime via the Settings modal.
// The browser sends them only to the same-origin Node backend configuration
// endpoint. API keys are not persisted in localStorage or exported backups.
export const DEFAULT_API_BASE_URL = '';

// ---- Request Defaults ----
export const DEFAULT_TEMPERATURE = 0.7;
export const DEFAULT_MAX_TOKENS = 4096;
export const REQUEST_TIMEOUT = 60000; // 60 seconds
export const DEFAULT_REASONING_EFFORT = 'medium';
export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

// ---- Default System Prompt ----
export const DEFAULT_SYSTEM_PROMPT = '你是一个有用的AI助手。请用简体中文回答所有问题。';

// ---- File Upload Support ----
export const SUPPORTED_TEXT_FILE_EXTENSIONS = [
  'txt', 'md', 'js', 'ts', 'jsx', 'tsx', 'py', 'json', 'csv', 'html', 'css', 'xml',
  'yaml', 'yml', 'sh', 'bat', 'ps1', 'sql', 'go', 'rs', 'java', 'c', 'cpp', 'h',
  'rb', 'php', 'log', 'conf', 'ini', 'toml', 'env', 'swift', 'kt', 'scala', 'r',
];

export const SUPPORTED_IMAGE_FILE_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg',
];

export const FILE_INPUT_ACCEPT = [
  ...SUPPORTED_TEXT_FILE_EXTENSIONS,
  ...SUPPORTED_IMAGE_FILE_EXTENSIONS,
].map((ext) => `.${ext}`).join(',');

// ---- Long Text Attachment Support ----
export const LONG_TEXT_AUTO_MD_THRESHOLD = 4000;
export const LONG_TEXT_EXCERPT_MAX = 1200;

// ---- Model Definitions ----
export const MODELS = [
  {
    id: 'qwen-max-latest',
    name: 'Qwen Max',
    badge: '🌟 旗舰',
    badgeClass: 'badge--premium',
    type: 'standard',
    description: '通义千问旗舰模型，综合能力最强',
  },
  {
    id: 'qwen-max-latest-thinking',
    name: 'Qwen Max Thinking',
    badge: '🧠 深度思考',
    badgeClass: 'badge--thinking',
    type: 'thinking',
    description: '通义千问旗舰思考模型，深度推理与复杂分析',
  },
  {
    id: 'qwen3-max-2026-01-23',
    name: 'Qwen3 Max',
    badge: '🌟 高级',
    badgeClass: 'badge--premium',
    type: 'standard',
    description: '通义千问3代旗舰模型，全面升级的综合能力',
  },
  {
    id: 'qwen3-max-2026-01-23-thinking',
    name: 'Qwen3 Max Thinking',
    badge: '🧠 深度思考',
    badgeClass: 'badge--thinking',
    type: 'thinking',
    description: '通义千问3代旗舰思考模型，增强推理能力',
  },
  {
    id: 'qwen3-vl-plus-thinking',
    name: 'Qwen3 VL Plus Thinking',
    badge: '🧠 多模态推理',
    badgeClass: 'badge--thinking',
    type: 'thinking',
    description: '通义千问3代视觉语言思考模型，支持图文理解与推理',
  },
  {
    id: 'qwen3.5-plus-thinking',
    name: 'Qwen3.5 Plus Thinking',
    badge: '🧠 深度思考',
    badgeClass: 'badge--thinking',
    type: 'thinking',
    description: '通义千问3.5代增强思考模型，最新推理能力',
  },
];

// ---- Welcome Prompt Cards ----
export const WELCOME_PROMPTS = [
  {
    icon: '⌘',
    title: '代码解释',
    text: '请解释这段代码的核心逻辑、潜在问题和可以改进的地方：',
  },
  {
    icon: '文',
    title: '文档总结',
    text: '请把下面内容总结成结构清晰的要点，并列出下一步行动：',
  },
  {
    icon: '图',
    title: '图片分析',
    text: '请分析我上传的图片，说明你观察到的内容、关键信息和可能结论。',
  },
  {
    icon: '译',
    title: '翻译润色',
    text: '请将下面内容翻译并润色成自然、专业、简洁的表达：',
  },
  {
    icon: '策',
    title: '方案规划',
    text: '请帮我制定一个可执行方案，包含目标、步骤、风险和验证方式：',
  },
  {
    icon: '数',
    title: '资料整理',
    text: '请把下面资料整理成表格或清单，并标出缺失信息和优先级：',
  },
];

// ---- Storage Keys ----
export const STORAGE_KEYS = {
  CONVERSATIONS: 'ai_chat_conversations',
  ACTIVE_CONVERSATION: 'ai_chat_active_id',
  SELECTED_MODEL: 'ai_chat_model',
  THEME: 'ai_chat_theme',
  SETTINGS: 'ai_chat_settings',
  MODELS: 'ai_chat_models',
  PROMPT_TEMPLATES: 'ai_chat_prompt_templates',
};

// ---- Limits ----
export const MAX_CONVERSATIONS = 100;
export const MAX_STORAGE_MB = 4.5; // localStorage soft limit
export const TITLE_MAX_LENGTH = 20;
export const DEBOUNCE_DELAY = 300;
export const SCROLL_THRESHOLD = 100; // px from bottom to auto-scroll
