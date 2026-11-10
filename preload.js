/* 预加载脚本（sandbox 模式下只允许 require('electron')）。
 * 只向页面暴露语音需要的几个方法，密钥与网络请求都不进渲染进程。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tractorVoice', {
  start: () => ipcRenderer.invoke('voice:start'),
  stop: () => ipcRenderer.invoke('voice:stop'),
  // pcm 用 ArrayBuffer 传，避免页面上出现 Node 的 Buffer
  audio: pcm => ipcRenderer.send('voice:audio', pcm),
  text: text => ipcRenderer.send('voice:text', text),
  // 主动开口，交给大模型生成口语回复（定时提醒、牌局点评）
  ask: query => ipcRenderer.send('voice:ask', query),
  // 实时牌局摘要：让每次对话都知道现在打到哪
  context: text => ipcRenderer.send('voice:context', text),
  interrupt: () => ipcRenderer.send('voice:interrupt'),
  onEvent: cb => {
    const handler = (e, ev) => cb(ev);
    ipcRenderer.on('voice:event', handler);
    return () => ipcRenderer.removeListener('voice:event', handler);
  }
});
