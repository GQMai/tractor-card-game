/* 豆包（火山引擎）流式语音识别传输层 —— 大模型流式 ASR 2.0。
 *
 * 协议要点（2025 版）：
 *   - 地址 wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async
 *   - 请求头 X-Api-Key / X-Api-Resource-Id（小时版 volc.seedasr.sauc.duration）/ X-Api-Request-Id
 *   - 上行 16k/16bit/单声道 PCM，二进制自定义帧（4 字节协议头 + 4 字节长度 + payload）
 *   - 服务端按端窗口切句，utterances[].definite=true 即一句定稿；is_last_package 表示整段结束
 *   - 粤语无需显式声明 language，异步模式会自动识别
 *
 * 只负责「音频进、文本出」，会话编排在 cascade-provider.js。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VoiceAsrDoubao = factory();
})(this, function () {
  'use strict';

  var TYPE = { FULL_CLIENT: 1, AUDIO_ONLY: 2, FULL_SERVER: 9, ERROR: 15 };
  var FLAG = { NONE: 0, LAST: 2 };
  var SERIAL = { RAW: 0, JSON: 1 };
  var COMP = { NONE: 0, GZIP: 1 };

  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function pack(type, flags, serialization, payload) {
    var body = payload || Buffer.alloc(0);
    var head = Buffer.alloc(4);
    head[0] = 0x11; // version 1，头长 4 字节
    head[1] = (type << 4) | flags;
    head[2] = (serialization << 4) | COMP.NONE;
    head[3] = 0x00;
    var size = Buffer.alloc(4);
    size.writeUInt32BE(body.length, 0);
    return Buffer.concat([head, size, body]);
  }

  // 响应帧：4B 头 (+4B sequence) (+4B 错误码) + 4B 长度 + payload
  function unpack(buf) {
    if (buf.length < 4) return null;
    var headerSize = (buf[0] & 0x0f) * 4;
    var type = buf[1] >> 4;
    var flags = buf[1] & 0x0f;
    var comp = buf[2] & 0x0f;
    var off = headerSize;
    var seq = null;
    if (flags & 0x01) {
      if (buf.length < off + 4) return null;
      seq = buf.readInt32BE(off);
      off += 4;
    }
    var code = null;
    if (type === TYPE.ERROR) {
      if (buf.length < off + 4) return null;
      code = buf.readInt32BE(off);
      off += 4;
    }
    if (buf.length < off + 4) return null;
    var size = buf.readUInt32BE(off);
    off += 4;
    var payload;
    if (comp === COMP.GZIP) {
      try {
        payload = require('zlib').gunzipSync(buf.slice(off, off + size));
      } catch (e) {
        return null;
      }
    } else {
      payload = buf.slice(off, off + size);
    }
    return { type: type, flags: flags, seq: seq, code: code, payload: payload };
  }

  function buildStartPayload(cfg) {
    return {
      user: { uid: cfg.uid || 'tractor-voice' },
      audio: { format: 'pcm', codec: 'raw', rate: cfg.rate || 16000, bits: 16, channel: 1 },
      request: {
        model_name: cfg.modelName || 'bigmodel',
        enable_itn: true,
        enable_punc: true,
        enable_ddc: true,
        show_utterances: true,
        result_type: 'full',
        end_window_size: cfg.endWindowSize || 800,
        force_to_speech_time: 1000
      }
    };
  }

  /* cfg:
   *   apiKey / appId+accessKey（旧版控制台）
   *   url、resourceId、modelName、endWindowSize、uid、timeoutMs
   *   wsFactory 必填（Node 端传 require('ws')）
   */
  function createDoubaoAsr(cfg) {
    if (!cfg || !cfg.wsFactory) throw new Error('缺少 WebSocket 实现');

    return {
      connect: function (ctx) {
        var url = cfg.url || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';
        var headers = {
          'X-Api-Key': cfg.apiKey,
          'X-Api-Resource-Id': cfg.resourceId || 'volc.seedasr.sauc.duration',
          'X-Api-Request-Id': uuid(),
          'X-Api-Connect-Id': uuid()
        };
        if (!cfg.apiKey) {
          headers = {
            'X-Api-App-ID': cfg.appId,
            'X-Api-Access-Key': cfg.accessKey,
            'X-Api-Resource-Id': cfg.resourceId || 'volc.seedasr.sauc.duration',
            'X-Api-Connect-Id': uuid()
          };
        }

        var ws = new cfg.wsFactory(url, { headers: headers, handshakeTimeout: cfg.timeoutMs || 15000 });
        var opened = false;
        var finished = false;
        var closed = false;
        // 服务端每次都把历史 utterances 全量返回，必须按句子身份去重，
        // 否则已定稿的句子会被反复重发。用 start_time 作为同一句的标识。
        var uttState = Object.create(null);
        var lastFull = '';

        function emit(ev) { ctx.onEvent(ev); }

        function handleJson(msg) {
          if (msg.code && msg.code !== 20000000 && msg.code !== 0) {
            emit({ type: 'error', message: 'ASR ' + msg.code + ': ' + (msg.message || '') });
          }
          var result = msg.result || {};
          var utts = result.utterances || [];
          for (var i = 0; i < utts.length; i++) {
            var u = utts[i];
            var t = u.text || '';
            if (!t) continue;
            var key = u.start_time != null ? String(u.start_time) : 'i' + i;
            var st = uttState[key];
            if (!st) st = uttState[key] = { text: '', done: false };
            if (st.done) continue; // 这句已经定稿过，跳过
            if (t !== st.text) {
              st.text = t;
              emit({ type: 'asr-partial', text: t });
            }
            if (u.definite) {
              st.done = true;
              emit({ type: 'asr-final', text: t });
            }
          }
          // 没有 utterances 时退回全文（single 模式）
          if (!utts.length && result.text && result.text !== lastFull) {
            lastFull = result.text;
            emit({ type: 'asr-partial', text: result.text });
          }
          if (msg.is_last_package && !closed) {
            closed = true;
            try { ws.close(); } catch (e) { /* 忽略 */ }
          }
        }

        ws.on('open', function () {
          opened = true;
          try {
            var payload = Buffer.from(JSON.stringify(buildStartPayload(cfg)), 'utf8');
            ws.send(pack(TYPE.FULL_CLIENT, FLAG.NONE, SERIAL.JSON, payload));
          } catch (e) {
            emit({ type: 'error', message: 'ASR 首帧发送失败: ' + e.message });
            return;
          }
          if (ctx.onOpen) ctx.onOpen();
        });

        ws.on('message', function (data) {
          var buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
          var frame = unpack(buf);
          if (!frame) return;
          if (frame.type === TYPE.ERROR) {
            var detail = frame.payload.toString('utf8');
            emit({ type: 'error', message: 'ASR 服务端错误 ' + frame.code + ': ' + detail.slice(0, 200) });
            return;
          }
          if (frame.type !== TYPE.FULL_SERVER && frame.type !== 10) return;
          var json;
          try { json = JSON.parse(frame.payload.toString('utf8')); } catch (e) { return; }
          if (ctx.onRaw) ctx.onRaw(json);
          handleJson(json);
        });

        ws.on('error', function (err) {
          emit({ type: 'error', message: 'ASR 连接错误: ' + (err && err.message || err) });
        });
        ws.on('unexpected-response', function (req, res) {
          emit({ type: 'error', message: 'ASR 握手失败 HTTP ' + res.statusCode + '（检查 apiKey / resourceId 是否开通）' });
        });
        ws.on('close', function (code, reason) {
          if (opened) emit({ type: 'closed', code: code, reason: String(reason || '') });
        });

        return {
          get opened() { return opened; },
          // 持续送音频，由服务端负责切句
          pushAudio: function (pcm) {
            if (!opened || !pcm || !pcm.length) return;
            try { ws.send(pack(TYPE.AUDIO_ONLY, FLAG.NONE, SERIAL.RAW, pcm)); } catch (e) { /* 忽略单帧失败 */ }
          },
          // 结束整段音频（老人停止说话/关闭麦克风）
          finish: function () {
            if (!opened || finished) return;
            finished = true;
            try { ws.send(pack(TYPE.AUDIO_ONLY, FLAG.LAST, SERIAL.RAW, Buffer.alloc(0))); } catch (e) { /* 忽略 */ }
          },
          close: function () {
            try { ws.close(); } catch (e) { /* 忽略 */ }
          }
        };
      }
    };
  }

  return {
    TYPE: TYPE,
    FLAG: FLAG,
    createDoubaoAsr: createDoubaoAsr,
    pack: pack,
    unpack: unpack,
    buildStartPayload: buildStartPayload
  };
});
