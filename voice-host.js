/* 主进程语音宿主：把级联 Provider（豆包流式 ASR → 远端 LLM → Edge TTS）接到渲染进程。
 *
 * 渲染进程只负责采音与播放，密钥读取、WebSocket、HTTP 全部留在主进程，
 * 因此 contextIsolation + sandbox 无需放开，也不会把 apiKey 暴露给页面。
 */
'use strict';

var V = require('./renderer/voice/config.js');
var Cascade = require('./renderer/voice/cascade-provider.js');

// audio 事件的 pcm 是 Buffer，统一改名 data 便于渲染进程按 Uint8Array 接收
function toRenderer(ev) {
  if (ev.type === 'audio') return { type: 'audio', codec: ev.codec || 'mp3', data: ev.pcm };
  if (ev.type === 'error') return { type: 'error', message: ev.message };
  return ev;
}

function createVoiceHost(opts) {
  var send = opts.send;
  var WebSocket = opts.WebSocket;
  var cfg = null;
  var api = null;
  var gameContext = ''; // 渲染进程推上来的实时牌局摘要

  return {
    get running() { return !!api; },

    start: function () {
      if (api) return { ok: true, already: true, llmReady: !!(cfg && cfg.llm.apiKey) };
      cfg = V.load(opts.configPath);

      var provider = Cascade.createCascadeProvider({
        asr: {
          apiKey: cfg.apiKey,
          appId: cfg.appId,
          accessKey: cfg.accessKey,
          url: cfg.asr.url,
          resourceId: cfg.asr.resourceId,
          modelName: cfg.asr.modelName,
          endWindowSize: cfg.asr.endWindowSize
        },
        llm: cfg.llm,
        tts: cfg.tts,
        vad: cfg.vad,
        wsFactory: WebSocket
      });

      api = provider.connect({
        systemPrompt: cfg.instructions + '\n' + cfg.cascadePersona,
        // 每次对话都带上最新牌局，老人问「现在打到点样」也答得出
        getContext: function () { return gameContext; },
        onEvent: function (ev) { send(toRenderer(ev)); }
      });

      return {
        ok: true,
        asr: cfg.asr.url !== false,
        llmReady: !!cfg.llm.apiKey,
        voice: cfg.tts.voice
      };
    },

    audio: function (buf) {
      if (!api || !buf) return;
      api.sendAudio(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    },

    text: function (t) {
      if (api && t) api.sendText(t);
    },

    // 主动聊一句：文本交给 LLM 生成口语回复（牌局点评、闲聊）
    ask: function (q) {
      if (api && q) api.ask(q);
    },

    // 更新实时牌局摘要（渲染进程每几秒推一次）
    context: function (t) {
      gameContext = t || '';
    },

    interrupt: function () {
      if (api) api.interrupt();
    },

    stop: function () {
      if (!api) return;
      try { api.close(); } catch (e) { /* 忽略 */ }
      api = null;
    }
  };
}

/* 注册 IPC，返回宿主句柄。
 *   opts: { WebSocket: ws 模块, configPath?: string }
 * 渲染进程 → 主进程：voice:start / voice:stop / voice:audio / voice:text / voice:interrupt
 * 主进程 → 渲染进程：voice:event
 */
function registerVoiceIpc(ipcMain, opts) {
  var target = null;

  function send(ev) {
    if (target && !target.isDestroyed()) target.webContents.send('voice:event', ev);
  }

  var host = createVoiceHost({ send: send, WebSocket: opts.WebSocket, configPath: opts.configPath });

  ipcMain.handle('voice:start', function () {
    try {
      return host.start();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('voice:stop', function () {
    host.stop();
    return { ok: true };
  });

  ipcMain.on('voice:audio', function (e, buf) { host.audio(buf); });
  ipcMain.on('voice:text', function (e, text) { host.text(text); });
  ipcMain.on('voice:ask', function (e, q) { host.ask(q); });
  ipcMain.on('voice:context', function (e, t) { host.context(t); });
  ipcMain.on('voice:interrupt', function () { host.interrupt(); });

  return {
    host: host,
    attach: function (win) { target = win; }
  };
}

module.exports = {
  createVoiceHost: createVoiceHost,
  registerVoiceIpc: registerVoiceIpc,
  toRenderer: toRenderer
};
