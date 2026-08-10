const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld(
  'runtime',
  Object.freeze({ electron: process.versions.electron })
);
