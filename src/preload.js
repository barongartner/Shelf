'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (name) => (...args) => ipcRenderer.invoke(name, ...args);

contextBridge.exposeInMainWorld('shelf', {
  platform: process.platform,
  getState: call('state'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onFlash: (cb) => ipcRenderer.on('flash', (_e, msg) => cb(msg)),
  onOpenSettings: (cb) => ipcRenderer.on('open-settings', () => cb()),
  onOpenPhone: (cb) => ipcRenderer.on('open-phone', () => cb()),
  pathFor: (file) => webUtils.getPathForFile(file),

  addPaths: call('add-paths'),
  addText: call('add-text'),
  paste: call('paste'),
  drag: (id) => ipcRenderer.send('drag', id),
  take: call('take'),
  keep: call('keep'),
  remove: call('remove'),
  open: call('open'),
  reveal: call('reveal'),
  quickLook: call('quick-look'),
  save: call('save'),
  copyText: call('copy-text'),
  contextMenu: call('context-menu'),
  clearAll: call('clear-all'),

  setSetting: call('set-setting'),
  join: call('join'),
  joinCode: call('join-code'),
  addIp: call('add-ip'),
  newShelf: call('new-shelf'),
  copyCode: call('copy-code'),
  hide: call('hide'),
  confirm: call('confirm'),

  phoneRefresh: call('phone-refresh'),
  phoneCopyUrl: call('phone-copy-url'),
  phoneOpen: call('phone-open'),
  deviceRemove: call('device-remove'),
  deviceRename: call('device-rename'),
});
