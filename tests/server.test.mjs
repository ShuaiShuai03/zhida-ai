import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
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

function startProxy(env) {
  const child = spawn(process.execPath, [join(process.cwd(), 'server/server.js')], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

function closeChild(child) {
  if (!child.killed) child.kill();
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
