import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile, listPackage } from '@electron/asar';

const ROOT_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ASAR_PATH = resolve(ROOT_DIR, 'dist/desktop/win-unpacked/resources/app.asar');

const REQUIRED_ENTRIES = [
  'index.html',
  'package.json',
  'assets/favicon.svg',
  'assets/icon.ico',
  'css/variables.css',
  'js/app.js',
  'js/markdown.js',
  'desktop/main.js',
  'server/server.js',
  'vendor/README.md',
  'vendor/marked/14.1.3/marked.min.js',
  'vendor/highlight.js/11.9.0/highlight.min.js',
  'vendor/highlight.js/11.9.0/styles/github-dark.min.css',
  'vendor/katex/0.16.11/katex.min.css',
  'vendor/katex/0.16.11/katex.min.js',
  'vendor/katex/0.16.11/fonts/KaTeX_Main-Regular.woff2',
];

const FORBIDDEN_ENTRY_PATTERNS = [
  { pattern: /(^|\/)\.env($|\.|\/)/, reason: 'environment files must not be packaged' },
  { pattern: /(^|\/)\.zhida-data(\/|$)/, reason: 'local encrypted config directory must not be packaged' },
  { pattern: /^server\/data(\/|$)/, reason: 'legacy local server data must not be packaged' },
  { pattern: /\.enc\.json$/i, reason: 'encrypted secret payloads must not be packaged' },
  { pattern: /(^|\/)tests(\/|$)/, reason: 'tests must not be packaged' },
  { pattern: /(^|\/)specs(\/|$)/, reason: 'specs must not be packaged' },
  { pattern: /(^|\/)scripts(\/|$)/, reason: 'development scripts must not be packaged' },
  { pattern: /(^|\/)logs(\/|$)/, reason: 'logs must not be packaged' },
  { pattern: /\.log$/i, reason: 'log files must not be packaged' },
  { pattern: /^Dockerfile/i, reason: 'Docker files must not be packaged' },
  { pattern: /^docker-compose.*\.ya?ml$/i, reason: 'Docker compose files must not be packaged' },
  { pattern: /^\.github(\/|$)/, reason: 'GitHub metadata must not be packaged' },
  { pattern: /^\.codex(\/|$)/, reason: 'Codex metadata must not be packaged' },
  { pattern: /^\.agents(\/|$)/, reason: 'agent metadata must not be packaged' },
  { pattern: /^node_modules(\/|$)/, reason: 'node_modules must not be packaged for this buildless app' },
  { pattern: /^package-lock\.json$/i, reason: 'package lock is development-only for the desktop runtime' },
  { pattern: /^text\.txt$/i, reason: 'local pasted goal notes must not be packaged' },
];

function normalizeEntry(entry) {
  return entry.replace(/\\/g, '/').replace(/^\/+/, '');
}

function fail(messages) {
  process.stderr.write(`Desktop package audit failed:\n${messages.map((msg) => `- ${msg}`).join('\n')}\n`);
  process.exit(1);
}

async function main() {
  if (!existsSync(ASAR_PATH)) {
    fail([`Missing ${ASAR_PATH}. Run npm run desktop:dir or npm run desktop:build first.`]);
  }

  const entries = (await listPackage(ASAR_PATH)).map(normalizeEntry).sort();
  const entrySet = new Set(entries);
  const failures = [];

  for (const requiredEntry of REQUIRED_ENTRIES) {
    if (!entrySet.has(requiredEntry)) {
      failures.push(`Missing required runtime file: ${requiredEntry}`);
    }
  }

  for (const entry of entries) {
    for (const { pattern, reason } of FORBIDDEN_ENTRY_PATTERNS) {
      if (pattern.test(entry)) {
        failures.push(`${entry}: ${reason}`);
      }
    }
  }

  const packagedIndex = extractFile(ASAR_PATH, 'index.html').toString('utf8');
  if (/cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/.test(packagedIndex)) {
    failures.push('index.html still references CDN runtime assets');
  }

  if (failures.length > 0) fail(failures);

  process.stdout.write(`Desktop package audit passed (${entries.length} asar entries checked).\n`);
}

main().catch((error) => {
  fail([error.stack || error.message]);
});
