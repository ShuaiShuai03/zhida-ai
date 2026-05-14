#!/usr/bin/env node

import { createReadStream, statSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');
const PORT = Number.parseInt(process.env.ZHIDA_PORT || '3000', 10);
const CONFIG_PATH = resolve(process.env.ZHIDA_CONFIG_PATH || join(__dirname, 'data/config.enc.json'));
const CONFIG_SECRET = process.env.ZHIDA_CONFIG_SECRET || '';
const PROXY_TIMEOUT_MS = Number.parseInt(process.env.ZHIDA_PROXY_TIMEOUT_MS || '120000', 10);
const MAX_PROXY_BODY_BYTES = Number.parseInt(process.env.ZHIDA_PROXY_MAX_BODY_BYTES || String(10 * 1024 * 1024), 10);
const CONFIG_VERSION = 1;
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';

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

function proxyConfigError(res, message = '代理未配置：请先在设置中保存 API 地址和密钥') {
  sendError(res, 500, message);
}

function getUpstreamPath(req) {
  if (req.method === 'GET' && req.url === '/api/models') return '/v1/models';
  if (req.method === 'POST' && req.url === '/api/chat/completions') return '/v1/chat/completions';
  if (req.method === 'POST' && req.url === '/api/responses') return '/v1/responses';
  const cancelMatch = req.method === 'POST' && req.url?.match(/^\/api\/responses\/([^/?#]+)\/cancel$/);
  if (cancelMatch) return `/v1/responses/${encodeURIComponent(decodeURIComponent(cancelMatch[1]))}/cancel`;
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

async function readStoredConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== CONFIG_VERSION || !parsed.apiBaseUrl) return null;
    if (!parsed.ciphertext || !parsed.iv || !parsed.authTag) return null;
    return parsed;
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

async function readJsonBody(req) {
  const contentLength = Number.parseInt(req.headers['content-length'] || '0', 10);
  if (contentLength > MAX_PROXY_BODY_BYTES) {
    throw new Error('请求体过大');
  }
  let received = 0;
  const chunks = [];
  for await (const chunk of req) {
    received += chunk.length;
    if (received > MAX_PROXY_BODY_BYTES) {
      throw new Error('请求体过大');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new Error('请求体必须是合法 JSON');
  }
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
    const body = await readJsonBody(req);
    const saved = await saveProxyConfig(body);
    sendJson(res, 200, {
      configured: true,
      apiBaseUrl: saved.apiBaseUrl,
      updatedAt: saved.updatedAt,
    });
  } catch (err) {
    const message = err?.message || '保存配置失败';
    const status = message.includes('ZHIDA_CONFIG_SECRET') ? 500 : 400;
    sendError(res, status, message);
  }
}

async function readRequestBodyWithLimit(req) {
  const contentLength = Number.parseInt(req.headers['content-length'] || '0', 10);
  if (contentLength > MAX_PROXY_BODY_BYTES) {
    throw new Error('request_body_too_large');
  }

  let received = 0;
  const chunks = [];
  for await (const chunk of req) {
    received += chunk.length;
    if (received > MAX_PROXY_BODY_BYTES) {
      throw new Error('request_body_too_large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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
  const timeout = setTimeout(() => controller.abort(new Error('proxy_timeout')), PROXY_TIMEOUT_MS);
  const upstreamHeaders = {
    Authorization: `Bearer ${proxyConfig.apiKey}`,
    Accept: req.headers.accept || 'application/json, text/event-stream',
  };

  const fetchOptions = {
    method: req.method,
    headers: upstreamHeaders,
    signal: controller.signal,
  };

  if (req.method === 'POST') {
    try {
      fetchOptions.body = await readRequestBodyWithLimit(req);
      upstreamHeaders['Content-Type'] = req.headers['content-type'] || 'application/json';
    } catch (err) {
      clearTimeout(timeout);
      if (err?.message === 'request_body_too_large') {
        sendError(res, 413, '请求体过大');
        return;
      }
      sendError(res, 400, '读取请求体失败');
      return;
    }
  }

  try {
    const upstream = await fetch(buildUpstreamUrl(proxyConfig.apiBaseUrl, upstreamPath), fetchOptions);
    clearTimeout(timeout);

    if (!upstream.ok) {
      const rawError = await upstream.text().catch(() => '');
      const redacted = redactSecret(rawError, proxyConfig.apiKey);
      const responsesUnsupported = isResponsesUnsupportedError(upstreamPath, upstream.status, rawError);
      const message = responsesUnsupported
        ? '当前 API 服务不支持 Responses API，无法使用网络搜索/推理深度'
        : redacted && redacted.length <= 500
        ? redacted
        : `上游请求失败 (${upstream.status})`;
      sendJson(res, upstream.status, { error: { message } });
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
    res.writeHead(upstream.status, headers);

    if (!upstream.body) {
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise((resolveDrain) => res.once('drain', resolveDrain));
        }
      }
      res.end();
    } finally {
      reader.releaseLock();
    }
  } catch (err) {
    clearTimeout(timeout);
    if (res.headersSent) {
      res.destroy(err);
      return;
    }
    if (err?.message === 'request_body_too_large') {
      sendError(res, 413, '请求体过大');
      return;
    }
    if (err?.message === 'proxy_timeout' || err?.name === 'AbortError') {
      sendError(res, 504, '上游请求超时');
      return;
    }
    sendError(res, 502, '上游请求失败');
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

  const relativePath = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const candidate = normalize(join(ROOT_DIR, relativePath));
  if (candidate !== ROOT_DIR && !candidate.startsWith(ROOT_DIR + sep)) {
    return null;
  }

  try {
    const info = await stat(candidate);
    if (info.isDirectory()) return join(candidate, 'index.html');
    if (info.isFile()) return candidate;
  } catch {
    return join(ROOT_DIR, 'index.html');
  }
  return null;
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Zhida AI listening on http://0.0.0.0:${PORT}`);
});
