#!/usr/bin/env node

import { createReadStream, statSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');

function logEvent(level, event, fields = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) payload[key] = value;
  }
  const line = `${JSON.stringify(payload)}\n`;
  if (level === 'error') {
    process.stderr.write(line);
    return;
  }
  process.stdout.write(line);
}

function readIntegerEnv(name, defaultValue, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name] ?? String(defaultValue);
  const value = String(raw).trim();
  if (!/^\d+$/.test(value)) {
    process.stderr.write(`错误: ${name} 必须是 ${min} 到 ${max} 之间的整数。\n`);
    process.exit(1);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    process.stderr.write(`错误: ${name} 必须是 ${min} 到 ${max} 之间的整数。\n`);
    process.exit(1);
  }
  return parsed;
}

const HOST = String(process.env.ZHIDA_HOST || '127.0.0.1').trim() || '127.0.0.1';
const PORT = readIntegerEnv('ZHIDA_PORT', '3000', { min: 1, max: 65535 });
const DOCKER_CONFIG_PATH = '/data/config.enc.json';
const DEFAULT_CONFIG_PATH = join(ROOT_DIR, '.zhida-data/config.enc.json');
const LEGACY_CONFIG_PATH = join(__dirname, 'data/config.enc.json');
const LEGACY_DOCKER_CONFIG_PATH = resolve(process.env.LEGACY_DOCKER_CONFIG_PATH || LEGACY_CONFIG_PATH);
const CONFIG_PATH_USES_DEFAULT = !process.env.ZHIDA_CONFIG_PATH;
const CONFIG_PATH = resolve(process.env.ZHIDA_CONFIG_PATH || DEFAULT_CONFIG_PATH);
const CONFIG_SECRET = process.env.ZHIDA_CONFIG_SECRET || '';
const PROXY_TIMEOUT_MS = readIntegerEnv('ZHIDA_PROXY_TIMEOUT_MS', '120000');
const CONFIG_BODY_LIMIT_BYTES = 256 * 1024;
const DEFAULT_PROXY_BODY_LIMIT_BYTES = 25 * 1024 * 1024;
const PROXY_BODY_LIMIT_BYTES = readIntegerEnv('ZHIDA_PROXY_MAX_BODY_BYTES', String(DEFAULT_PROXY_BODY_LIMIT_BYTES));
const OTHER_API_BODY_LIMIT_BYTES = 512 * 1024;
const WEB_SEARCH_BODY_LIMIT_BYTES = 8 * 1024;
const ENABLE_TEST_ROUTES = process.env.ZHIDA_ENABLE_TEST_ROUTES === '1';
const CONFIG_VERSION = 1;
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const REQUEST_BODY_TOO_LARGE = 'request_body_too_large';
const LOG_MESSAGE_MAX_LENGTH = 500;
const ALLOWED_RESPONSES_FIELDS = new Set([
  'model',
  'input',
  'stream',
  'max_output_tokens',
  'tools',
  'reasoning',
]);
const ALLOWED_RESPONSES_TOOL_FIELDS = new Set(['type', 'search_context_size']);
const ALLOWED_REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const ALLOWED_WEB_SEARCH_CONTEXT_SIZES = new Set(['low', 'medium', 'high']);
const WEB_SEARCH_TIMEOUT_MS = 10_000;
const WEB_SEARCH_QUERY_MAX_LENGTH = 300;
const WEB_SEARCH_RESULT_LIMITS = {
  low: { results: 2, pages: 1 },
  medium: { results: 4, pages: 2 },
  high: { results: 6, pages: 3 },
};
const WEB_SEARCH_PAGE_TEXT_MAX_CHARS = 4000;
const WEB_SEARCH_TOTAL_TEXT_MAX_CHARS = 12000;
const WEB_SEARCH_RESPONSE_MAX_BYTES = 512 * 1024;
const WEB_CRAWL_RESPONSE_MAX_BYTES = 768 * 1024;
const WEB_SEARCH_PROVIDER_URL = 'https://html.duckduckgo.com/html/';
const WEB_SEARCH_USER_AGENT = 'ZhidaAI/0.1 standalone-search';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

const TEST_FRAME_CONTENT_SECURITY_POLICY = CONTENT_SECURITY_POLICY.replace(
  "frame-ancestors 'none'",
  "frame-ancestors 'self'"
);
const SMOKE_TEST_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

const TEST_FRAME_SECURITY_HEADERS = {
  ...SECURITY_HEADERS,
  'Content-Security-Policy': TEST_FRAME_CONTENT_SECURITY_POLICY,
  'X-Frame-Options': 'SAMEORIGIN',
};

const SMOKE_TEST_SECURITY_HEADERS = {
  ...SECURITY_HEADERS,
  'Content-Security-Policy': SMOKE_TEST_CONTENT_SECURITY_POLICY,
};

const NO_STORE_CACHE_CONTROL = 'no-store';
const STATIC_ASSET_CACHE_CONTROL = 'public, max-age=300, must-revalidate';

function withSecurityHeaders(headers = {}, securityHeaders = SECURITY_HEADERS) {
  return {
    ...securityHeaders,
    ...headers,
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, withSecurityHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': NO_STORE_CACHE_CONTROL,
  }));
  res.end(JSON.stringify(payload));
}

function getFirstHeader(value) {
  if (Array.isArray(value)) return value[0] ?? '';
  return value === undefined ? '' : String(value);
}

function getRequestPath(req) {
  return (req.url || '/').split('?')[0] || '/';
}

function getOriginHost(origin) {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

function getRequestHost(req) {
  return getFirstHeader(req.headers.host).split(',')[0].trim().toLowerCase();
}

function isUnsafeApiMethod(req) {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(req.method || '').toUpperCase());
}

function getRequestContentType(req) {
  return getFirstHeader(req.headers['content-type']).split(';')[0].trim().toLowerCase();
}

function isBrowserSimpleContentType(req) {
  return [
    'application/x-www-form-urlencoded',
    'multipart/form-data',
    'text/plain',
  ].includes(getRequestContentType(req));
}

function isUntrustedBrowserApiRequest(req) {
  if (!req.url?.startsWith('/api/')) return false;
  const fetchSite = getFirstHeader(req.headers['sec-fetch-site']).trim().toLowerCase();
  if (fetchSite === 'cross-site') return true;

  const origin = getFirstHeader(req.headers.origin).trim();
  if (!origin) {
    return !fetchSite && isUnsafeApiMethod(req) && isBrowserSimpleContentType(req);
  }
  const originHost = getOriginHost(origin);
  if (!originHost) return true;
  const requestHost = getRequestHost(req);
  return !requestHost || originHost !== requestHost;
}

function rejectUntrustedBrowserApiRequest(req, res) {
  if (!isUntrustedBrowserApiRequest(req)) return false;
  logEvent('warn', 'cross_site_api_rejected', {
    method: req.method,
    path: getRequestPath(req),
  });
  sendError(res, 403, 'Cross-site API requests are not allowed');
  return true;
}

function getContentLengthForLog(req) {
  const raw = req.headers['content-length'];
  if (raw === undefined) return undefined;
  return String(Array.isArray(raw) ? raw[0] : raw).trim() || undefined;
}

function sanitizeLogMessage(message, ...secrets) {
  let text = String(message || 'unknown_error');
  for (const secret of [CONFIG_SECRET, ...secrets]) {
    if (secret) text = text.split(secret).join('[REDACTED]');
  }
  text = text.replaceAll('ZHIDA_CONFIG_SECRET', '[REDACTED_SECRET]');
  return text.length > LOG_MESSAGE_MAX_LENGTH
    ? `${text.slice(0, LOG_MESSAGE_MAX_LENGTH)}...`
    : text;
}

function getErrorMessageForLog(err, fallback = 'unknown_error', ...secrets) {
  return sanitizeLogMessage(err?.message || fallback, ...secrets);
}

function logBodyLimitRejected(req) {
  const fields = {
    method: req.method,
    path: getRequestPath(req),
    limit: getApiBodyLimit(req) ?? OTHER_API_BODY_LIMIT_BYTES,
  };
  const contentLength = getContentLengthForLog(req);
  if (contentLength !== undefined) fields.content_length = contentLength;
  logEvent('warn', 'body_limit_rejected', fields);
}

function logNotFound(req) {
  logEvent('warn', 'not_found', {
    method: req.method,
    path: getRequestPath(req),
  });
}

function sendError(res, status, message) {
  sendJson(res, status, { error: { message } });
}

function sendRequestBodyTooLarge(req, res) {
  logBodyLimitRejected(req);
  const socket = req.socket;
  const payload = JSON.stringify({ error: 'Request body too large' });
  res.writeHead(413, withSecurityHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': NO_STORE_CACHE_CONTROL,
    'Connection': 'close',
    'Content-Length': Buffer.byteLength(payload),
  }));
  res.end(payload, () => {
    if (!socket.destroyed) socket.destroy();
  });
}

function proxyConfigError(res, message = '代理未配置：请先在设置中保存 API 地址和密钥') {
  sendError(res, 500, message);
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function getUpstreamPath(req) {
  if (req.method === 'GET' && req.url === '/api/models') return '/v1/models';
  if (req.method === 'POST' && req.url === '/api/chat/completions') return '/v1/chat/completions';
  if (req.method === 'POST' && req.url === '/api/responses') return '/v1/responses';
  const cancelMatch = req.method === 'POST' && req.url?.match(/^\/api\/responses\/([^/?#]+)\/cancel$/);
  if (cancelMatch) {
    const responseId = safeDecodeURIComponent(cancelMatch[1]);
    if (responseId === null) return null;
    return `/v1/responses/${encodeURIComponent(responseId)}/cancel`;
  }
  return null;
}

function getEncryptionKey() {
  if (!CONFIG_SECRET) return null;
  return createHash('sha256').update(CONFIG_SECRET).digest();
}

function normalizeApiBaseUrl(value) {
  const trimmed = String(value || '').trim();
  // Accept bare hostnames (e.g. "api.openai.com/v1") by defaulting to https.
  // Anything that already carries a scheme is left untouched so we can reject
  // unsupported protocols below rather than silently rewriting them.
  const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('API 地址必须是合法 URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('API 地址只支持 http 或 https');
  }

  parsed.hash = '';
  parsed.search = '';
  parsed.username = '';
  parsed.password = '';

  let pathname = parsed.pathname.replace(/\/+$/, '');
  if (pathname === '/v1') {
    pathname = '';
  } else if (pathname.endsWith('/v1')) {
    pathname = pathname.slice(0, -3) || '';
  }
  parsed.pathname = pathname || '/';

  return parsed.toString().replace(/\/+$/, '');
}

function validateApiBaseUrl(value) {
  return normalizeApiBaseUrl(value);
}

function buildUpstreamUrl(apiBaseUrl, upstreamPath) {
  const url = new URL(apiBaseUrl);
  const basePath = url.pathname.replace(/\/+$/, '');
  const nextPath = upstreamPath.replace(/^\/+/, '');
  url.pathname = `${basePath}/${nextPath}`.replace(/\/{2,}/g, '/');
  url.search = '';
  url.hash = '';
  return url.toString();
}

function encryptApiKey(apiKey) {
  const key = getEncryptionKey();
  if (!key) {
    throw new Error('服务端未设置 ZHIDA_CONFIG_SECRET，无法安全保存 API 密钥');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

function decryptApiKey(config) {
  const key = getEncryptionKey();
  if (!key) {
    throw new Error('服务端未设置 ZHIDA_CONFIG_SECRET，无法读取 API 密钥');
  }
  const decipher = createDecipheriv(
    ENCRYPTION_ALGORITHM,
    key,
    Buffer.from(config.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(config.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(config.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function parseStoredConfig(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || parsed.version !== CONFIG_VERSION || !parsed.apiBaseUrl) return null;
  if (!parsed.ciphertext || !parsed.iv || !parsed.authTag) return null;
  return parsed;
}

function shouldReadLegacyDockerConfig() {
  if (!CONFIG_PATH) return false;
  if (CONFIG_PATH === DOCKER_CONFIG_PATH) return true;
  return Boolean(process.env.LEGACY_DOCKER_CONFIG_PATH);
}

async function readStoredConfigFile(configPath) {
  return parseStoredConfig(await readFile(configPath, 'utf8'));
}

async function readStoredConfig() {
  try {
    return await readStoredConfigFile(CONFIG_PATH);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  if (!CONFIG_PATH_USES_DEFAULT) {
    if (!shouldReadLegacyDockerConfig()) return null;
    try {
      return await readStoredConfigFile(LEGACY_DOCKER_CONFIG_PATH);
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  }

  try {
    return await readStoredConfigFile(LEGACY_CONFIG_PATH);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

async function getProxyConfig() {
  const config = await readStoredConfig();
  if (!config) return null;
  return {
    apiBaseUrl: config.apiBaseUrl,
    apiKey: decryptApiKey(config),
  };
}

async function saveProxyConfig({ apiBaseUrl, apiKey }) {
  const normalizedUrl = validateApiBaseUrl(apiBaseUrl);
  const normalizedKey = String(apiKey || '').trim();
  if (!normalizedKey) {
    throw new Error('API 密钥不能为空');
  }
  const encrypted = encryptApiKey(normalizedKey);
  const payload = {
    version: CONFIG_VERSION,
    apiBaseUrl: normalizedUrl,
    ...encrypted,
    updatedAt: new Date().toISOString(),
  };
  await mkdir(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_PATH, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return payload;
}

function redactSecret(value, secret) {
  if (!secret) return value;
  return String(value).split(secret).join('[REDACTED]');
}

function isResponsesUnsupportedError(upstreamPath, status, rawError) {
  if (!upstreamPath.startsWith('/v1/responses')) return false;
  if (status === 500) {
    return /convert_request_failed|not implemented/i.test(rawError || '');
  }
  if (![400, 404, 405, 422, 501].includes(status)) return false;
  if ([404, 405, 501].includes(status)) return true;
  return /call_methods\s+must\s+include\s+responses|does\s+not\s+support\s+(this\s+)?api|responses\s+api|unsupported.*responses|responses.*unsupported|model.*responses/i
    .test(rawError || '');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateResponsesProxyPayload(rawBody) {
  let payload;
  try {
    payload = JSON.parse(rawBody || '{}');
  } catch {
    return { ok: false, message: 'Responses 请求体必须是合法 JSON' };
  }

  if (!isPlainObject(payload)) {
    return { ok: false, message: 'Responses 请求体必须是对象' };
  }

  for (const key of Object.keys(payload)) {
    if (!ALLOWED_RESPONSES_FIELDS.has(key)) {
      return { ok: false, message: 'Responses 请求包含不支持的字段' };
    }
  }

  if (typeof payload.model !== 'string' || !payload.model.trim()) {
    return { ok: false, message: 'Responses 请求缺少模型' };
  }
  if (!Object.hasOwn(payload, 'input')) {
    return { ok: false, message: 'Responses 请求缺少输入' };
  }
  if (Object.hasOwn(payload, 'stream') && typeof payload.stream !== 'boolean') {
    return { ok: false, message: 'Responses stream 必须是布尔值' };
  }
  if (Object.hasOwn(payload, 'max_output_tokens')) {
    const value = payload.max_output_tokens;
    if (!Number.isInteger(value) || value < 1 || value > Number.MAX_SAFE_INTEGER) {
      return { ok: false, message: 'Responses 最大输出 token 数无效' };
    }
  }
  if (Object.hasOwn(payload, 'reasoning')) {
    if (!isPlainObject(payload.reasoning)) {
      return { ok: false, message: 'Responses 推理参数无效' };
    }
    const keys = Object.keys(payload.reasoning);
    if (keys.length !== 1 || keys[0] !== 'effort' || !ALLOWED_REASONING_EFFORTS.has(payload.reasoning.effort)) {
      return { ok: false, message: 'Responses 推理深度无效' };
    }
  }
  if (Object.hasOwn(payload, 'tools')) {
    if (!Array.isArray(payload.tools)) {
      return { ok: false, message: 'Responses 工具参数无效' };
    }
    for (const tool of payload.tools) {
      if (!isPlainObject(tool) || tool.type !== 'web_search') {
        return { ok: false, message: 'Responses 请求包含不支持的工具' };
      }
      for (const key of Object.keys(tool)) {
        if (!ALLOWED_RESPONSES_TOOL_FIELDS.has(key)) {
          return { ok: false, message: 'Responses 网络搜索参数无效' };
        }
      }
      if (
        Object.hasOwn(tool, 'search_context_size')
        && !ALLOWED_WEB_SEARCH_CONTEXT_SIZES.has(tool.search_context_size)
      ) {
        return { ok: false, message: 'Responses 搜索范围无效' };
      }
    }
  }
  const hasWebSearch = Array.isArray(payload.tools)
    && payload.tools.some((tool) => isPlainObject(tool) && tool.type === 'web_search');
  if (
    hasWebSearch
    && payload.reasoning?.effort === 'minimal'
    && /^gpt-5($|-)/i.test(payload.model)
  ) {
    return { ok: false, message: 'Responses gpt-5 网络搜索不支持 minimal 推理深度' };
  }

  return { ok: true };
}

function getApiBodyLimit(req) {
  if (!req.url?.startsWith('/api/')) return null;
  const path = req.url.split('?')[0];
  if (path === '/api/config') return CONFIG_BODY_LIMIT_BYTES;
  if (path === '/api/web/search') return WEB_SEARCH_BODY_LIMIT_BYTES;
  if (path === '/api/chat/completions' || path === '/api/responses') {
    return PROXY_BODY_LIMIT_BYTES;
  }
  return OTHER_API_BODY_LIMIT_BYTES;
}

function contentLengthExceedsLimit(req, limitBytes) {
  const raw = req.headers['content-length'];
  if (raw === undefined) return false;
  const value = String(Array.isArray(raw) ? raw[0] : raw).trim();
  if (!/^\d+$/.test(value)) return false;
  return BigInt(value) > BigInt(limitBytes);
}

async function readRequestBody(req, limitBytes) {
  if (contentLengthExceedsLimit(req, limitBytes)) {
    throw new Error(REQUEST_BODY_TOO_LARGE);
  }

  return new Promise((resolveBody, rejectBody) => {
    let received = 0;
    let settled = false;
    const chunks = [];

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const rejectOnce = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectBody(err);
    };
    const onData = (chunk) => {
      received += chunk.length;
      if (received > limitBytes) {
        req.pause();
        rejectOnce(new Error(REQUEST_BODY_TOO_LARGE));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveBody(Buffer.concat(chunks));
    };
    const onError = (err) => rejectOnce(err);
    const onAborted = () => rejectOnce(new Error('client_closed'));

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

async function readJsonBody(req, limitBytes) {
  const rawBody = await readRequestBody(req, limitBytes);
  try {
    return JSON.parse(rawBody.toString('utf8') || '{}');
  } catch {
    throw new Error('请求体必须是合法 JSON');
  }
}

async function readRequestBodyWithLimit(req) {
  return readRequestBody(req, getApiBodyLimit(req) ?? OTHER_API_BODY_LIMIT_BYTES);
}

function handleRequestBodyReadError(req, res, err, fallbackMessage) {
  if (err?.message === REQUEST_BODY_TOO_LARGE) {
    sendRequestBodyTooLarge(req, res);
    return true;
  }
  if (fallbackMessage) {
    sendError(res, 400, fallbackMessage);
    return true;
  }
  return false;
}

function rejectOversizedApiRequest(req, res) {
  const limitBytes = getApiBodyLimit(req);
  if (limitBytes === null || !contentLengthExceedsLimit(req, limitBytes)) {
    return false;
  }
  sendRequestBodyTooLarge(req, res);
  return true;
}

async function handleConfigStatus(_req, res) {
  try {
    const config = await readStoredConfig();
    sendJson(res, 200, {
      configured: Boolean(config),
      apiBaseUrl: config?.apiBaseUrl ?? '',
      updatedAt: config?.updatedAt ?? null,
    });
  } catch {
    sendError(res, 500, '读取配置失败');
  }
}

async function handleConfigSave(req, res) {
  try {
    const body = await readJsonBody(req, CONFIG_BODY_LIMIT_BYTES);
    const saved = await saveProxyConfig(body);
    sendJson(res, 200, {
      configured: true,
      apiBaseUrl: saved.apiBaseUrl,
      updatedAt: saved.updatedAt,
    });
    logEvent('info', 'config_saved', {
      method: req.method,
      path: getRequestPath(req),
    });
  } catch (err) {
    if (handleRequestBodyReadError(req, res, err)) {
      return;
    }
    const message = err?.message || '保存配置失败';
    const status = message.includes('ZHIDA_CONFIG_SECRET') ? 500 : 400;
    sendError(res, status, message);
    logEvent('error', 'config_save_error', {
      method: req.method,
      path: getRequestPath(req),
      error: getErrorMessageForLog(err, '保存配置失败'),
    });
  }
}

function normalizeWebSearchPayload(payload) {
  if (!isPlainObject(payload)) {
    throw new Error('Web search 请求体必须是对象');
  }
  if (typeof payload.query !== 'string') {
    throw new Error('搜索查询不能为空');
  }
  const query = payload.query.trim();
  if (!query) {
    throw new Error('搜索查询不能为空');
  }
  if (query.length > WEB_SEARCH_QUERY_MAX_LENGTH) {
    throw new Error(`搜索查询不能超过 ${WEB_SEARCH_QUERY_MAX_LENGTH} 字`);
  }
  const contextSize = payload.contextSize ?? 'medium';
  if (!ALLOWED_WEB_SEARCH_CONTEXT_SIZES.has(contextSize)) {
    throw new Error('搜索范围无效');
  }
  return { query, contextSize };
}

function createEmptyWebSearchPayload(query) {
  return {
    query,
    results: [],
    citations: [],
  };
}

function getWebSearchLimits(contextSize) {
  return WEB_SEARCH_RESULT_LIMITS[contextSize] || WEB_SEARCH_RESULT_LIMITS.medium;
}

async function handleWebSearch(req, res) {
  const startedAt = Date.now();
  let query = '';
  try {
    const body = await readJsonBody(req, WEB_SEARCH_BODY_LIMIT_BYTES);
    const normalized = normalizeWebSearchPayload(body);
    query = normalized.query;

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error('web_search_timeout'));
    }, WEB_SEARCH_TIMEOUT_MS);
    timeout.unref?.();

    try {
      const payload = await performStandaloneWebSearch(normalized.query, normalized.contextSize, {
        signal: controller.signal,
      });
      sendJson(res, 200, payload);
      logEvent('info', 'web_search_done', {
        method: req.method,
        path: getRequestPath(req),
        query_length: normalized.query.length,
        context_size: normalized.contextSize,
        result_count: payload.results.length,
        duration_ms: Date.now() - startedAt,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    if (handleRequestBodyReadError(req, res, err)) {
      return;
    }
    if (
      err?.message === '请求体必须是合法 JSON'
      || err?.message === 'Web search 请求体必须是对象'
      || err?.message === '搜索查询不能为空'
      || err?.message === `搜索查询不能超过 ${WEB_SEARCH_QUERY_MAX_LENGTH} 字`
      || err?.message === '搜索范围无效'
    ) {
      sendError(res, 400, err.message);
      return;
    }

    logEvent('warn', 'web_search_failed', {
      method: req.method,
      path: getRequestPath(req),
      query_length: query.length || undefined,
      error: getErrorMessageForLog(err, 'web_search_failed'),
      duration_ms: Date.now() - startedAt,
    });
    sendJson(res, 200, createEmptyWebSearchPayload(query));
  }
}

async function performStandaloneWebSearch(query, contextSize, { signal } = {}) {
  const limits = getWebSearchLimits(contextSize);
  let searchResults = [];
  try {
    searchResults = await fetchSearchResults(query, limits.results, signal);
  } catch {
    return createEmptyWebSearchPayload(query);
  }

  const results = [];
  const seenUrls = new Set();
  for (const result of searchResults) {
    if (!result?.url || seenUrls.has(result.url)) continue;
    try {
      await assertPublicHttpUrl(new URL(result.url));
    } catch {
      continue;
    }
    seenUrls.add(result.url);
    results.push({
      title: result.title,
      url: result.url,
      snippet: result.snippet,
      text: '',
    });
    if (results.length >= limits.results) break;
  }

  const crawledResults = await Promise.all(results.slice(0, limits.pages).map(async (result) => {
    try {
      const raw = await fetchLimitedText(result.url, {
        signal,
        maxBytes: WEB_CRAWL_RESPONSE_MAX_BYTES,
        validateUrl: assertPublicHttpUrl,
      });
      return {
        result,
        text: extractPageText(raw).slice(0, WEB_SEARCH_PAGE_TEXT_MAX_CHARS),
      };
    } catch {
      return { result, text: '' };
    }
  }));

  let totalTextChars = 0;
  for (const { result, text } of crawledResults) {
    if (!text || totalTextChars >= WEB_SEARCH_TOTAL_TEXT_MAX_CHARS) {
      result.text = '';
      continue;
    }
    const remaining = WEB_SEARCH_TOTAL_TEXT_MAX_CHARS - totalTextChars;
    result.text = text.slice(0, remaining);
    totalTextChars += result.text.length;
  }

  return {
    query,
    results,
    citations: results.map((result) => ({
      title: result.title || result.url,
      url: result.url,
    })),
  };
}

async function fetchSearchResults(query, limit, signal) {
  const searchUrl = new URL(WEB_SEARCH_PROVIDER_URL);
  searchUrl.searchParams.set('q', query);
  const html = await fetchLimitedText(searchUrl.toString(), {
    signal,
    maxBytes: WEB_SEARCH_RESPONSE_MAX_BYTES,
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': WEB_SEARCH_USER_AGENT,
    },
  });
  return parseSearchResultsHtml(html, limit);
}

async function fetchLimitedText(url, options = {}) {
  const {
    signal,
    maxBytes,
    headers = {},
    validateUrl,
    maxRedirects = 3,
  } = options;
  let current = new URL(url);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const requestHeaders = {
      Accept: 'text/html,text/plain,application/xhtml+xml,application/xml;q=0.8,*/*;q=0.2',
      'User-Agent': WEB_SEARCH_USER_AGENT,
      ...headers,
    };
    const validation = validateUrl ? await validateUrl(current) : null;
    const response = validation
      ? await fetchResolvedPublicText(current, validation, {
        signal,
        maxBytes,
        headers: requestHeaders,
      })
      : await fetch(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: requestHeaders,
      });

    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      if (redirectCount === maxRedirects) throw new Error('too_many_redirects');
      current = new URL(response.headers.get('location'), current);
      continue;
    }

    if (!response.ok) {
      throw new Error(`fetch_failed_${response.status}`);
    }
    return typeof response.text === 'string'
      ? response.text
      : readResponseTextLimited(response, maxBytes);
  }

  throw new Error('too_many_redirects');
}

function getHeader(headers, name) {
  const value = headers?.[name.toLowerCase()] ?? headers?.[name];
  if (Array.isArray(value)) return value.join(', ');
  return value === undefined ? null : String(value);
}

function getTestFetchLimitedText() {
  if (process.env.ZHIDA_ENABLE_TEST_FETCH_FIXTURES !== '1') return null;
  return typeof globalThis.__ZHIDA_TEST_FETCH_LIMITED_TEXT === 'function'
    ? globalThis.__ZHIDA_TEST_FETCH_LIMITED_TEXT
    : null;
}

function fetchResolvedPublicText(url, validation, { signal, maxBytes, headers = {} } = {}) {
  const parsed = url instanceof URL ? url : new URL(String(url));
  const address = validation?.addresses?.[0];
  if (!address) throw new Error('host_not_resolvable');
  const testFetchLimitedText = getTestFetchLimitedText();
  if (testFetchLimitedText) {
    return testFetchLimitedText(parsed.toString(), {
      signal,
      maxBytes,
      headers,
    });
  }

  const isHttps = parsed.protocol === 'https:';
  const requestFn = isHttps ? httpsRequest : httpRequest;
  const requestHeaders = {
    ...headers,
    Host: parsed.host,
  };

  return new Promise((resolveFetch, rejectFetch) => {
    const req = requestFn({
      hostname: address.address,
      family: address.family,
      port: parsed.port || (isHttps ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      headers: requestHeaders,
      servername: parsed.hostname,
      signal,
    }, (res) => {
      const chunks = [];
      let totalBytes = 0;
      let settled = false;
      const rejectOnce = (err) => {
        if (settled) return;
        settled = true;
        req.destroy(err);
        rejectFetch(err);
      };

      res.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (Number.isFinite(maxBytes) && totalBytes > maxBytes) {
          rejectOnce(new Error('response_too_large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        const status = res.statusCode || 0;
        resolveFetch({
          status,
          ok: status >= 200 && status < 300,
          headers: {
            get(name) {
              return getHeader(res.headers, name);
            },
          },
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
      res.on('error', rejectOnce);
    });

    req.on('error', rejectFetch);
    req.end();
  });
}

async function readResponseTextLimited(response, maxBytes) {
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.length;
      if (totalBytes > maxBytes) {
        throw new Error('response_too_large');
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  return chunks.join('');
}

function parseSearchResultsHtml(html, limit) {
  const results = [];
  const seenUrls = new Set();
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(html)) && results.length < limit) {
    const attrs = match[1] || '';
    const className = getHtmlAttribute(attrs, 'class');
    if (!/\bresult__a\b/.test(className)) continue;

    const rawHref = getHtmlAttribute(attrs, 'href');
    const url = normalizeSearchResultUrl(rawHref);
    if (!url || seenUrls.has(url)) continue;

    seenUrls.add(url);
    const snippet = extractSnippetNear(html, anchorPattern.lastIndex);
    results.push({
      title: cleanHtmlText(match[2]).slice(0, 200) || url,
      url,
      snippet: snippet.slice(0, 500),
    });
  }
  return results;
}

function extractSnippetNear(html, startIndex) {
  const segment = html.slice(startIndex, startIndex + 2500);
  const snippetMatch = segment.match(/<[^>]+\bclass=(["'])[^"']*(?:result__snippet|result-snippet|snippet)[^"']*\1[^>]*>([\s\S]*?)<\/(?:a|div|span|p)>/i);
  return snippetMatch ? cleanHtmlText(snippetMatch[2]) : '';
}

function getHtmlAttribute(attrs, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i');
  const match = attrs.match(pattern);
  return match ? decodeHtmlEntities(match[2]) : '';
}

function normalizeSearchResultUrl(rawHref) {
  const href = decodeHtmlEntities(String(rawHref || '').trim());
  if (!href) return '';
  try {
    const parsed = new URL(href, WEB_SEARCH_PROVIDER_URL);
    if (parsed.pathname === '/l/' && parsed.searchParams.get('uddg')) {
      return new URL(parsed.searchParams.get('uddg')).toString();
    }
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function cleanHtmlText(value) {
  return decodeHtmlEntities(String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function extractPageText(html) {
  return cleanHtmlText(String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<\/(p|div|section|article|main|header|footer|li|h[1-6])>/gi, '\n'));
}

function decodeHtmlEntities(value) {
  const entities = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const normalized = entity.toLowerCase();
    if (normalized.startsWith('#x')) {
      const codePoint = Number.parseInt(normalized.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (normalized.startsWith('#')) {
      const codePoint = Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return entities[normalized] ?? match;
  });
}

async function assertPublicHttpUrl(url) {
  const parsed = url instanceof URL ? url : new URL(String(url));
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('unsupported_url_protocol');
  }
  if (parsed.username || parsed.password) {
    throw new Error('url_credentials_not_allowed');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('private_url_not_allowed');
  }

  const version = isIP(hostname);
  if (version) {
    if (!isPublicIpAddress(hostname, version)) throw new Error('private_url_not_allowed');
    return { url: parsed, addresses: [{ address: hostname, family: version }] };
  }

  const addresses = await lookup(hostname, { all: true, verbatim: false });
  if (addresses.length === 0) throw new Error('host_not_resolvable');
  for (const address of addresses) {
    if (!isPublicIpAddress(address.address, address.family)) {
      throw new Error('private_url_not_allowed');
    }
  }
  return { url: parsed, addresses };
}

function isPublicIpAddress(address, family) {
  if (family === 4 || isIP(address) === 4) return isPublicIpv4(address);
  if (family === 6 || isIP(address) === 6) return isPublicIpv6(address);
  return false;
}

function isPublicIpv4(address) {
  const parts = address.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isPublicIpv6(address) {
  const normalized = address.toLowerCase();
  if (
    normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe80:')
    || normalized.startsWith('ff')
    || normalized.startsWith('2001:db8')
  ) {
    return false;
  }
  if (normalized.startsWith('::ffff:')) {
    return isPublicIpv4(normalized.slice('::ffff:'.length));
  }
  return true;
}

function getAbortError(signal) {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted');
}

function waitForDrainOrAbort(res, signal) {
  return new Promise((resolveDrain, rejectDrain) => {
    if (signal.aborted) {
      rejectDrain(getAbortError(signal));
      return;
    }

    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onDrain = () => {
      cleanup();
      resolveDrain();
    };
    const onClose = () => {
      cleanup();
      rejectDrain(new Error('client_closed'));
    };
    const onError = (err) => {
      cleanup();
      rejectDrain(err);
    };
    const onAbort = () => {
      cleanup();
      rejectDrain(getAbortError(signal));
    };

    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function responseCannotBeWritten(res, signal) {
  return res.destroyed || res.writableEnded || signal.aborted;
}

function readUpstreamChunk(reader, signal) {
  return new Promise((resolveRead, rejectRead) => {
    if (signal.aborted) {
      rejectRead(getAbortError(signal));
      return;
    }

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      rejectRead(getAbortError(signal));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (result) => {
        cleanup();
        resolveRead(result);
      },
      (err) => {
        cleanup();
        rejectRead(err);
      }
    );
  });
}

async function handleProxy(req, res, upstreamPath) {
  const startedAt = Date.now();
  let proxyTerminalLogged = false;
  const durationMs = () => Date.now() - startedAt;
  const proxyLogFields = (fields = {}) => ({
    method: req.method,
    path: getRequestPath(req),
    upstream_path: upstreamPath,
    ...fields,
  });
  const logProxyDone = (status) => {
    if (proxyTerminalLogged) return;
    proxyTerminalLogged = true;
    logEvent('info', 'proxy_done', proxyLogFields({
      status,
      duration_ms: durationMs(),
    }));
  };
  const logProxyAbort = (reason) => {
    if (proxyTerminalLogged) return;
    proxyTerminalLogged = true;
    logEvent('warn', 'proxy_abort', proxyLogFields({
      reason,
      duration_ms: durationMs(),
    }));
  };
  const logProxyError = (error, status, ...secrets) => {
    if (proxyTerminalLogged) return;
    proxyTerminalLogged = true;
    const fields = proxyLogFields({
      error: error instanceof Error
        ? getErrorMessageForLog(error, '上游请求失败', ...secrets)
        : sanitizeLogMessage(error || '上游请求失败', ...secrets),
      duration_ms: durationMs(),
    });
    if (status !== undefined) fields.status = status;
    logEvent('error', 'proxy_error', fields);
  };
  logEvent('info', 'proxy_start', proxyLogFields());

  let proxyConfig;
  try {
    proxyConfig = await getProxyConfig();
  } catch (err) {
    logProxyError(err, undefined);
    proxyConfigError(res, err?.message || '代理配置读取失败');
    return;
  }
  if (!proxyConfig?.apiBaseUrl || !proxyConfig?.apiKey) {
    logProxyError('代理未配置');
    proxyConfigError(res);
    return;
  }

  const controller = new AbortController();
  let timeout = null;
  let completed = false;
  let abortReason = null;
  let upstreamReader = null;
  let upstreamReaderCancelRequested = false;

  const cancelUpstreamReader = (reason) => {
    if (!upstreamReader || upstreamReaderCancelRequested) return;
    upstreamReaderCancelRequested = true;
    try {
      upstreamReader.cancel(reason).catch(() => {});
    } catch {
      // Best-effort cancellation only.
    }
  };

  const abortProxy = (reason) => {
    if (completed || controller.signal.aborted) return;
    abortReason = reason;
    logProxyAbort(reason);
    const err = new Error(reason);
    controller.abort(err);
    cancelUpstreamReader(err);
  };
  const refreshTimeout = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => abortProxy('proxy_timeout'), PROXY_TIMEOUT_MS);
    timeout.unref?.();
  };
  const abortClientClosed = () => abortProxy('client_closed');
  const cleanupProxyAbort = () => {
    completed = true;
    clearTimeout(timeout);
    req.off('aborted', abortClientClosed);
    res.off('close', abortClientClosed);
  };

  req.on('aborted', abortClientClosed);
  res.on('close', abortClientClosed);
  refreshTimeout();

  const upstreamHeaders = {
    Authorization: `Bearer ${proxyConfig.apiKey}`,
    Accept: req.headers.accept || 'application/json, text/event-stream',
  };

  const fetchOptions = {
    method: req.method,
    headers: upstreamHeaders,
    signal: controller.signal,
  };

  try {
    if (req.method === 'POST') {
      try {
        const rawBody = await readRequestBodyWithLimit(req);
        refreshTimeout();
        if (upstreamPath === '/v1/responses') {
          const validation = validateResponsesProxyPayload(rawBody);
          if (!validation.ok) {
            completed = true;
            sendJson(res, 400, { error: { message: validation.message } });
            return;
          }
        }
        fetchOptions.body = rawBody;
        upstreamHeaders['Content-Type'] = req.headers['content-type'] || 'application/json';
      } catch (err) {
        if (abortReason === 'client_closed') return;
        completed = true;
        if (err?.message === REQUEST_BODY_TOO_LARGE) {
          logProxyAbort('request_body_too_large');
        } else {
          logProxyError(err);
        }
        if (handleRequestBodyReadError(req, res, err, '读取请求体失败')) {
          return;
        }
      }
    }

    const upstream = await fetch(buildUpstreamUrl(proxyConfig.apiBaseUrl, upstreamPath), fetchOptions);
    refreshTimeout();

    if (!upstream.ok) {
      const rawError = await upstream.text().catch(() => '');
      const redacted = redactSecret(rawError, proxyConfig.apiKey);
      const responsesUnsupported = isResponsesUnsupportedError(upstreamPath, upstream.status, rawError);
      const message = responsesUnsupported
        ? '当前 API 服务不支持 Responses API，无法使用网络搜索/推理深度'
        : redacted && redacted.length <= 500
        ? redacted
        : `上游请求失败 (${upstream.status})`;
      completed = true;
      logProxyError(message, upstream.status, proxyConfig.apiKey);
      sendJson(res, upstream.status, { error: { message } });
      return;
    }

    if (!upstream.body) {
      completed = true;
      if (responseCannotBeWritten(res, controller.signal)) return;
      logProxyDone(upstream.status);
      res.end();
      return;
    }

    upstreamReader = upstream.body.getReader();
    if (responseCannotBeWritten(res, controller.signal)) {
      completed = true;
      cancelUpstreamReader(getAbortError(controller.signal));
      return;
    }

    const headers = withSecurityHeaders({
      'Cache-Control': NO_STORE_CACHE_CONTROL,
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
    });
    if (upstreamPath === '/v1/chat/completions' || upstreamPath.startsWith('/v1/responses')) {
      headers.Connection = 'keep-alive';
      headers['X-Accel-Buffering'] = 'no';
    }
    if (responseCannotBeWritten(res, controller.signal)) {
      completed = true;
      cancelUpstreamReader(getAbortError(controller.signal));
      return;
    }
    res.writeHead(upstream.status, headers);

    try {
      while (true) {
        const { done, value } = await readUpstreamChunk(upstreamReader, controller.signal);
        if (done) break;
        refreshTimeout();
        if (responseCannotBeWritten(res, controller.signal)) {
          cancelUpstreamReader(getAbortError(controller.signal));
          break;
        }
        if (!res.write(Buffer.from(value))) {
          await waitForDrainOrAbort(res, controller.signal);
          refreshTimeout();
        }
      }
      completed = true;
      if (!responseCannotBeWritten(res, controller.signal)) {
        logProxyDone(upstream.status);
        res.end();
      }
    } catch (err) {
      cancelUpstreamReader(err);
      throw err;
    } finally {
      try {
        upstreamReader?.releaseLock();
      } catch {
        // Ignore pending-read release failures after hard cancellation.
      }
      upstreamReader = null;
    }
  } catch (err) {
    cancelUpstreamReader(err);
    if (abortReason === 'client_closed') return;
    if (res.headersSent) {
      completed = true;
      logProxyError(err);
      res.destroy(err);
      return;
    }
    completed = true;
    if (handleRequestBodyReadError(req, res, err)) {
      return;
    }
    if (err?.message === 'proxy_timeout' || err?.name === 'AbortError') {
      logProxyAbort('proxy_timeout');
      sendError(res, 504, '上游请求超时');
      return;
    }
    logProxyError(err);
    sendError(res, 502, '上游请求失败');
  } finally {
    cleanupProxyAbort();
  }
}

async function resolveStaticPath(urlPath) {
  let decoded = '';
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.split('/').some((part) => part.startsWith('.'))) {
    return null;
  }

  const pathname = decoded === '/' ? '/index.html' : `/${decoded.replace(/^\/+/, '')}`;
  if (!isAllowedStaticPath(pathname)) {
    return null;
  }

  const relativePath = pathname.replace(/^\/+/, '');
  const candidate = normalize(join(ROOT_DIR, relativePath));
  if (candidate !== ROOT_DIR && !candidate.startsWith(ROOT_DIR + sep)) {
    return null;
  }

  try {
    const info = await stat(candidate);
    if (info.isDirectory()) return join(candidate, 'index.html');
    if (info.isFile()) return candidate;
  } catch {
    return null;
  }
  return null;
}

function isAllowedStaticPath(pathname) {
  return pathname === '/index.html'
    || pathname.startsWith('/css/')
    || pathname.startsWith('/js/')
    || pathname.startsWith('/assets/')
    || pathname.startsWith('/vendor/')
    || (ENABLE_TEST_ROUTES && pathname === '/tests/smoke.html');
}

function isCacheableStaticAsset(filePath) {
  return extname(filePath).toLowerCase() !== '.html';
}

function isSmokeTestPage(filePath) {
  return filePath === join(ROOT_DIR, 'tests/smoke.html');
}

function getStaticSecurityHeaders(filePath) {
  if (!ENABLE_TEST_ROUTES) return SECURITY_HEADERS;
  if (isSmokeTestPage(filePath)) return SMOKE_TEST_SECURITY_HEADERS;
  return TEST_FRAME_SECURITY_HEADERS;
}

function createStaticEtag(info) {
  return `W/"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`;
}

function getStaticCacheHeaders(filePath, info) {
  const headers = {
    'Cache-Control': isCacheableStaticAsset(filePath)
      ? STATIC_ASSET_CACHE_CONTROL
      : NO_STORE_CACHE_CONTROL,
  };
  if (isCacheableStaticAsset(filePath)) {
    headers.ETag = createStaticEtag(info);
    headers['Last-Modified'] = info.mtime.toUTCString();
  }
  return headers;
}

function getHeaderValue(headers, name) {
  const value = headers[name];
  if (Array.isArray(value)) return value.join(',');
  return value === undefined ? '' : String(value);
}

function ifNoneMatchIncludes(headers, etag) {
  const value = getHeaderValue(headers, 'if-none-match');
  if (!value) return false;
  return value.split(',').some((candidate) => {
    const trimmed = candidate.trim();
    return trimmed === '*' || trimmed === etag;
  });
}

function ifModifiedSinceMatches(headers, info) {
  const value = getHeaderValue(headers, 'if-modified-since');
  if (!value) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  return Math.floor(info.mtimeMs / 1000) * 1000 <= parsed;
}

function isNotModifiedRequest(req, filePath, etag, info) {
  if (!isCacheableStaticAsset(filePath)) return false;
  const ifNoneMatch = getHeaderValue(req.headers, 'if-none-match');
  if (ifNoneMatch) return ifNoneMatchIncludes(req.headers, etag);
  return ifModifiedSinceMatches(req.headers, info);
}

async function handleStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
    return;
  }

  const filePath = await resolveStaticPath(req.url || '/');
  if (!filePath) {
    logNotFound(req);
    sendJson(res, 404, { error: { message: 'Not Found' } });
    return;
  }

  let info;
  try {
    info = statSync(filePath);
  } catch {
    logNotFound(req);
    sendJson(res, 404, { error: { message: 'Not Found' } });
    return;
  }

  const ext = extname(filePath).toLowerCase();
  const cacheHeaders = getStaticCacheHeaders(filePath, info);
  const securityHeaders = getStaticSecurityHeaders(filePath);
  if (cacheHeaders.ETag && isNotModifiedRequest(req, filePath, cacheHeaders.ETag, info)) {
    res.writeHead(304, withSecurityHeaders(cacheHeaders, securityHeaders));
    res.end();
    return;
  }

  res.writeHead(200, withSecurityHeaders({
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Content-Length': info.size,
    ...cacheHeaders,
  }, securityHeaders));

  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

async function getStartupConfigStatus() {
  try {
    return await readStoredConfig() ? 'configured' : 'not';
  } catch {
    return 'not';
  }
}

export function createZhidaServer() {
  return createServer((req, res) => {
    logEvent('info', 'request', {
      method: req.method,
      path: getRequestPath(req),
    });
    if (rejectUntrustedBrowserApiRequest(req, res)) {
      return;
    }
    if (rejectOversizedApiRequest(req, res)) {
      return;
    }
    if (req.method === 'GET' && req.url === '/api/config/status') {
      handleConfigStatus(req, res);
      return;
    }
    if (req.method === 'PUT' && req.url === '/api/config') {
      handleConfigSave(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/web/search') {
      handleWebSearch(req, res);
      return;
    }
    const upstreamPath = getUpstreamPath(req);
    if (upstreamPath) {
      handleProxy(req, res, upstreamPath);
      return;
    }
    if (req.url?.startsWith('/api/')) {
      logNotFound(req);
      sendJson(res, 404, { error: { message: 'Not Found' } });
      return;
    }
    handleStatic(req, res);
  });
}

export async function startServer({ host = HOST, port = PORT, logStart = true } = {}) {
  const server = createZhidaServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });

  if (logStart) {
    const address = server.address();
    logEvent('info', 'server_start', {
      port: typeof address === 'object' && address ? address.port : port,
      config_status: await getStartupConfigStatus(),
    });
  }

  return server;
}

export async function stopServer(server) {
  if (!server?.listening) return;
  await new Promise((resolveClose, rejectClose) => {
    server.close((err) => {
      if (err) {
        rejectClose(err);
        return;
      }
      resolveClose();
    });
  });
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  startServer().catch((err) => {
    logEvent('error', 'server_start_error', {
      error: getErrorMessageForLog(err),
    });
    process.exit(1);
  });
}
