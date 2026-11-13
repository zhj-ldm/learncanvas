'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (data) => ipcRenderer.invoke('state:save', data),
  chat: (payload) => ipcRenderer.invoke('ai:chat', payload),
  abort: (requestId) => ipcRenderer.invoke('ai:abort', requestId),
  onToken: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('ai:token', h);
    return () => ipcRenderer.removeListener('ai:token', h);
  },
  runTool: (name, input, workdir) => ipcRenderer.invoke('tool:run', { name, input, workdir }),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  exportJson: (payload) => ipcRenderer.invoke('io:export-json', payload),
  importJson: () => ipcRenderer.invoke('io:import-json'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  voiceStatus: () => ipcRenderer.invoke('voice:status'),
  voiceDownload: () => ipcRenderer.invoke('voice:download'),
  voiceAsr: (samples, sampleRate) => ipcRenderer.invoke('voice:asr', { samples, sampleRate }),
  voiceTts: (payload) => ipcRenderer.invoke('voice:tts', payload),
  voiceVoices: () => ipcRenderer.invoke('voice:voices'),
  onVoiceProgress: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('voice:progress', h);
    return () => ipcRenderer.removeListener('voice:progress', h);
  },
});
