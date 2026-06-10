import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

function getTags(html, tagName) {
  return html.match(new RegExp(`<${tagName}\\b[^>]*>`, 'gi')) ?? [];
}

function getAttribute(tag, name) {
  const pattern = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const match = tag.match(pattern);
  return match ? match[1] ?? match[2] ?? '' : '';
}

function hasAttribute(tag, name) {
  return new RegExp(`\\s${name}(?:\\s|=|/|>)`, 'i').test(tag);
}

test('index.html pins CDN subresources with integrity metadata', async () => {
  const html = await readFile('index.html', 'utf8');
  const externalAssets = [
    ...getTags(html, 'link').filter((tag) => (
      getAttribute(tag, 'rel').toLowerCase() === 'stylesheet'
      && getAttribute(tag, 'href').startsWith('https://')
    )),
    ...getTags(html, 'script').filter((tag) => getAttribute(tag, 'src').startsWith('https://')),
  ];

  assert.equal(externalAssets.length, 5);
  for (const tag of externalAssets) {
    assert.match(getAttribute(tag, 'integrity'), /^sha384-[A-Za-z0-9+/=]+$/);
    assert.equal(getAttribute(tag, 'crossorigin'), 'anonymous');
  }
});

test('index.html meta CSP includes static-hosting hardening directives', async () => {
  const html = await readFile('index.html', 'utf8');
  const cspMeta = getTags(html, 'meta')
    .find((tag) => getAttribute(tag, 'http-equiv').toLowerCase() === 'content-security-policy');

  assert.ok(cspMeta, 'Content-Security-Policy meta tag should exist');
  const content = getAttribute(cspMeta, 'content');
  assert.match(content, /default-src 'self'/);
  assert.match(content, /script-src 'self' https:\/\/cdn\.jsdelivr\.net https:\/\/cdnjs\.cloudflare\.com/);
  assert.match(content, /style-src 'self' 'unsafe-inline' https:\/\/cdn\.jsdelivr\.net https:\/\/cdnjs\.cloudflare\.com/);
  assert.match(content, /connect-src 'self'/);
  assert.match(content, /base-uri 'none'/);
  assert.match(content, /object-src 'none'/);
  assert.match(content, /form-action 'self'/);
  assert.equal(hasAttribute(cspMeta, 'content'), true);
});
