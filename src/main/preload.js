'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /** Calls a main-process handler; resolves to its data or throws its error message. */
  async call(channel, ...args) {
    const r = await ipcRenderer.invoke(channel, ...args);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  },
  on(channel, fn) {
    const allowed = ['progress', 'download:found'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
