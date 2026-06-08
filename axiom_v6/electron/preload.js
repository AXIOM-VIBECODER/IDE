'use strict';
/**
 * AXIOM v6 — Electron Preload Script
 * Exposes safe IPC APIs to the renderer (web app) via contextBridge.
 * The web app detects `window.axiomElectron` to enable native features.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('axiomElectron', {
  // ── Detection ──────────────────────────────────────────
  isElectron: true,

  // ── App Info ───────────────────────────────────────────
  getInfo: () => ipcRenderer.invoke('app:info'),

  // ── Native Dialogs ─────────────────────────────────────
  openFolder: () => ipcRenderer.invoke('dialog:open-folder'),
  openFile:  (opts) => ipcRenderer.invoke('dialog:open-file', opts),
  saveFile:  (opts) => ipcRenderer.invoke('dialog:save-file', opts),
  showMessage: (opts) => ipcRenderer.invoke('dialog:message', opts),

  // ── Shell ──────────────────────────────────────────────
  openPath:     (p)   => ipcRenderer.send('shell:open-path', p),
  openExternal: (url) => ipcRenderer.send('shell:open-external', url),

  // ── Window Controls ────────────────────────────────────
  minimize:    () => ipcRenderer.send('window:minimize'),
  maximize:    () => ipcRenderer.send('window:maximize'),
  close:       () => ipcRenderer.send('window:close'),
  fullscreen:  () => ipcRenderer.send('window:fullscreen'),

  // ── App Actions ────────────────────────────────────────
  setTitle:    (t) => ipcRenderer.send('app:set-title', t),
  reload:      ()  => ipcRenderer.send('app:reload'),
  setTheme:    (t) => ipcRenderer.send('app:theme-changed', t),

  // ── Event Listeners (main → renderer) ──────────────────
  on: (channel, fn) => {
    const allowed = [
      'menu:new-file', 'menu:save', 'menu:save-as', 'menu:save-all',
      'menu:close-tab', 'menu:find', 'menu:replace', 'menu:find-in-files',
      'menu:comment', 'menu:format', 'menu:palette', 'menu:quick-open',
      'menu:panel-files', 'menu:panel-search', 'menu:panel-git',
      'menu:terminal', 'menu:ai-panel', 'menu:sidebar', 'menu:zen',
      'menu:split', 'menu:run', 'menu:debug', 'menu:debug-stop',
      'menu:debug-step', 'menu:debug-into', 'menu:breakpoint',
      'menu:new-term', 'menu:split-term', 'menu:kill-term',
      'menu:welcome', 'menu:keybindings', 'menu:check-updates',
      'app:open-file', 'app:deep-link'
    ];
    if (!allowed.includes(channel)) return;
    const wrapped = (_event, ...args) => fn(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  once: (channel, fn) => {
    ipcRenderer.once(channel, (_event, ...args) => fn(...args));
  }
});
