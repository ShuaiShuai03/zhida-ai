#!/usr/bin/env node

import { createReadStream, statSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');

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
const ENABLE_TEST_ROUTES = process.env.ZHIDA_ENABLE_TEST_ROUTES === '1';
const CONFIG_VERSION = 1;
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const REQUEST_BODY_TOO_LARGE = 'request_body_too_large';

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
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: { message } });
}

function sendRequestBodyTooLarge(req, res) {
  const socket = req.socket;
  const payload = JSON.stringify({ error: 'Request body too large' });
  res.writeHead(413, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'close',
    'Content-Length': Buffer.byteLength(payload),
  });
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
  const raw = String(value || '').trim();
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
  if (![400, 404, 405, 422, 501].includes(status)) return false;
  if ([404, 405, 501].includes(status)) return true;
  return /call_methods\s+must\s+include\s+responses|does\s+not\s+support\s+(this\s+)?api|responses\s+api|unsupported.*responses|responses.*unsupported|model.*responses/i
    .test(rawError || '');
}

function getApiBodyLimit(req) {
  if (!req.url?.startsWith('/api/')) return null;
  const path = req.url.split('?')[0];
  if (path === '/api/config') return CONFIG_BODY_LIMIT_BYTES;
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
  } catch (err) {
    if (handleRequestBodyReadError(req, res, err)) {
      return;
    }
    const message = err?.message || '保存配置失败';
    const status = message.includes('ZHIDA_CONFIG_SECRET') ? 500 : 400;
    sendError(res, status, message);
  }
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
  let proxyConfig;
  try {
    proxyConfig = await getProxyConfig();
  } catch (err) {
    proxyConfigError(res, err?.message || '代理配置读取失败');
    return;
  }
  if (!proxyConfig?.apiBaseUrl || !proxyConfig?.apiKey) {
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
        fetchOptions.body = await readRequestBodyWithLimit(req);
        refreshTimeout();
        upstreamHeaders['Content-Type'] = req.headers['content-type'] || 'application/json';
      } catch (err) {
        if (abortReason === 'client_closed') return;
        completed = true;
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
      sendJson(res, upstream.status, { error: { message } });
      return;
    }

    if (!upstream.body) {
      completed = true;
      if (responseCannotBeWritten(res, controller.signal)) return;
      res.end();
      return;
    }

    upstreamReader = upstream.body.getReader();
    if (responseCannotBeWritten(res, controller.signal)) {
      completed = true;
      cancelUpstreamReader(getAbortError(controller.signal));
      return;
    }

    const headers = {
      'Cache-Control': 'no-store',
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
    };
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
      res.destroy(err);
      return;
    }
    completed = true;
    if (handleRequestBodyReadError(req, res, err)) {
      return;
    }
    if (err?.message === 'proxy_timeout' || err?.name === 'AbortError') {
      sendError(res, 504, '上游请求超时');
      return;
    }
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
    || (ENABLE_TEST_ROUTES && pathname === '/tests/smoke.html');
}

async function handleStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
    return;
  }

  const filePath = await resolveStaticPath(req.url || '/');
  if (!filePath) {
    sendJson(res, 404, { error: { message: 'Not Found' } });
    return;
  }

  let info;
  try {
    info = statSync(filePath);
  } catch {
    sendJson(res, 404, { error: { message: 'Not Found' } });
    return;
  }

  const ext = extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Content-Length': info.size,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

const server = createServer((req, res) => {
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
  const upstreamPath = getUpstreamPath(req);
  if (upstreamPath) {
    handleProxy(req, res, upstreamPath);
    return;
  }
  if (req.url?.startsWith('/api/')) {
    sendJson(res, 404, { error: { message: 'Not Found' } });
    return;
  }
  handleStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Zhida AI listening on http://${HOST}:${PORT}`);
});
