/* 豆包（火山引擎）端到端实时语音传输层 —— 全双工版（Seeduplex 3.0）。
 *
 * 协议要点：
 *   - 地址 wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue
 *   - 鉴权仅需请求头 X-Api-Key
 *   - 纯 JSON 文本帧，事件以 { type, ... } 收发
 *   - 上行 16k/int16/单声道 PCM，每包 640 字节（20ms），必须按实时节奏发送
 *   - 音频数据在 input_audio_buffer.append / response.output_audio.delta 的 audio、
 *     delta 字段里做 Base64
 *
 * 对话主路径仍是音频进音频出，识别/回复文本只是旁路元数据（字幕与本地记忆）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VoiceDoubao = factory();
})(this, function () {
  'use strict';

  // 上下行事件名（集中一处，便于核对文档）
  var EVT = {
    SESSION_CREATE: 'session.create',
    SESSION_UPDATE: 'session.update',
    SESSION_CLOSE: 'session.close',
    AUDIO_APPEND: 'input_audio_buffer.append',
    AUDIO_COMMIT: 'input_audio_buffer.commit',
    AUDIO_MUTE: 'input_audio_mute.commit',
    AUDIO_UNMUTE: 'input_audio_unmute.commit',
    SPEECH_APPEND: 'speech_text_buffer.replacement.append',
    SPEECH_COMMIT: 'speech_text_buffer.replacement.commit',
    SPEECH_SAY: 'speech_text_buffer.commit',
    RESPONSE_CANCEL: 'response.cancel'
  };

  function toBase64(buf) {
    var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function fromBase64(str) {
    if (typeof Buffer !== 'undefined') return Buffer.from(str, 'base64');
    var bin = atob(str);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  function decodeText(data) {
    if (typeof data === 'string') return data;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) return data.toString('utf8');
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
    return String(data);
  }

  // 服务端事件 → 统一事件（文本只作旁路元数据，主路径是音频）
  function parseEvent(msg) {
    if (!msg || !msg.type) return null;
    switch (msg.type) {
      case 'session.created':
        return { type: 'connected', sessionId: msg.session && msg.session.id };
      case 'session.updated':
        return { type: 'session-updated' };
      case 'session.closed':
        return { type: 'closed', code: 1000, reason: 'session.closed' };
      case 'error': {
        var e = msg.error || {};
        return { type: 'error', message: e.message || e.code || JSON.stringify(msg) };
      }
      case 'input_audio_buffer.committed':
        return null;
      case 'conversation.item.input_audio_transcription.started':
        return { type: 'asr-start' };
      case 'conversation.item.input_audio_transcription.delta': {
        var ap = msg.delta || msg.text || msg.transcript;
        return ap ? { type: 'asr-partial', text: ap } : null;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        var at = msg.transcript || msg.text;
        return at ? { type: 'asr-final', text: at } : null;
      }
      case 'conversation.item.input_audio_transcription.failed':
        return { type: 'error', message: '识别失败: ' + (msg.error || '') };
      case 'response.output_text.delta':
        return msg.delta ? { type: 'reply-delta', text: msg.delta } : null;
      case 'response.output_text.done':
        return (msg.text || msg.delta) ? { type: 'reply-final', text: msg.text || msg.delta } : null;
      case 'response.output_audio.started':
        return { type: 'audio-start' };
      case 'response.output_audio.delta':
        return msg.delta ? { type: 'audio', pcm: fromBase64(msg.delta) } : null;
      case 'response.output_audio.done':
        return { type: 'audio-end' };
      case 'response.done':
        return { type: 'turn-end' };
      default:
        return null;
    }
  }

  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  // 新版控制台用 X-Api-Key；旧版控制台的 appId/accessKey 目前仍被服务端兼容
  function buildHeaders(cfg) {
    if (cfg.apiKey) return { 'X-Api-Key': cfg.apiKey };
    return {
      'X-Api-App-ID': cfg.appId,
      'X-Api-Access-Key': cfg.accessKey,
      'X-Api-Resource-Id': cfg.resourceId || 'volc.speech.dialog',
      'X-Api-App-Key': cfg.appKey || 'PlgvMymc7f3tQnJ6',
      'X-Api-Connect-Id': uuid()
    };
  }

  function createDoubaoProvider(cfg) {
    if (!cfg || !cfg.url) throw new Error('缺少 cfg.url');
    if (!cfg.wsFactory) throw new Error('缺少 WebSocket 实现（Node 端传 require("ws")）');

    return {
      connect: function (ctx) {
        var headers = buildHeaders(cfg);
        var ws = new cfg.wsFactory(cfg.url, { headers: headers, handshakeTimeout: cfg.timeoutMs || 15000 });
        if (ws.binaryType !== undefined) ws.binaryType = 'arraybuffer';

        var ready = false;
        var closing = false;
        var closeTimer = null;

        function send(obj) {
          if (ws.readyState !== 1) return;
          ws.send(JSON.stringify(obj));
        }

        ws.on('open', function () {
          // 允许传 session 对象，或直接传完整的 session.create 事件
          var ev = cfg.session && cfg.session.type
            ? JSON.parse(JSON.stringify(cfg.session))
            : { type: EVT.SESSION_CREATE, session: JSON.parse(JSON.stringify(cfg.session || {})) };
          if (ctx.systemPrompt && ev.session) ev.session.instructions = ctx.systemPrompt;
          send(ev);
        });

        ws.on('message', function (data) {
          var msg;
          try { msg = JSON.parse(decodeText(data)); } catch (e) { return; }
          if (ctx.onRaw) ctx.onRaw(msg);
          if (msg.type === 'session.created') ready = true;
          if (msg.type === 'session.closed') {
            if (closeTimer) clearTimeout(closeTimer);
            try { ws.close(); } catch (e) { /* 忽略 */ }
          }
          var out = parseEvent(msg);
          if (out) ctx.onEvent(out);
        });

        ws.on('error', function (err) {
          ctx.onEvent({ type: 'error', message: String(err && err.message || err) });
        });
        ws.on('close', function (code, reason) {
          if (closeTimer) clearTimeout(closeTimer);
          ctx.onEvent({ type: 'closed', code: code, reason: String(reason || '') });
        });

        return {
          get ready() { return ready; },
          sendAudio: function (pcm) {
            if (!ready) return;
            send({ type: EVT.AUDIO_APPEND, audio: toBase64(pcm) });
          },
          // 直接让模型把这段文本念出来（打招呼）。对话链路仍靠音频输入。
          sendText: function (text) {
            if (!ready) return;
            send({ type: EVT.SPEECH_SAY, text: text });
          },
          // 音频 query 发送完毕，强制模型判停
          commit: function () {
            send({ type: EVT.AUDIO_COMMIT });
          },
          // 老人开口：取消服务端正在进行的播报
          interrupt: function () {
            send({ type: EVT.RESPONSE_CANCEL });
          },
          // 关闭麦克风 / 恢复麦克风（不发音频帧时靠这两个事件保活）
          mute: function () { send({ type: EVT.AUDIO_MUTE }); },
          unmute: function () { send({ type: EVT.AUDIO_UNMUTE }); },
          close: function () {
            if (closing) return;
            closing = true;
            send({ type: EVT.SESSION_CLOSE });
            // 文档要求等 session.closed 回包再断开，否则服务端会报 ContextCanceled
            closeTimer = setTimeout(function () {
              try { ws.close(); } catch (e) { /* 忽略 */ }
            }, 800);
          }
        };
      }
    };
  }

  return { EVT: EVT, createDoubaoProvider: createDoubaoProvider, parseEvent: parseEvent };
});
