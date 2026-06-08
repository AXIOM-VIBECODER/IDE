'use strict';
/**
 * AXIOM v6 — Electron Desktop Main Process
 * Wraps the Node.js web server in a native desktop window.
 * Works on Windows, macOS, and Linux.
 */

const {
  app, BrowserWindow, Menu, Tray, ipcMain, dialog,
  shell, nativeImage, nativeTheme, session, protocol
} = require('electron');

// Linux: disable sandbox (requires SUID helper on Linux — use --no-sandbox in dev)
if (process.platform === 'linux' && !process.env.ELECTRON_SANDBOX) {
  app.commandLine.appendSwitch('no-sandbox');
}
const path   = require('path');
const http   = require('http');
const fs     = require('fs');
const { spawn } = require('child_process');

// ─── Constants ────────────────────────────────────────────
const IS_MAC     = process.platform === 'darwin';
const IS_WIN     = process.platform === 'win32';
const IS_DEV     = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');
const PORT       = parseInt(process.env.AXIOM_PORT || '5000', 10);
const SERVER_URL = `http://localhost:${PORT}`;
const DATA_DIR   = path.join(require('os').homedir(), '.axiom');
const STATE_FILE = path.join(DATA_DIR, 'window-state.json');
const APP_NAME   = 'AXIOM IDE';

// Ensure data dir
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Single Instance Lock ──────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log('[Electron] Another instance is running — focusing it and quitting.');
  app.quit();
  process.exit(0);
}

// ─── Global State ─────────────────────────────────────────
let mainWin    = null;
let tray       = null;
let serverProc = null;
let serverReady = false;
let splashWin  = null;

// ─── Window State Persistence ─────────────────────────────
function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { width: 1400, height: 900, x: undefined, y: undefined, maximized: false };
  }
}
function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  const state = {
    ...bounds,
    maximized: win.isMaximized(),
    fullscreen: win.isFullScreen()
  };
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
}

// ─── Start Node.js Server ─────────────────────────────────
function startServer() {
  return new Promise((resolve, reject) => {
    const serverScript = path.join(__dirname, '..', 'src', 'server.js');
    if (!fs.existsSync(serverScript)) {
      return reject(new Error('server.js not found at ' + serverScript));
    }

    const env = { ...process.env, AXIOM_PORT: String(PORT), ELECTRON_MODE: '1' };
    serverProc = spawn(process.execPath, [serverScript], {
      env,
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    serverProc.stdout.on('data', d => {
      const line = d.toString();
      if (IS_DEV) process.stdout.write('[server] ' + line);
      if (!serverReady && line.includes('localhost:')) {
        serverReady = true;
        resolve();
      }
    });
    serverProc.stderr.on('data', d => {
      if (IS_DEV) process.stderr.write('[server-err] ' + d.toString());
    });
    serverProc.on('error', reject);
    serverProc.on('exit', (code, sig) => {
      if (code !== 0 && code !== null) {
        console.error(`[Electron] Server exited (code=${code}, sig=${sig})`);
      }
    });

    // Poll for server readiness as fallback
    let attempts = 0;
    const check = () => {
      if (serverReady) return;
      const req = http.get(SERVER_URL + '/api/ping', res => {
        if (res.statusCode < 500) { serverReady = true; resolve(); }
        else retry();
      });
      req.on('error', retry);
      req.setTimeout(500, () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (serverReady) return;
      attempts++;
      if (attempts > 60) return reject(new Error('Server did not start in time'));
      setTimeout(check, 500);
    };
    setTimeout(check, 1500);
  });
}

// ─── Splash Screen ────────────────────────────────────────
function createSplash() {
  splashWin = new BrowserWindow({
    width: 460, height: 280,
    frame: false, transparent: true,
    alwaysOnTop: true,
    resizable: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  const splashHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 460px; height: 280px;
    background: linear-gradient(135deg, #07091a 0%, #0d1033 100%);
    border: 1px solid rgba(34,211,238,.2);
    border-radius: 16px;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    font-family: 'Segoe UI', system-ui, sans-serif;
    overflow: hidden;
    -webkit-app-region: drag;
  }
  body::before {
    content: '';
    position: absolute; top: -40%; left: 50%; transform: translateX(-50%);
    width: 300px; height: 300px;
    background: radial-gradient(ellipse, rgba(34,211,238,.12), transparent 70%);
    pointer-events: none;
  }
  .logo {
    width: 72px; height: 72px; border-radius: 18px;
    background: linear-gradient(135deg, #22d3ee, #a78bfa);
    display: flex; align-items: center; justify-content: center;
    font-family: 'Courier New', monospace; font-size: 22px; font-weight: 700;
    color: #000; box-shadow: 0 12px 40px rgba(34,211,238,.4);
    margin-bottom: 20px;
  }
  .name {
    font-size: 28px; font-weight: 700; color: #eef1ff;
    letter-spacing: -.02em; margin-bottom: 6px;
  }
  .tag {
    font-size: 12px; color: rgba(170,178,216,.5);
    letter-spacing: .15em; text-transform: uppercase; margin-bottom: 28px;
  }
  .bar {
    width: 200px; height: 2px; background: rgba(255,255,255,.08);
    border-radius: 2px; overflow: hidden;
  }
  .fill {
    height: 100%; width: 0%; background: linear-gradient(90deg, #22d3ee, #a78bfa);
    border-radius: 2px;
    animation: load 2s ease-out forwards;
    box-shadow: 0 0 8px rgba(34,211,238,.6);
  }
  @keyframes load { to { width: 90%; } }
  .ver { font-size: 10px; color: rgba(255,255,255,.2); margin-top: 12px; letter-spacing: .08em; }
</style>
</head>
<body>
<div class="logo">AX</div>
<div class="name">AXIOM IDE</div>
<div class="tag">East Africa Edition · v6</div>
<div class="bar"><div class="fill"></div></div>
<div class="ver">Loading…</div>
</body>
</html>`;

  splashWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(splashHtml));
  splashWin.center();
}

// ─── Main Window ──────────────────────────────────────────
function createMainWindow() {
  const state = loadWindowState();

  mainWin = new BrowserWindow({
    width:  state.width  || 1400,
    height: state.height || 900,
    x: state.x, y: state.y,
    minWidth:  800, minHeight: 600,
    title: APP_NAME,
    backgroundColor: '#07091a',
    show: false,
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    trafficLightPosition: IS_MAC ? { x: 16, y: 14 } : undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true,
      allowRunningInsecureContent: false,
      // Allow Paystack and other external resources
      additionalArguments: ['--enable-features=OverlayScrollbar'],
    }
  });

  // Add Electron detection header
  mainWin.webContents.session.webRequest.onBeforeSendHeaders((details, cb) => {
    details.requestHeaders['X-Electron-App'] = '1';
    cb({ requestHeaders: details.requestHeaders });
  });

  if (state.maximized) mainWin.maximize();
  if (state.fullscreen) mainWin.setFullScreen(true);

  mainWin.loadURL(SERVER_URL);

  mainWin.once('ready-to-show', () => {
    if (splashWin && !splashWin.isDestroyed()) {
      setTimeout(() => {
        splashWin.close();
        splashWin = null;
        mainWin.show();
        mainWin.focus();
      }, 600);
    } else {
      mainWin.show();
      mainWin.focus();
    }
  });

  // Persist window state
  mainWin.on('resize',   () => saveWindowState(mainWin));
  mainWin.on('move',     () => saveWindowState(mainWin));
  mainWin.on('maximize', () => saveWindowState(mainWin));
  mainWin.on('unmaximize', () => saveWindowState(mainWin));
  mainWin.on('close', () => saveWindowState(mainWin));

  // Open external links in default browser, keep internal navigation in app
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Dev tools in dev mode
  if (IS_DEV) mainWin.webContents.openDevTools({ mode: 'detach' });

  mainWin.on('closed', () => { mainWin = null; });
}

// ─── Application Menu ─────────────────────────────────────
function buildMenu() {
  const template = [
    ...(IS_MAC ? [{
      label: APP_NAME,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Preferences…', accelerator: 'CmdOrCtrl+,', click: () => mainWin?.webContents.executeJavaScript("openSettings && openSettings()") },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New File',      accelerator: 'CmdOrCtrl+N',       click: () => send('menu:new-file') },
        { label: 'New Window',    accelerator: 'CmdOrCtrl+Shift+N', click: () => createNewWindow() },
        { type: 'separator' },
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O',        click: () => nativeOpenFolder() },
        { label: 'Open File…',   accelerator: 'CmdOrCtrl+Shift+O',  click: () => nativeOpenFile() },
        { type: 'separator' },
        { label: 'Save',          accelerator: 'CmdOrCtrl+S',       click: () => send('menu:save') },
        { label: 'Save As…',      accelerator: 'CmdOrCtrl+Shift+S', click: () => send('menu:save-as') },
        { label: 'Save All',      accelerator: 'CmdOrCtrl+Alt+S',   click: () => send('menu:save-all') },
        { type: 'separator' },
        { label: 'Close Tab',     accelerator: 'CmdOrCtrl+W',       click: () => send('menu:close-tab') },
        { type: 'separator' },
        IS_MAC ? { role: 'close' } : { role: 'quit', label: 'Exit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find',           accelerator: 'CmdOrCtrl+F',        click: () => send('menu:find') },
        { label: 'Find & Replace', accelerator: 'CmdOrCtrl+H',        click: () => send('menu:replace') },
        { label: 'Find in Files',  accelerator: 'CmdOrCtrl+Shift+F',  click: () => send('menu:find-in-files') },
        { type: 'separator' },
        { label: 'Toggle Comment', accelerator: 'CmdOrCtrl+/',        click: () => send('menu:comment') },
        { label: 'Format Document',accelerator: 'Alt+Shift+F',        click: () => send('menu:format') },
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Command Palette…', accelerator: 'CmdOrCtrl+Shift+P', click: () => send('menu:palette') },
        { label: 'Quick Open…',      accelerator: 'CmdOrCtrl+P',       click: () => send('menu:quick-open') },
        { type: 'separator' },
        { label: 'Explorer',         accelerator: 'CmdOrCtrl+Shift+E', click: () => send('menu:panel-files') },
        { label: 'Search',           accelerator: 'CmdOrCtrl+Shift+F', click: () => send('menu:panel-search') },
        { label: 'Source Control',   accelerator: 'CmdOrCtrl+Shift+G', click: () => send('menu:panel-git') },
        { label: 'Terminal',         accelerator: IS_MAC ? 'Ctrl+`' : 'Ctrl+`', click: () => send('menu:terminal') },
        { label: 'AI Assistant',     accelerator: 'CmdOrCtrl+Shift+A', click: () => send('menu:ai-panel') },
        { type: 'separator' },
        { label: 'Toggle Sidebar',   accelerator: 'CmdOrCtrl+B',       click: () => send('menu:sidebar') },
        { label: 'Toggle Zen Mode',  accelerator: 'CmdOrCtrl+K Z',     click: () => send('menu:zen') },
        { label: 'Split Editor',     accelerator: 'CmdOrCtrl+\\',      click: () => send('menu:split') },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(IS_DEV ? [{ type: 'separator' }, { role: 'toggleDevTools' }, { role: 'forceReload' }] : [])
      ]
    },
    {
      label: 'Run',
      submenu: [
        { label: 'Run File',           accelerator: 'F5',           click: () => send('menu:run') },
        { label: 'Start Debugging',    accelerator: 'F9',           click: () => send('menu:debug') },
        { label: 'Stop',               accelerator: 'Shift+F5',     click: () => send('menu:debug-stop') },
        { label: 'Step Over',          accelerator: 'F10',          click: () => send('menu:debug-step') },
        { label: 'Step Into',          accelerator: 'F11',          click: () => send('menu:debug-into') },
        { label: 'Toggle Breakpoint',  accelerator: 'F8',           click: () => send('menu:breakpoint') },
      ]
    },
    {
      label: 'Terminal',
      submenu: [
        { label: 'New Terminal',       accelerator: IS_MAC ? 'Ctrl+`' : 'Ctrl+`', click: () => send('menu:new-term') },
        { label: 'Split Terminal',     click: () => send('menu:split-term') },
        { label: 'Kill Terminal',      click: () => send('menu:kill-term') },
        { type: 'separator' },
        { label: 'Open System Terminal', click: () => openSystemTerminal() },
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Welcome',     click: () => send('menu:welcome') },
        { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+K CmdOrCtrl+S', click: () => send('menu:keybindings') },
        { label: 'AI Assistant',       click: () => send('menu:ai-panel') },
        { type: 'separator' },
        { label: 'Report Issue',       click: () => shell.openExternal('https://github.com/axiom-ide/axiom/issues') },
        { label: 'Release Notes',      click: () => shell.openExternal('https://github.com/axiom-ide/axiom/releases') },
        { type: 'separator' },
        { label: 'Check for Updates',  click: () => send('menu:check-updates') },
        { type: 'separator' },
        { label: 'About AXIOM', click: () => showAbout() }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── System Tray ──────────────────────────────────────────
function createTray() {
  const iconSize = IS_WIN ? 16 : 18;
  // Generate a simple tray icon from SVG
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABmJLR0QA/wD/AP+gvaeTAAAAV0lEQVQ4jWNgoBn4z8Dw/z8DA5oYAwMDAxMDAwMTAwMDIxMDA5OQAAWQAAAAASUVORK5CYII='
  ).resize({ width: iconSize, height: iconSize });

  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show AXIOM',      click: () => { mainWin?.show(); mainWin?.focus(); } },
    { label: 'New File',        click: () => send('menu:new-file') },
    { label: 'New Terminal',    click: () => send('menu:new-term') },
    { type: 'separator' },
    { label: 'Open in Browser', click: () => shell.openExternal(SERVER_URL) },
    { type: 'separator' },
    { label: 'Quit AXIOM',      click: () => { app.isQuiting = true; app.quit(); } }
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWin) { mainWin.show(); mainWin.focus(); }
  });
}

// ─── IPC Handlers ─────────────────────────────────────────
function setupIPC() {
  // Native folder picker — used instead of the web folder browser
  ipcMain.handle('dialog:open-folder', async () => {
    const result = await dialog.showOpenDialog(mainWin, {
      title: 'Open Folder — AXIOM IDE',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Open Folder'
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  // Native file open
  ipcMain.handle('dialog:open-file', async (_e, opts = {}) => {
    const result = await dialog.showOpenDialog(mainWin, {
      title: 'Open File — AXIOM IDE',
      properties: ['openFile', 'multiSelections'],
      filters: opts.filters || [
        { name: 'All Files', extensions: ['*'] },
        { name: 'Code', extensions: ['js', 'ts', 'py', 'go', 'rs', 'java', 'cpp', 'c', 'h', 'css', 'html', 'json', 'md'] }
      ]
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths;
  });

  // Native save dialog
  ipcMain.handle('dialog:save-file', async (_e, opts = {}) => {
    const result = await dialog.showSaveDialog(mainWin, {
      title: 'Save File — AXIOM IDE',
      defaultPath: opts.defaultPath,
      filters: opts.filters || [{ name: 'All Files', extensions: ['*'] }]
    });
    if (result.canceled) return null;
    return result.filePath;
  });

  // Message box
  ipcMain.handle('dialog:message', async (_e, opts = {}) => {
    const result = await dialog.showMessageBox(mainWin, {
      type: opts.type || 'info',
      buttons: opts.buttons || ['OK'],
      defaultId: 0,
      title: opts.title || APP_NAME,
      message: opts.message || '',
      detail: opts.detail || ''
    });
    return result.response;
  });

  // Open path in system file manager
  ipcMain.on('shell:open-path', (_e, filePath) => shell.openPath(filePath));
  ipcMain.on('shell:open-external', (_e, url) => {
    if (typeof url === 'string' && (url.startsWith('http') || url.startsWith('mailto:'))) {
      shell.openExternal(url);
    }
  });

  // Window controls
  ipcMain.on('window:minimize',  () => mainWin?.minimize());
  ipcMain.on('window:maximize',  () => mainWin?.isMaximized() ? mainWin.unmaximize() : mainWin.maximize());
  ipcMain.on('window:close',     () => mainWin?.close());
  ipcMain.on('window:fullscreen',() => mainWin?.setFullScreen(!mainWin.isFullScreen()));

  // Get app info (sent to renderer for Electron-specific UI tweaks)
  ipcMain.handle('app:info', () => ({
    version:  app.getVersion(),
    platform: process.platform,
    arch:     process.arch,
    dataDir:  DATA_DIR,
    serverUrl: SERVER_URL,
    isElectron: true,
    isMac:    IS_MAC,
    isWin:    IS_WIN
  }));

  // Title update from renderer
  ipcMain.on('app:set-title', (_e, title) => mainWin?.setTitle(title || APP_NAME));

  // Reload server
  ipcMain.on('app:reload', () => mainWin?.webContents.reload());

  // Theme change — apply to native elements
  ipcMain.on('app:theme-changed', (_e, theme) => {
    nativeTheme.themeSource = theme === 'light' ? 'light' : 'dark';
  });
}

// ─── Native Helpers ───────────────────────────────────────
async function nativeOpenFolder() {
  const result = await dialog.showOpenDialog(mainWin, {
    title: 'Open Folder — AXIOM IDE',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Open in AXIOM'
  });
  if (!result.canceled && result.filePaths[0]) {
    mainWin.webContents.executeJavaScript(
      `window._electronOpenFolder && window._electronOpenFolder(${JSON.stringify(result.filePaths[0])})`
    );
  }
}

async function nativeOpenFile() {
  const result = await dialog.showOpenDialog(mainWin, {
    title: 'Open File — AXIOM IDE',
    properties: ['openFile', 'multiSelections']
  });
  if (!result.canceled && result.filePaths.length) {
    mainWin.webContents.executeJavaScript(
      `window._electronOpenFiles && window._electronOpenFiles(${JSON.stringify(result.filePaths)})`
    );
  }
}

function openSystemTerminal() {
  const cwd = DATA_DIR;
  try {
    if (IS_MAC)  { spawn('open', ['-a', 'Terminal', cwd]); }
    else if (IS_WIN) { spawn('cmd', ['/c', 'start', 'cmd.exe'], { cwd, detached: true }); }
    else { ['x-terminal-emulator','gnome-terminal','xterm','xfce4-terminal','konsole'].some(t => { try { spawn(t, { cwd, detached: true }); return true; } catch { return false; } }); }
  } catch (e) { console.error('[Electron] Cannot open system terminal:', e.message); }
}

function showAbout() {
  dialog.showMessageBox(mainWin, {
    type: 'info',
    title: 'About AXIOM IDE',
    message: 'AXIOM IDE v6',
    detail: [
      'East Africa Edition',
      `Version: ${app.getVersion()}`,
      `Electron: ${process.versions.electron}`,
      `Node.js: ${process.versions.node}`,
      `Chromium: ${process.versions.chrome}`,
      `Platform: ${process.platform} ${process.arch}`,
      '',
      'Built with ❤️ in East Africa',
      'Powered by Claude AI'
    ].join('\n'),
    buttons: ['OK', 'Visit Website'],
    defaultId: 0
  }).then(r => {
    if (r.response === 1) shell.openExternal('https://axiom.dev');
  });
}

function createNewWindow() {
  const win = new BrowserWindow({
    width: 1400, height: 900,
    backgroundColor: '#07091a',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  win.loadURL(SERVER_URL);
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('http://localhost')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Helper: send message to renderer
function send(channel, ...args) {
  mainWin?.webContents?.send(channel, ...args);
}

// ─── Deep Link Handler (axiom://) ─────────────────────────
app.setAsDefaultProtocolClient('axiom');
app.on('open-url', (_e, url) => {
  send('app:deep-link', url);
});

// ─── Second Instance ───────────────────────────────────────
app.on('second-instance', (_e, argv) => {
  if (mainWin) {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.focus();
  }
  // Pass any file path argument
  const filePath = argv.find(a => !a.startsWith('-') && fs.existsSync(a));
  if (filePath) send('app:open-file', filePath);
});

// ─── App Lifecycle ────────────────────────────────────────
app.on('ready', async () => {
  nativeTheme.themeSource = 'dark';

  setupIPC();
  buildMenu();

  createSplash();

  try {
    await startServer();
  } catch (e) {
    if (splashWin) splashWin.close();
    dialog.showErrorBox('AXIOM — Server Error', `Failed to start server:\n${e.message}\n\nPlease ensure Node.js is installed and run 'npm install'.`);
    app.quit();
    return;
  }

  createMainWindow();
  createTray();
});

app.on('window-all-closed', () => {
  if (!IS_MAC) {
    if (serverProc) { try { serverProc.kill(); } catch {} }
    app.quit();
  }
});

app.on('activate', () => {
  if (!mainWin) { startServer().then(createMainWindow).catch(() => {}); }
  else { mainWin.show(); mainWin.focus(); }
});

app.on('before-quit', () => {
  app.isQuiting = true;
  if (serverProc) { try { serverProc.kill('SIGTERM'); } catch {} }
  saveWindowState(mainWin);
});

app.on('will-quit', () => {
  if (serverProc) { try { serverProc.kill(); } catch {} }
});

// macOS: prevent quit when clicking dock close with windows open (keep in tray)
app.on('window-all-closed', () => { if (!IS_MAC && !app.isQuiting) return; });

process.on('uncaughtException', err => {
  console.error('[Electron] Uncaught exception:', err);
});
