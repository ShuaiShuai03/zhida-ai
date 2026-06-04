import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  return port;
}

async function waitForUrl(url) {
  for (let i = 0; i < 50; i += 1) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      await delay(100);
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForCondition(predicate, label, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function startProxy(env) {
  const child = spawn(process.execPath, [join(process.cwd(), 'server/server.js')], {
    cwd: process.cwd(),
    env: { ...process.env, ZHIDA_ENABLE_TEST_ROUTES: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

function collectChildOutput(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  return () => ({ stdout, stderr });
}

function closeChild(child) {
  if (!child.killed) child.kill();
}

async function closeServer(server) {
  if (!server.listening) return;
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

async function sendRawRequest(port, { method, path, headers = {}, chunks = [] }) {
  return new Promise((resolveRequest, rejectRequest) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      method,
      path,
      headers,
    }, (res) => {
      const responseChunks = [];
      res.on('data', (chunk) => responseChunks.push(chunk));
      res.on('end', () => {
        resolveRequest({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(responseChunks).toString('utf8'),
        });
      });
    });
    req.on('error', rejectRequest);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

async function runProxyExpectingExit(env) {
  const child = startProxy(env);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const timeout = setTimeout(() => {
    if (!child.killed) child.kill();
  }, 3000);
  try {
    const [code, signal] = await once(child, 'exit');
    return { code, signal, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

function makeEncryptedConfigPayload(secret, { apiBaseUrl, apiKey }) {
  const key = createHash('sha256').update(String(secret)).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(apiKey || ''), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    version: 1,
    apiBaseUrl: String(apiBaseUrl || ''),
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    updatedAt: new Date().toISOString(),
  };
}

async function writeEncryptedConfig(filePath, secret, apiBaseUrl, apiKey = 'legacy-secret') {
  const payload = makeEncryptedConfigPayload(secret, { apiBaseUrl, apiKey });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

function makeVisionChatPayload(base64Bytes = 2 * 1024 * 1024) {
  return JSON.stringify({
    model: 'gpt-test',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'describe this image' },
        {
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${'a'.repeat(base64Bytes)}`,
          },
        },
      ],
    }],
    stream: true,
  });
}

async function startMockApi() {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({
      url: req.url,
      method: req.method,
      authorization: req.headers.authorization,
      body: null,
    });
    const currentRequest = requests.at(-1);

    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'proxy-standard', owned_by: 'mock' }] }));
      return;
    }

    if (req.url === '/v1/chat/completions') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8') || '{}';
        currentRequest.body = rawBody;
        const payload = JSON.parse(rawBody);
        if (payload.force_error) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `bad key ${req.headers.authorization}` } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"proxy "}}]}\n\n');
        res.end('data: [DONE]\n\n');
      });
      return;
    }

    if (req.url === '/v1/responses') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        currentRequest.body = Buffer.concat(chunks).toString('utf8') || '{}';
        const payload = JSON.parse(currentRequest.body || '{}');
        if (payload.force_responses_unsupported) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `call_methods must include responses ${req.headers.authorization}` } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: response.created\ndata: {"id":"resp_test_1"}\n\n');
        res.write('event: response.output_text.delta\ndata: {"delta":"response proxy"}\n\n');
        res.end('event: response.completed\ndata: {"response":{"output":[]}}\n\n');
      });
      return;
    }

    if (req.url === '/v1/responses/resp_test_1/cancel') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'resp_test_1', status: 'cancelled' }));
      return;
    }

    res.writeHead(404);
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: server.address().port, requests };
}

async function startStreamingMockApi() {
  const intervals = new Set();
  const activeResponses = new Set();
  let streamClosed = false;
  let chunksWritten = 0;

  const server = createServer((req, res) => {
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404);
      res.end();
      return;
    }

    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      activeResponses.add(res);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      chunksWritten += 1;
      res.write('data: {"choices":[{"delta":{"content":"start"}}]}\n\n');

      const interval = setInterval(() => {
        chunksWritten += 1;
        res.write(`data: {"choices":[{"delta":{"content":"${chunksWritten}"}}]}\n\n`);
      }, 50);
      intervals.add(interval);

      res.on('close', () => {
        streamClosed = true;
        clearInterval(interval);
        intervals.delete(interval);
        activeResponses.delete(res);
      });
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    server,
    port: server.address().port,
    get streamClosed() {
      return streamClosed;
    },
    get chunksWritten() {
      return chunksWritten;
    },
    async close() {
      for (const interval of intervals) clearInterval(interval);
      intervals.clear();
      for (const response of activeResponses) response.destroy();
      activeResponses.clear();
      await closeServer(server);
    },
  };
}

async function startStalledStreamMockApi() {
  const activeResponses = new Set();
  let streamClosed = false;

  const server = createServer((req, res) => {
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404);
      res.end();
      return;
    }

    req.resume();
    req.on('end', () => {
      activeResponses.add(res);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"start"}}]}\n\n');
      res.on('close', () => {
        streamClosed = true;
        activeResponses.delete(res);
      });
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    server,
    port: server.address().port,
    get streamClosed() {
      return streamClosed;
    },
    async close() {
      for (const response of activeResponses) response.destroy();
      activeResponses.clear();
      await closeServer(server);
    },
  };
}

async function writeAbortIgnoringFetchPreload(filePath) {
  await writeFile(filePath, `
import { writeFileSync } from 'node:fs';

const encoder = new TextEncoder();
const probePath = process.env.ZHIDA_FETCH_PROBE_PATH;
let fetchCalls = 0;
let cancelCalls = 0;

function writeProbe(event) {
  if (!probePath) return;
  writeFileSync(probePath, JSON.stringify({ event, fetchCalls, cancelCalls }) + '\\n');
}

globalThis.fetch = async (url) => {
  fetchCalls += 1;
  writeProbe('fetch');
  if (!String(url).includes('/v1/chat/completions')) {
    return new Response('{}', {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"start"}}]}\\n\\n'));
      writeProbe('start');
    },
    cancel() {
      cancelCalls += 1;
      writeProbe('cancel');
      return new Promise(() => {});
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
};
`);
}

async function saveConfig(port, apiBaseUrl, apiKey = 'server-secret') {
  return fetch(`http://127.0.0.1:${port}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiBaseUrl, apiKey }),
  });
}

test('config save requires encryption secret and unknown api paths are 404', async () => {
  const port = await freePort();
  const configDir = await mkdtemp(join(tmpdir(), 'zhida-config-test-'));
  const proxy = startProxy({
    ZHIDA_PORT: String(port),
    ZHIDA_CONFIG_SECRET: '',
    ZHIDA_CONFIG_PATH: join(configDir, 'config.enc.json'),
  });
  try {
    await waitForUrl(`http://127.0.0.1:${port}/index.html`);
    const saved = await saveConfig(port, 'http://127.0.0.1:9999');
    assert.equal(saved.status, 500);
    assert.match(await saved.text(), /ZHIDA_CONFIG_SECRET/);

    const unknown = await fetch(`http://127.0.0.1:${port}/api/not-allowed`);
    assert.equal(unknown.status, 404);
  } finally {
    closeChild(proxy);
    await rm(configDir, { recursive: true, force: true });
  }
});

test('static smoke test page is hidden even when parent test routes are enabled', async () => {
  const port = await freePort();
  const configDir = await mkdtemp(join(tmpdir(), 'zhida-config-test-'));
  const previousTestRoutes = process.env.ZHIDA_ENABLE_TEST_ROUTES;
  let proxy;

  try {
    process.env.ZHIDA_ENABLE_TEST_ROUTES = '1';
    proxy = startProxy({
      ZHIDA_PORT: String(port),
      ZHIDA_CONFIG_SECRET: 'test-secret',
      ZHIDA_CONFIG_PATH: join(configDir, 'config.enc.json'),
    });
    await waitForUrl(`http://127.0.0.1:${port}/index.html`);
    const smoke = await fetch(`http://127.0.0.1:${port}/tests/smoke.html`);
    assert.equal(smoke.status, 404);
  } finally {
    if (previousTestRoutes === undefined) {
      delete process.env.ZHIDA_ENABLE_TEST_ROUTES;
    } else {
      process.env.ZHIDA_ENABLE_TEST_ROUTES = previousTestRoutes;
    }
    if (proxy) closeChild(proxy);
    await rm(configDir, { recursive: true, force: true });
  }
});

test('static smoke test page is served when test routes are explicitly enabled', async () => {
  const port = await freePort();
  const configDir = await mkdtemp(join(tmpdir(), 'zhida-config-test-'));
  const proxy = startProxy({
    ZHIDA_PORT: String(port),
    ZHIDA_CONFIG_SECRET: 'test-secret',
    ZHIDA_CONFIG_PATH: join(configDir, 'config.enc.json'),
    ZHIDA_ENABLE_TEST_ROUTES: '1',
  });

  try {
    await waitForUrl(`http://127.0.0.1:${port}/index.html`);
    const smoke = await fetch(`http://127.0.0.1:${port}/tests/smoke.html`);
    assert.equal(smoke.status, 200);
    assert.match(await smoke.text(), /Zhida AI Smoke Test/);
  } finally {
    closeChild(proxy);
    await rm(configDir, { recursive: true, force: true });
  }
});

test('static smoke test page rejects non-literal test route flags', async () => {
  const cases = ['0', 'true', 'yes'];

  for (const value of cases) {
    const port = await freePort();
    const configDir = await mkdtemp(join(tmpdir(), 'zhida-config-test-'));
    const proxy = startProxy({
      ZHIDA_PORT: String(port),
      ZHIDA_CONFIG_SECRET: 'test-secret',
      ZHIDA_CONFIG_PATH: join(configDir, 'config.enc.json'),
      ZHIDA_ENABLE_TEST_ROUTES: value,
    });

    try {
      await waitForUrl(`http://127.0.0.1:${port}/index.html`);
      const smoke = await fetch(`http://127.0.0.1:${port}/tests/smoke.html`);
      assert.equal(smoke.status, 404, `ZHIDA_ENABLE_TEST_ROUTES=${value} should not expose smoke test`);
    } finally {
      closeChild(proxy);
      await rm(configDir, { recursive: true, force: true });
    }
  }
});

test('invalid numeric environment variables fail fast', async () => {
  const cases = [
    ['ZHIDA_PORT', '0'],
    ['ZHIDA_PORT', '65536'],
    ['ZHIDA_PROXY_TIMEOUT_MS', '0'],
    ['ZHIDA_PROXY_TIMEOUT_MS', '12.5'],
    ['ZHIDA_PROXY_MAX_BODY_BYTES', '0'],
    ['ZHIDA_PROXY_MAX_BODY_BYTES', 'not-a-number'],
  ];

  for (const [name, value] of cases) {
    const result = await runProxyExpectingExit({
      ZHIDA_CONFIG_SECRET: 'test-secret',
      [name]: value,
    });
    assert.notEqual(result.code, 0, `${name}=${value} should exit non-zero`);
    assert.equal(result.signal, null);
    assert.match(result.stderr, new RegExp(name));
  }
});

test('config save rejects request bodies larger than 256KB before parsing', async () => {
  const port = await freePort();
  const configDir = await mkdtemp(join(tmpdir(), 'zhida-config-test-'));
  const proxy = startProxy({
    ZHIDA_PORT: String(port),
    ZHIDA_CONFIG_SECRET: 'test-secret',
    ZHIDA_CONFIG_PATH: join(configDir, 'config.enc.json'),
  });

  try {
    await waitForUrl(`http://127.0.0.1:${port}/index.html`);
    const body = Buffer.from(JSON.stringify({
      apiBaseUrl: 'http://127.0.0.1:11434',
      apiKey: 'x'.repeat(256 * 1024),
    }));
    const response = await sendRawRequest(port, {
      method: 'PUT',
      path: '/api/config',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(body.length),
      },
      chunks: [body],
    });

    assert.equal(response.status, 413);
    assert.equal(response.headers.connection, 'close');
    assert.deepEqual(JSON.parse(response.body), { error: 'Request body too large' });
  } finally {
    closeChild(proxy);
    await rm(configDir, { recursive: true, force: true });
  }
});

test('chat proxy accepts a 2MB base64 image payload under the default body limit', async () => {
  const mock = await startMockApi();
  const port = await freePort();
  const configDir = await mkdtemp(join(tmpdir(), 'zhida-config-test-'));
  const proxy = startProxy({
    ZHIDA_PORT: String(port),
    ZHIDA_CONFIG_SECRET: 'test-secret',
    ZHIDA_CONFIG_PATH: join(configDir, 'config.enc.json'),
  });

  try {
    await waitForUrl(`http://127.0.0.1:${port}/index.html`);
    const saved = await saveConfig(port, `http://127.0.0.1:${mock.port}`);
    assert.equal(saved.status, 200);

    const body = makeVisionChatPayload();
    assert.ok(Buffer.byteLength(body) > 2 * 1024 * 1024);
    const response = await fetch(`http://127.0.0.1:${port}/api/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    assert.equal(response.status, 200);
    assert.match(await response.text(), /proxy/);
    const chatRequest = mock.requests.find((request) => request.url === '/v1/chat/completions');
    assert.ok(chatRequest);
    assert.ok(Buffer.byteLength(chatRequest.body) > 2 * 1024 * 1024);
  } finally {
    closeChild(proxy);
    mock.server.close();
    await rm(configDir, { recursive: true, force: true });
  }
});

test('configured proxy body limit accepts below-limit chat requests and rejects oversized streams', async () => {
  const mock = await startMockApi();
  const port = await freePort();
  const configDir = await mkdtemp(join(tmpdir(), 'zhida-config-test-'));
  const proxy = startProxy({
    ZHIDA_PORT: String(port),
    ZHIDA_CONFIG_SECRET: 'test-secret',
    ZHIDA_CONFIG_PATH: join(configDir, 'config.enc.json'),
    ZHIDA_PROXY_MAX_BODY_BYTES: String(1024 * 1024),
  });

  try {
    await waitForUrl(`http://127.0.0.1:${port}/index.html`);
    const saved = await saveConfig(port, `http://127.0.0.1:${mock.port}`);
    assert.equal(saved.status, 200);

    const belowLimitBody = makeVisionChatPayload(768 * 1024);
    assert.ok(Buffer.byteLength(belowLimitBody) > 512 * 1024);
    assert.ok(Buffer.byteLength(belowLimitBody) < 1024 * 1024);
    const accepted = await fetch(`http://127.0.0.1:${port}/api/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: belowLimitBody,
    });
    assert.equal(accepted.status, 200);
    assert.match(await accepted.text(), /proxy/);
    assert.equal(mock.requests.filter((request) => request.url === '/v1/chat/completions').length, 1);

    const response = await sendRawRequest(port, {
      method: 'POST',
      path: '/api/chat/completions',
      headers: { 'Content-Type': 'application/json' },
      chunks: [Buffer.from(makeVisionChatPayload())],
    });

    assert.equal(response.status, 413);
    assert.equal(response.headers.connection, 'close');
    assert.deepEqual(JSON.parse(response.body), { error: 'Request body too large' });
    assert.equal(mock.requests.filter((request) => request.url === '/v1/chat/completions').length, 1);
  } finally {
    closeChild(proxy);
    mock.server.close();
    await rm(configDir, { recursive: true, force: true });
  }
});

test('unknown api paths keep the 512KB request body limit', async () => {
  const port = await freePort();
  const configDir = await mkdtemp(join(tmpdir(), 'zhida-config-test-'));
  const proxy = startProxy({
    ZHIDA_PORT: String(port),
    ZHIDA_CONFIG_SECRET: 'test-secret',
    ZHIDA_CONFIG_PATH: join(configDir, 'config.enc.json'),
  });

  try {
    await waitForUrl(`http://127.0.0.1:${port}/index.html`);
    const body = Buffer.alloc(512 * 1024 + 1, 'x');
    const response = await sendRawRequest(port, {
      method: 'POST',
      path: '/api/not-allowed',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(body.length),
      },
      chunks: [body],
    });

    assert.equal(response.status, 413);
    assert.equal(response.headers.connection, 'close');
    assert.deepEqual(JSON.parse(response.body), { error: 'Request body too large' });
  } finally {
    closeChild(proxy);
    await rm(configDir, { recursive: true, force: true });
  }
});

test('responses proxy uses server-side authorization and forwards cancel requests', async () => {
  const mock = await startMockApi();
  const port = await freePort();
  const configDir = await mkdtemp(join(tmpdir(), 'zhida-config-test-'));
  const proxy = startProxy({
    ZHIDA_PORT: String(port),
    ZHIDA_CONFIG_SECRET: 'test-secret',
    ZHIDA_CONFIG_PATH: join(configDir, 'config.enc.json'),
  });

  try {
    await waitForUrl(`http://127.0.0.1:${port}/index.html`);
    const saved = await saveConfig(port, `http://127.0.0.1:${mock.port}`);
    assert.equal(saved.status, 200);

    const responses = await fetch(`http://127.0.0.1:${port}/api/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer browser-secret',
      },
      body: JSON.stringify({
        model: 'gpt-test',
        input: 'hello',
        stream: true,
        tools: [{ type: 'web_search' }],
      }),
    });
    assert.equal(responses.status, 200);
    assert.match(await responses.text(), /response proxy/);

    const cancel = await fetch(`http://127.0.0.1:${port}/api/responses/resp_test_1/cancel`, {
      method: 'POST',
      headers: { Authorization: 'Bearer browser-secret' },
    });
    assert.equal(cancel.status, 200);
    assert.equal((await cancel.json()).status, 'cancelled');

    const responseRequest = mock.requests.find((request) => request.url === '/v1/responses');
    const cancelRequest = mock.requests.find((request) => request.url === '/v1/responses/resp_test_1/cancel');
    assert.equal(responseRequest.authorization, 'Bearer server-secret');
    assert.equal(cancelRequest.authorization, 'Bearer server-secret');
    assert.match(responseRequest.body, /web_search/);
  } finally {
    closeChild(proxy);
    mock.server.close();
    await rm(configDir, { recursive: true, force: true });
  }
});

test('malformed encoded cancel route is rejected without crashing proxy', async () => {
  const port = await freePort();
  const configDir = await mkdtemp(join(tmpdir(), 'zhida-config-test-'));
  const proxy = startProxy({
    ZHIDA_PORT: String(port),
    ZHIDA_CONFIG_SECRET: 'test-secret',
    ZHIDA_CONFIG_PATH: join(configDir, 'config.enc.json'),
  });

  try {
    await waitForUrl(`http://127.0.0.1:${port}/index.html`);
    const malformed = await fetch(`http://127.0.0.1:${port}/api/responses/%E0%A4%A/cancel`, {
      method: 'POST',
    });
    assert.equal(malformed.status, 404);

    const stillAlive = await fetch(`http://127.0.0.1:${port}/index.html`);
    assert.equal(stillAlive.status, 200);
  } finally {
    closeChild(proxy);
    await rm(configDir, { recursive: true, force: true });
  }
});

test('client abort closes upstream streaming proxy requests', async () => {
  const mock = await startStreamingMockApi();
  const port = await freePort();
  const configDir = await mkdtemp(join(tmpdir(), 'zhida-config-test-'));
  const proxy = startProxy({
    ZHIDA_PORT: String(port),
    ZHIDA_CONFIG_SECRET: 'test-secret',
    ZHIDA_CONFIG_PATH: join(configDir, 'config.enc.json'),
  });
  const getProxyOutput = collectChildOutput(proxy);

  try {
    await waitForUrl(`http://127.0.0.1:${port}/index.html`);
    const saved = await saveConfig(port, `http://127.0.0.1:${mock.port}`);
    assert.equal(saved.status, 200);

    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/api/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [], stream: true }),
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);

    controller.abort();
    await waitForCondition(() => mock.streamClosed, 'upstream stream close after client abort');
    assert.equal(mock.streamClosed, true);
    const chunksAfterClose = mock.chunksWritten;
    await delay(150);
    assert.equal(mock.chunksWritten, chunksAfterClose);
    assert.doesNotMatch(
      getProxyOutput().stderr,
      /ERR_STREAM_WRITE_AFTER_END|write after end|Unhandled|uncaught/i
    );
  } finally {
    closeChild(proxy);
    await mock.close();
    await rm(configDir, { recursive: true, force: true });
  }
});

test('proxy timeout terminates an upstream reader that ignores abort and cancel settlement', async () => {
  const port = await freePort();
  const configDir = await mkdtemp(join(tmpdir(), 'zhida-config-test-'));
  const preloadPath = join(configDir, 'abort-ignoring-fetch.mjs');
  const probePath = join(configDir, 'fetch-probe.json');
  await writeAbortIgnoringFetchPreload(preloadPath);

  const proxy = startProxy({
    ZHIDA_PORT: String(port),
    ZHIDA_CONFIG_SECRET: 'test-secret',
    ZHIDA_CONFIG_PATH: join(configDir, 'config.enc.json'),
    ZHIDA_PROXY_TIMEOUT_MS: '120',
    ZHIDA_FETCH_PROBE_PATH: probePath,
    NODE_OPTIONS: `--import=${preloadPath}`,
  });

  try {
    await waitForUrl(`http://127.0.0.1:${port}/index.html`);
    const saved = await saveConfig(port, 'http://127.0.0.1:1');
    assert.equal(saved.status, 200);

    const response = await fetch(`http://127.0.0.1:${port}/api/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [], stream: true }),
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);

    const secondRead = await Promise.race([
      reader.read().then(
        () => 'resolved',
        () => 'rejected'
      ),
      delay(800).then(() => 'timed-out'),
    ]);
    assert.notEqual(secondRead, 'timed-out');

    const probe = JSON.parse(await readFile(probePath, 'utf8'));
    assert.equal(probe.cancelCalls, 1);
  } finally {
    closeChild(proxy);
    await rm(configDir, { recursive: true, force: true });
  }
});

test('stalled upstream response body is closed by proxy timeout after headers', async () => {
  const mock = await startStalledStreamMockApi();
  const port = await freePort();
  const configDir = await mkdtemp(join(tmpdir(), 'zhida-config-test-'));
  const proxy = startProxy({
    ZHIDA_PORT: String(port),
    ZHIDA_CONFIG_SECRET: 'test-secret',
    ZHIDA_CONFIG_PATH: join(configDir, 'config.enc.json'),
    ZHIDA_PROXY_TIMEOUT_MS: '120',
  });

  try {
    await waitForUrl(`http://127.0.0.1:${port}/index.html`);
    const saved = await saveConfig(port, `http://127.0.0.1:${mock.port}`);
    assert.equal(saved.status, 200);

    const response = await fetch(`http://127.0.0.1:${port}/api/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [], stream: true }),
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);

    const secondRead = await Promise.race([
      reader.read().then(
        () => 'resolved',
        () => 'rejected'
      ),
      delay(800).then(() => 'timed-out'),
    ]);
    assert.notEqual(secondRead, 'timed-out');
    assert.equal(mock.streamClosed, true);
  } finally {
    closeChild(proxy);
    await mock.close();
    await rm(configDir, { recursive: true, force: true });
  }
});

test('responses capability errors are normalized and redacted', async () => {
  const mock = await startMockApi();
  const port = await freePort();
  const configDir = await mkdtemp(join(tmpdir(), 'zhida-config-test-'));
  const proxy = startProxy({
    ZHIDA_PORT: String(port),
    ZHIDA_CONFIG_SECRET: 'test-secret',
    ZHIDA_CONFIG_PATH: join(configDir, 'config.enc.json'),
  });

  try {
    await waitForUrl(`http://127.0.0.1:${port}/index.html`);
    const saved = await saveConfig(port, `http://127.0.0.1:${mock.port}`);
    assert.equal(saved.status, 200);

    const responses = await fetch(`http://127.0.0.1:${port}/api/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer browser-secret',
      },
      body: JSON.stringify({ force_responses_unsupported: true }),
    });
    assert.equal(responses.status, 400);
    const body = await responses.text();
    assert.match(body, /当前 API 服务不支持 Responses API/);
    assert.doesNotMatch(body, /server-secret|Authorization|Bearer/);
    assert.doesNotMatch(body, /call_methods/);
  } finally {
    closeChild(proxy);
    mock.server.close();
    await rm(configDir, { recursive: true, force: true });
  }
});

test('encrypted config status omits key and proxy uses only server-side authorization', async () => {
  const mock = await startMockApi();
  const port = await freePort();
  const configDir = await mkdtemp(join(tmpdir(), 'zhida-config-test-'));
  const configPath = join(configDir, 'config.enc.json');
  const proxy = startProxy({
    ZHIDA_PORT: String(port),
    ZHIDA_CONFIG_SECRET: 'test-secret',
    ZHIDA_CONFIG_PATH: configPath,
  });

  try {
    await waitForUrl(`http://127.0.0.1:${port}/index.html`);
    const saved = await saveConfig(port, `http://127.0.0.1:${mock.port}`);
    assert.equal(saved.status, 200);

    const savedBody = await saved.json();
    assert.equal(savedBody.configured, true);

    const configFile = await readFile(configPath, 'utf8');
    assert.doesNotMatch(configFile, /server-secret/);
    assert.match(configFile, /ciphertext/);

    const status = await fetch(`http://127.0.0.1:${port}/api/config/status`);
    assert.equal(status.status, 200);
    const statusJson = await status.json();
    assert.equal(statusJson.configured, true);
    assert.equal(statusJson.apiBaseUrl, `http://127.0.0.1:${mock.port}`);
    assert.equal('apiKey' in statusJson, false);
    assert.equal('ciphertext' in statusJson, false);

    const models = await fetch(`http://127.0.0.1:${port}/api/models`, {
      headers: { Authorization: 'Bearer browser-secret' },
    });
    assert.equal(models.status, 200);
    assert.equal((await models.json()).data[0].id, 'proxy-standard');

    const chat = await fetch(`http://127.0.0.1:${port}/api/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer browser-secret',
      },
      body: JSON.stringify({ messages: [], stream: true }),
    });
    assert.equal(chat.status, 200);
    assert.match(await chat.text(), /proxy/);

    assert.ok(mock.requests.every((request) => request.authorization === 'Bearer server-secret'));
  } finally {
    closeChild(proxy);
    mock.server.close();
    await rm(configDir, { recursive: true, force: true });
  }
});

test('reads legacy server/data config when no explicit ZHIDA_CONFIG_PATH is set', async () => {
  const defaultConfigPath = join(process.cwd(), '.zhida-data/config.enc.json');
  const legacyConfigPath = join(process.cwd(), 'server/data/config.enc.json');
  const originalDefaultConfig = existsSync(defaultConfigPath) ? await readFile(defaultConfigPath, 'utf8') : null;
  const originalSecretConfig = existsSync(legacyConfigPath) ? await readFile(legacyConfigPath, 'utf8') : null;
  const secret = 'legacy-test-secret';
  const baseUrl = `http://127.0.0.1:11434`;
  const port = await freePort();
  await rm(defaultConfigPath, { force: true });
  await mkdir(dirname(legacyConfigPath), { recursive: true });
  await writeEncryptedConfig(legacyConfigPath, secret, baseUrl);

  const proxy = startProxy({
    ZHIDA_PORT: String(port),
    ZHIDA_CONFIG_SECRET: secret,
  });

  try {
    await waitForUrl(`http://127.0.0.1:${port}/index.html`);
    const status = await fetch(`http://127.0.0.1:${port}/api/config/status`);
    assert.equal(status.status, 200);
    const statusJson = await status.json();
    assert.equal(statusJson.configured, true);
    assert.equal(statusJson.apiBaseUrl, baseUrl);
  } finally {
    closeChild(proxy);
    if (originalDefaultConfig === null) {
      await rm(defaultConfigPath, { force: true });
    } else {
      await mkdir(dirname(defaultConfigPath), { recursive: true });
      await writeFile(defaultConfigPath, originalDefaultConfig);
    }
    if (originalSecretConfig === null) {
      await rm(legacyConfigPath, { force: true });
    } else {
      await writeFile(legacyConfigPath, originalSecretConfig);
    }
  }
});

test('default config saves to .zhida-data and does not rewrite legacy config', async () => {
  const defaultConfigPath = join(process.cwd(), '.zhida-data/config.enc.json');
  const legacyConfigPath = join(process.cwd(), 'server/data/config.enc.json');
  const originalDefaultConfig = existsSync(defaultConfigPath) ? await readFile(defaultConfigPath, 'utf8') : null;
  const originalLegacyConfig = existsSync(legacyConfigPath) ? await readFile(legacyConfigPath, 'utf8') : null;
  const secret = 'default-write-secret';
  const legacyBaseUrl = 'http://127.0.0.1:11434';
  const nextApiBaseUrl = 'http://127.0.0.1:11435';
  const port = await freePort();

  await rm(defaultConfigPath, { force: true });
  await mkdir(dirname(legacyConfigPath), { recursive: true });
  await writeEncryptedConfig(legacyConfigPath, secret, legacyBaseUrl);

  const proxy = startProxy({
    ZHIDA_PORT: String(port),
    ZHIDA_CONFIG_SECRET: secret,
  });

  try {
    await waitForUrl(`http://127.0.0.1:${port}/index.html`);

    const saved = await saveConfig(port, nextApiBaseUrl);
    assert.equal(saved.status, 200);

    const defaultStored = JSON.parse(await readFile(defaultConfigPath, 'utf8'));
    assert.equal(defaultStored.apiBaseUrl, nextApiBaseUrl);
    const legacyStored = JSON.parse(await readFile(legacyConfigPath, 'utf8'));
    assert.equal(legacyStored.apiBaseUrl, legacyBaseUrl);
  } finally {
    closeChild(proxy);
    if (originalDefaultConfig === null) {
      await rm(defaultConfigPath, { force: true });
    } else {
      await mkdir(dirname(defaultConfigPath), { recursive: true });
      await writeFile(defaultConfigPath, originalDefaultConfig);
    }
    if (originalLegacyConfig === null) {
      await rm(legacyConfigPath, { force: true });
    } else {
      await mkdir(dirname(legacyConfigPath), { recursive: true });
      await writeFile(legacyConfigPath, originalLegacyConfig);
    }
  }
});

test('reads docker legacy config path when explicit config path is missing, but saves to explicit path', async () => {
  const port = await freePort();
  const explicitConfigDir = await mkdtemp(join(tmpdir(), 'zhida-explicit-config-'));
  const explicitConfigPath = join(explicitConfigDir, 'config.enc.json');
  const legacyDockerDir = await mkdtemp(join(tmpdir(), 'zhida-legacy-docker-'));
  const legacyDockerConfigPath = join(legacyDockerDir, 'server/data/config.enc.json');
  await mkdir(dirname(legacyDockerConfigPath), { recursive: true });
  const secret = 'legacy-docker-secret';
  const baseUrl = `http://127.0.0.1:11434`;
  const nextApiBaseUrl = `http://127.0.0.1:11435`;

  await mkdir(legacyDockerDir, { recursive: true });
  await writeEncryptedConfig(legacyDockerConfigPath, secret, baseUrl);

  const proxy = startProxy({
    ZHIDA_PORT: String(port),
    ZHIDA_CONFIG_SECRET: secret,
    ZHIDA_CONFIG_PATH: explicitConfigPath,
    LEGACY_DOCKER_CONFIG_PATH: legacyDockerConfigPath,
  });

  try {
    await waitForUrl(`http://127.0.0.1:${port}/index.html`);

    const initialStatus = await fetch(`http://127.0.0.1:${port}/api/config/status`);
    assert.equal(initialStatus.status, 200);
    const initialStatusJson = await initialStatus.json();
    assert.equal(initialStatusJson.configured, true);
    assert.equal(initialStatusJson.apiBaseUrl, baseUrl);

    const saved = await saveConfig(port, nextApiBaseUrl);
    assert.equal(saved.status, 200);

    const explicitStored = JSON.parse(await readFile(explicitConfigPath, 'utf8'));
    assert.equal(explicitStored.apiBaseUrl, nextApiBaseUrl);
    const legacyStored = JSON.parse(await readFile(legacyDockerConfigPath, 'utf8'));
    assert.equal(legacyStored.apiBaseUrl, baseUrl);
    assert.equal(legacyStored.apiBaseUrl !== explicitStored.apiBaseUrl, true);
  } finally {
    closeChild(proxy);
    await rm(explicitConfigDir, { recursive: true, force: true });
    await rm(legacyDockerDir, { recursive: true, force: true });
  }
});

test('api base url accepts a trailing v1 without duplicating upstream paths', async () => {
  const mock = await startMockApi();
  const port = await freePort();
  const configDir = await mkdtemp(join(tmpdir(), 'zhida-config-test-'));
  const proxy = startProxy({
    ZHIDA_PORT: String(port),
    ZHIDA_CONFIG_SECRET: 'test-secret',
    ZHIDA_CONFIG_PATH: join(configDir, 'config.enc.json'),
  });

  try {
    await waitForUrl(`http://127.0.0.1:${port}/index.html`);
    const saved = await saveConfig(port, `http://127.0.0.1:${mock.port}/v1`);
    assert.equal(saved.status, 200);
    const savedBody = await saved.json();
    assert.equal(savedBody.apiBaseUrl, `http://127.0.0.1:${mock.port}`);

    const models = await fetch(`http://127.0.0.1:${port}/api/models`);
    assert.equal(models.status, 200);
    assert.equal((await models.json()).data[0].id, 'proxy-standard');

    assert.ok(mock.requests.some((request) => request.url === '/v1/models'));
    assert.equal(mock.requests.some((request) => request.url === '/v1/v1/models'), false);
  } finally {
    closeChild(proxy);
    mock.server.close();
    await rm(configDir, { recursive: true, force: true });
  }
});

test('upstream errors are redacted before returning to the browser', async () => {
  const mock = await startMockApi();
  const port = await freePort();
  const configDir = await mkdtemp(join(tmpdir(), 'zhida-config-test-'));
  const proxy = startProxy({
    ZHIDA_PORT: String(port),
    ZHIDA_CONFIG_SECRET: 'test-secret',
    ZHIDA_CONFIG_PATH: join(configDir, 'config.enc.json'),
  });

  try {
    await waitForUrl(`http://127.0.0.1:${port}/index.html`);
    const saved = await saveConfig(port, `http://127.0.0.1:${mock.port}`);
    assert.equal(saved.status, 200);

    const chat = await fetch(`http://127.0.0.1:${port}/api/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer browser-secret',
      },
      body: JSON.stringify({ messages: [], stream: true, force_error: true }),
    });
    assert.equal(chat.status, 401);
    const body = await chat.text();
    assert.doesNotMatch(body, /server-secret/);
    assert.match(body, /\[REDACTED\]/);
  } finally {
    closeChild(proxy);
    mock.server.close();
    await rm(configDir, { recursive: true, force: true });
  }
});

test('static server only exposes browser app assets and blocks backend internals', async () => {
  const port = await freePort();
  const configDir = await mkdtemp(join(tmpdir(), 'zhida-config-test-'));
  const localDataDir = join(process.cwd(), 'server/data');
  const createdLocalDataDir = !existsSync(localDataDir);
  const localConfigPath = join(localDataDir, `static-leak-test-${process.pid}.enc.json`);
  const proxy = startProxy({
    ZHIDA_PORT: String(port),
    ZHIDA_CONFIG_SECRET: 'test-secret',
    ZHIDA_CONFIG_PATH: join(configDir, 'config.enc.json'),
  });

  try {
    await mkdir(localDataDir, { recursive: true });
    await writeFile(localConfigPath, '{"ciphertext":"leaked-test-secret"}\n');
    await waitForUrl(`http://127.0.0.1:${port}/index.html`);

    const index = await fetch(`http://127.0.0.1:${port}/index.html`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type') ?? '', /text\/html/);

    const appJs = await fetch(`http://127.0.0.1:${port}/js/app.js`);
    assert.equal(appJs.status, 200);
    assert.match(appJs.headers.get('content-type') ?? '', /javascript/);

    const smokePage = await fetch(`http://127.0.0.1:${port}/tests/smoke.html`);
    assert.equal(smokePage.status, 404);

    const backendSource = await fetch(`http://127.0.0.1:${port}/server/server.js`);
    assert.equal(backendSource.status, 404);

    const encryptedConfig = await fetch(
      `http://127.0.0.1:${port}/server/data/${localConfigPath.split('/').pop()}`
    );
    assert.equal(encryptedConfig.status, 404);
    assert.doesNotMatch(await encryptedConfig.text(), /leaked-test-secret/);

    const blockedPaths = [
      '/server',
      '/server/',
      '/scripts/start.sh',
      '/.git/config',
      '/css/not-found.css',
      '/js/not-found.js',
      '/assets/not-found.svg',
      '/tests/not-found.html',
      '/%2e%2e/server/server.js',
      '/%2f%2e%2fserver/server.js',
      '/%2e%2e%2fserver/data/config.enc.json',
      '/%252e%252e%252fserver%252fserver.js',
      '/%2f%2e%2e%2fserver%2fdata%2fconfig.enc.json',
    ];
    for (const path of blockedPaths) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(response.status, 404, `${path} should not be served`);
    }
  } finally {
    closeChild(proxy);
    await rm(configDir, { recursive: true, force: true });
    await rm(localConfigPath, { force: true });
    if (createdLocalDataDir) {
      await rm(localDataDir, { recursive: true, force: true });
    }
  }
});
