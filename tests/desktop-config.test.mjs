import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, mkdtemp, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildDesktopRuntimeEnv,
  getOrCreateDesktopSecret,
  resolveDesktopDataPaths,
} from '../desktop/config.js';

function createFakeSafeStorage() {
  return {
    isEncryptionAvailable() {
      return true;
    },
    async encryptStringAsync(value) {
      return Buffer.from(`protected:${String(value).split('').reverse().join('')}`, 'utf8');
    },
    async decryptStringAsync(encrypted) {
      const value = encrypted.toString('utf8');
      assert.equal(value.startsWith('protected:'), true);
      return value.slice('protected:'.length).split('').reverse().join('');
    },
  };
}

function isInside(parentPath, childPath) {
  const rel = relative(resolve(parentPath), resolve(childPath));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\'));
}

test('desktop config paths stay under Electron userData instead of the repo', () => {
  const userDataDir = resolve(process.cwd(), '..', 'zhida-ai-userData-test');
  const paths = resolveDesktopDataPaths(userDataDir);

  assert.equal(paths.userDataDir, resolve(userDataDir));
  assert.equal(paths.configPath, join(resolve(userDataDir), 'config.enc.json'));
  assert.equal(paths.secretPath, join(resolve(userDataDir), 'desktop-secret.enc.json'));
  assert.equal(isInside(userDataDir, paths.configPath), true);
  assert.equal(isInside(userDataDir, paths.secretPath), true);
  assert.equal(isInside(process.cwd(), paths.configPath), false);
  assert.equal(isInside(process.cwd(), paths.secretPath), false);
});

test('desktop secret is protected by safeStorage and reused without plaintext leakage', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'zhida-desktop-secret-'));
  const seed = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
  try {
    const first = await getOrCreateDesktopSecret({
      userDataDir,
      safeStorage: createFakeSafeStorage(),
      randomBytesFn: () => seed,
    });

    assert.equal(first.created, true);
    const stored = await readFile(first.paths.secretPath, 'utf8');
    assert.equal(stored.includes(first.secret), false);
    assert.match(stored, /electron\.safeStorage/);

    const second = await getOrCreateDesktopSecret({
      userDataDir,
      safeStorage: createFakeSafeStorage(),
      randomBytesFn: () => {
        throw new Error('should not generate a new desktop secret');
      },
    });

    assert.equal(second.created, false);
    assert.equal(second.secret, first.secret);
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('desktop secret recovers from an unreadable safeStorage payload', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'zhida-desktop-secret-recovery-'));
  const seed = Buffer.from('abcdef0123456789abcdef0123456789', 'utf8');
  try {
    const paths = resolveDesktopDataPaths(userDataDir);
    await writeFile(paths.secretPath, `${JSON.stringify({
      version: 1,
      protection: 'electron.safeStorage',
      ciphertext: Buffer.from('not-this-install', 'utf8').toString('base64'),
    })}\n`);

    const recovered = await getOrCreateDesktopSecret({
      userDataDir,
      safeStorage: createFakeSafeStorage(),
      randomBytesFn: () => seed,
    });

    assert.equal(recovered.created, true);
    assert.equal(recovered.recovered, true);
    assert.match(recovered.backupPath, /desktop-secret\.enc\.json\.invalid-/);

    const backup = await readFile(recovered.backupPath, 'utf8');
    assert.match(backup, /bm90LXRoaXMtaW5zdGFsbA==/);

    const stored = await readFile(recovered.paths.secretPath, 'utf8');
    assert.equal(stored.includes(recovered.secret), false);

    const reused = await getOrCreateDesktopSecret({
      userDataDir,
      safeStorage: createFakeSafeStorage(),
      randomBytesFn: () => {
        throw new Error('should reuse recovered desktop secret');
      },
    });
    assert.equal(reused.created, false);
    assert.equal(reused.secret, recovered.secret);
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('desktop runtime env binds proxy to loopback and points config at userData', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'zhida-desktop-env-'));
  try {
    const paths = resolveDesktopDataPaths(userDataDir);
    const env = buildDesktopRuntimeEnv({ paths, secret: 'desktop-test-secret' });

    assert.equal(env.ZHIDA_HOST, '127.0.0.1');
    assert.equal(env.ZHIDA_CONFIG_PATH, paths.configPath);
    assert.equal(env.ZHIDA_CONFIG_SECRET, 'desktop-test-secret');
    assert.equal(isInside(userDataDir, env.ZHIDA_CONFIG_PATH), true);
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('electron-builder package excludes local secrets and development data', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  const files = packageJson.build?.files;

  assert.equal(Array.isArray(files), true);
  assert.equal(files.includes('vendor/**'), true, 'vendored browser assets should be packaged');
  for (const pattern of [
    '!**/.env',
    '!**/.env.*',
    '!**/.zhida-data/**',
    '!**/server/data/**',
    '!**/*.enc.json',
    '!**/logs/**',
    '!**/*.log',
    '!tests/**',
    '!specs/**',
  ]) {
    assert.equal(files.includes(pattern), true, `${pattern} should be excluded from packaged app`);
  }
});

test('desktop Windows beta package metadata is explicit', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));

  assert.equal(packageJson.version, '0.1.0');
  assert.equal(typeof packageJson.author, 'string');
  assert.ok(packageJson.author.length > 0);
  assert.equal(packageJson.license, 'MIT');
  assert.equal(packageJson.build?.appId, 'com.zhida.ai');
  assert.equal(packageJson.build?.productName, '智答 AI');
  assert.equal(packageJson.build?.win?.icon, 'assets/icon.ico');
  assert.equal(packageJson.build?.nsis?.oneClick, false);
  assert.equal(packageJson.build?.nsis?.perMachine, false);
  assert.equal(packageJson.build?.nsis?.allowToChangeInstallationDirectory, true);
  assert.equal(packageJson.build?.nsis?.deleteAppDataOnUninstall, false);
  assert.equal(packageJson.build?.nsis?.installerIcon, 'assets/icon.ico');
  assert.equal(packageJson.build?.nsis?.uninstallerIcon, 'assets/icon.ico');

  const icon = await readFile('assets/icon.ico');
  assert.equal(icon.readUInt16LE(0), 0);
  assert.equal(icon.readUInt16LE(2), 1);
  assert.ok(icon.readUInt16LE(4) >= 1);
});
