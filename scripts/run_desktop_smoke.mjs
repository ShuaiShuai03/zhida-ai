import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ELECTRON_BINARY = process.platform === 'win32'
  ? join(ROOT_DIR, 'node_modules', 'electron', 'dist', 'electron.exe')
  : join(ROOT_DIR, 'node_modules', 'electron', 'dist', 'electron');
const TIMEOUT_MS = 45_000;

function createOutputCollector() {
  const chunks = [];
  return {
    push(chunk) {
      chunks.push(Buffer.from(chunk).toString('utf8'));
    },
    text() {
      return chunks.join('');
    },
  };
}

async function main() {
  const userDataDir = await mkdtemp(join(tmpdir(), 'zhida-desktop-smoke-'));
  const stdout = createOutputCollector();
  const stderr = createOutputCollector();

  try {
    const child = spawn(ELECTRON_BINARY, ['.'], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        ZHIDA_DESKTOP_SMOKE: '1',
        ZHIDA_DESKTOP_USER_DATA_DIR: userDataDir,
        ZHIDA_ENABLE_TEST_ROUTES: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));

    const result = await new Promise((resolveResult) => {
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, TIMEOUT_MS);

      child.on('error', (error) => {
        clearTimeout(timeout);
        resolveResult({ timedOut: false, error, code: null, signal: null });
      });

      child.on('exit', (code, signal) => {
        clearTimeout(timeout);
        resolveResult({ timedOut, code, signal });
      });
    });

    const combinedOutput = `${stdout.text()}\n${stderr.text()}`;
    const passed = combinedOutput.includes('"event":"desktop_smoke_pass"');
    if (result.timedOut || result.error || result.code !== 0 || !passed) {
      process.stderr.write('Desktop smoke failed.\n');
      if (result.timedOut) process.stderr.write(`Timed out after ${TIMEOUT_MS} ms.\n`);
      if (result.error) process.stderr.write(`${result.error.stack || result.error.message}\n`);
      if (result.code !== 0 || result.signal) {
        process.stderr.write(`Exit code: ${result.code ?? 'null'}, signal: ${result.signal ?? 'null'}\n`);
      }
      process.stderr.write(combinedOutput.trim() ? `${combinedOutput}\n` : 'No Electron output captured.\n');
      process.exit(1);
    }

    process.stdout.write('Desktop smoke passed.\n');
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
