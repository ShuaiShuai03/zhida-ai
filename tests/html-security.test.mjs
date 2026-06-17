import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const VENDORED_ASSETS = [
  'vendor/katex/0.16.11/katex.min.css',
  'vendor/highlight.js/11.9.0/styles/github-dark.min.css',
  'vendor/marked/14.1.3/marked.min.js',
  'vendor/highlight.js/11.9.0/highlight.min.js',
  'vendor/katex/0.16.11/katex.min.js',
];

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

async function sha384Integrity(filePath) {
  const bytes = await readFile(filePath);
  return `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
}

test('index.html loads vendored browser assets with integrity metadata', async () => {
  const html = await readFile('index.html', 'utf8');
  const stylesheetAssets = getTags(html, 'link').filter((tag) => (
      getAttribute(tag, 'rel').toLowerCase() === 'stylesheet'
      && getAttribute(tag, 'href').startsWith('vendor/')
  ));
  const scriptAssets = getTags(html, 'script')
    .filter((tag) => getAttribute(tag, 'src').startsWith('vendor/'));
  const vendoredAssets = [
    ...stylesheetAssets.map((tag) => ({ tag, path: getAttribute(tag, 'href') })),
    ...scriptAssets.map((tag) => ({ tag, path: getAttribute(tag, 'src') })),
  ];

  assert.deepEqual(vendoredAssets.map((asset) => asset.path), VENDORED_ASSETS);
  assert.equal(html.includes('cdn.jsdelivr.net'), false);
  assert.equal(html.includes('cdnjs.cloudflare.com'), false);
  for (const { tag, path } of vendoredAssets) {
    assert.match(getAttribute(tag, 'integrity'), /^sha384-[A-Za-z0-9+/=]+$/);
    assert.equal(getAttribute(tag, 'integrity'), await sha384Integrity(path));
  }
});

test('index.html meta CSP includes static-hosting hardening directives', async () => {
  const html = await readFile('index.html', 'utf8');
  const cspMeta = getTags(html, 'meta')
    .find((tag) => getAttribute(tag, 'http-equiv').toLowerCase() === 'content-security-policy');

  assert.ok(cspMeta, 'Content-Security-Policy meta tag should exist');
  const content = getAttribute(cspMeta, 'content');
  assert.match(content, /default-src 'self'/);
  assert.match(content, /script-src 'self'/);
  assert.match(content, /style-src 'self' 'unsafe-inline'/);
  assert.match(content, /font-src 'self' data:/);
  assert.match(content, /connect-src 'self'/);
  assert.match(content, /base-uri 'none'/);
  assert.match(content, /object-src 'none'/);
  assert.match(content, /form-action 'self'/);
  assert.equal(content.includes('cdn.jsdelivr.net'), false);
  assert.equal(content.includes('cdnjs.cloudflare.com'), false);
  assert.equal(hasAttribute(cspMeta, 'content'), true);
});
