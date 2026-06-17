import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const DESKTOP_SECRET_FILE = 'desktop-secret.enc.json';

export function resolveDesktopDataPaths(userDataDir) {
  if (typeof userDataDir !== 'string' || !userDataDir.trim()) {
    throw new Error('Electron userData path is required.');
  }
  const resolvedUserDataDir = resolve(userDataDir);
  return {
    userDataDir: resolvedUserDataDir,
    configPath: join(resolvedUserDataDir, 'config.enc.json'),
    secretPath: join(resolvedUserDataDir, DESKTOP_SECRET_FILE),
    logsDir: join(resolvedUserDataDir, 'logs'),
  };
}

export function buildDesktopRuntimeEnv({ paths, secret, host = '127.0.0.1' }) {
  if (!paths?.configPath) throw new Error('Desktop config path is required.');
  if (typeof secret !== 'string' || !secret) throw new Error('Desktop config secret is required.');
  return {
    ZHIDA_HOST: host,
    ZHIDA_CONFIG_PATH: paths.configPath,
    ZHIDA_CONFIG_SECRET: secret,
  };
}

function assertSafeStorageAvailable(safeStorage) {
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') {
    throw new Error('Electron safeStorage is not available.');
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Electron safeStorage encryption is not available on this system.');
  }
}

async function encryptString(safeStorage, value) {
  if (typeof safeStorage.encryptStringAsync === 'function') {
    return Buffer.from(await safeStorage.encryptStringAsync(value)).toString('base64');
  }
  if (typeof safeStorage.encryptString === 'function') {
    return Buffer.from(safeStorage.encryptString(value)).toString('base64');
  }
  throw new Error('Electron safeStorage cannot encrypt strings.');
}

async function decryptString(safeStorage, ciphertext) {
  const encrypted = Buffer.from(ciphertext, 'base64');
  if (typeof safeStorage.decryptStringAsync === 'function') {
    return safeStorage.decryptStringAsync(encrypted);
  }
  if (typeof safeStorage.decryptString === 'function') {
    return safeStorage.decryptString(encrypted);
  }
  throw new Error('Electron safeStorage cannot decrypt strings.');
}

async function readEncryptedSecret(secretPath, safeStorage) {
  const raw = await readFile(secretPath, 'utf8');
  const payload = JSON.parse(raw);
  if (
    payload?.version !== 1 ||
    payload?.protection !== 'electron.safeStorage' ||
    typeof payload?.ciphertext !== 'string'
  ) {
    throw new Error('Desktop secret file has an unsupported format.');
  }
  const secret = await decryptString(safeStorage, payload.ciphertext);
  if (typeof secret !== 'string' || !secret) {
    throw new Error('Desktop secret file decrypted to an empty value.');
  }
  return secret;
}

async function backupUnreadableSecret(secretPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${secretPath}.invalid-${stamp}`;
  await rename(secretPath, backupPath);
  return backupPath;
}

async function writeEncryptedSecret(secretPath, safeStorage, secret) {
  const payload = {
    version: 1,
    protection: 'electron.safeStorage',
    ciphertext: await encryptString(safeStorage, secret),
    updatedAt: new Date().toISOString(),
  };

  await mkdir(dirname(secretPath), { recursive: true });
  await writeFile(secretPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

export async function getOrCreateDesktopSecret({
  userDataDir,
  safeStorage,
  randomBytesFn = randomBytes,
} = {}) {
  assertSafeStorageAvailable(safeStorage);
  const paths = resolveDesktopDataPaths(userDataDir);
  let recovered = false;
  let backupPath = null;

  try {
    return {
      secret: await readEncryptedSecret(paths.secretPath, safeStorage),
      paths,
      created: false,
      recovered: false,
      backupPath: null,
    };
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      backupPath = await backupUnreadableSecret(paths.secretPath);
      recovered = true;
    }
  }

  const secret = randomBytesFn(32).toString('base64');
  await writeEncryptedSecret(paths.secretPath, safeStorage, secret);

  return { secret, paths, created: true, recovered, backupPath };
}
