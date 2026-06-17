import { app, BrowserWindow, dialog, safeStorage, shell } from 'electron';
import { buildDesktopRuntimeEnv, getOrCreateDesktopSecret } from './config.js';

const WINDOW_OPTIONS = {
  width: 1440,
  height: 900,
  minWidth: 1280,
  minHeight: 800,
};

let mainWindow = null;
let proxyServer = null;
let proxyOrigin = '';
let stoppingProxy = false;

function getErrorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error || 'Unknown startup error');
}

function isAllowedAppUrl(url) {
  if (!proxyOrigin) return false;
  try {
    return new URL(url).origin === proxyOrigin;
  } catch {
    return false;
  }
}

function configureNavigationGuards(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAllowedAppUrl(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (isAllowedAppUrl(url)) return;
    event.preventDefault();
    shell.openExternal(url).catch(() => {});
  });
}

async function startInternalProxy() {
  const { secret, paths } = await getOrCreateDesktopSecret({
    userDataDir: app.getPath('userData'),
    safeStorage,
  });

  Object.assign(process.env, buildDesktopRuntimeEnv({ paths, secret }));
  process.env.ZHIDA_DESKTOP = '1';

  const { startServer } = await import('../server/server.js');
  proxyServer = await startServer({
    host: '127.0.0.1',
    port: 0,
  });

  const address = proxyServer.address();
  if (!address || typeof address !== 'object' || !address.port) {
    throw new Error('Desktop proxy did not return a usable loopback port.');
  }

  proxyOrigin = `http://127.0.0.1:${address.port}`;
  return proxyOrigin;
}

async function stopInternalProxy() {
  if (!proxyServer || stoppingProxy) return;
  stoppingProxy = true;
  try {
    const { stopServer } = await import('../server/server.js');
    await stopServer(proxyServer);
  } finally {
    proxyServer = null;
  }
}

async function createMainWindow(url) {
  const window = new BrowserWindow({
    ...WINDOW_OPTIONS,
    title: '智答 AI',
    backgroundColor: '#141413',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged || process.env.ZHIDA_DESKTOP_DEVTOOLS === '1',
    },
  });

  mainWindow = window;
  configureNavigationGuards(window);

  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) window.show();
  });

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  await window.loadURL(`${url}/?desktop=1`);
}

async function bootstrap() {
  const url = await startInternalProxy();
  await createMainWindow(url);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(bootstrap).catch((err) => {
    console.error('[zhida-desktop] startup failed:', getErrorMessage(err));
    dialog.showErrorBox('智答 AI 启动失败', getErrorMessage(err));
    app.exit(1);
  });

  app.on('activate', () => {
    if (!mainWindow && proxyOrigin) {
      createMainWindow(proxyOrigin).catch((err) => {
        console.error('[zhida-desktop] window creation failed:', getErrorMessage(err));
        dialog.showErrorBox('智答 AI 窗口创建失败', getErrorMessage(err));
      });
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', (event) => {
    if (!proxyServer || stoppingProxy) return;
    event.preventDefault();
    stopInternalProxy().finally(() => app.quit());
  });
}
