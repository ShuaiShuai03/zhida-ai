/**
 * Application configuration — API settings and constants.
 * Model definitions are fetched at runtime from the configured provider's
 * /v1/models endpoint; there is no hard-coded model list.
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
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
export const DEFAULT_WEB_SEARCH_CONTEXT_SIZE = 'medium';
export const WEB_SEARCH_CONTEXT_SIZES = ['low', 'medium', 'high'];

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

// ---- Welcome Prompt Cards ----
export const WELCOME_PROMPTS = [
  {
    icon: '摘',
    title: '总结资料',
    text: '请把下面内容总结成结论、关键依据和下一步行动：',
  },
  {
    icon: '写',
    title: '写作改写',
    text: '请将下面内容改写得更清晰、专业，并保留原意：',
  },
  {
    icon: '码',
    title: '代码协作',
    text: '请解释这段代码的逻辑、风险和最小改进建议：',
  },
  {
    icon: '核',
    title: '联网核查',
    text: '请核查下面说法是否准确，并列出可验证来源：',
  },
  {
    icon: '档',
    title: '文件分析',
    text: '请分析我上传的文件，提取关键发现、异常和待确认信息。',
  },
  {
    icon: '续',
    title: '续接工作',
    text: '请根据上文继续推进，先总结当前状态，再给出下一步。',
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
export const STORAGE_SOFT_WARNING_RATIO = 0.8;
export const TITLE_MAX_LENGTH = 20;
export const DEBOUNCE_DELAY = 300;
export const SCROLL_THRESHOLD = 100; // px from bottom to auto-scroll
