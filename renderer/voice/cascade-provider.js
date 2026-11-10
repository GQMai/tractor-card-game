/* 级联对话 Provider：豆包流式 ASR → 远端 LLM → Edge TTS（粤语女声）。
 *
 * 事件契约与 provider.js 一致：
 *   asr-partial / asr-final / reply-delta / reply-final / audio / turn-end / error
 *   audio 事件带 codec:'mp3'（Edge 朗读接口只支持 mp3 / opus），播放端负责解码。
 *
 * 与端到端 S2S 的区别：延迟略高（ASR 定稿 + LLM + TTS 首包约 2~3 秒），
 * 但粤语发音地道、成本约 1 元/天，适合老人陪聊。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./asr-doubao.js'), require('./llm.js'), require('./edge-tts.js'));
  } else {
    root.VoiceCascade = factory(root.VoiceAsrDoubao, root.VoiceLlm, root.EdgeTts);
  }
})(this, function (Asr, Llm, EdgeTts) {
  'use strict';

  var PUNCT = /[。！？!?；;\n]/;
  var SOFT_PUNCT = /[，,、：:]/;

  // 把流式文本切成适合朗读的句子：硬标点必切，超长时在逗号处切
  function splitSentences(buffer, opt) {
    opt = opt || {};
    var minLen = opt.minLen || 6;
    var maxLen = opt.maxLen || 40;
    var out = [];
    var pending = '';
    var rest = String(buffer || '');

    while (rest.length) {
      var idx = -1;
      for (var i = 0; i < rest.length; i++) {
        if (PUNCT.test(rest[i])) { idx = i; break; }
      }
      if (idx >= 0) {
        pending += rest.slice(0, idx + 1);
        rest = rest.slice(idx + 1);
        if (pending.replace(/\s/g, '').length >= minLen) {
          out.push(pending.trim());
          pending = '';
        }
        continue;
      }
      var joined = pending + rest;
      if (joined.replace(/\s/g, '').length <= maxLen) break;
      var soft = -1;
      for (var j = maxLen; j >= minLen; j--) {
        if (SOFT_PUNCT.test(joined[j - 1])) { soft = j; break; }
      }
      var take = soft > 0 ? soft : maxLen;
      out.push(joined.slice(0, take).trim());
      rest = joined.slice(take);
      pending = '';
    }
    return { sentences: out, rest: pending + rest };
  }

  // 轻量能量 VAD：只用于「老人开口打断播报」，切句交给 ASR 端窗口
  function createVad(opt) {
    opt = opt || {};
    var threshold = opt.threshold || 900;
    var loudFrames = 0;
    var loudNeeded = opt.loudMs ? Math.ceil(opt.loudMs / 20) : 15; // 默认连续 300ms
    var speaking = false;

    return {
      reset: function () { loudFrames = 0; speaking = false; },
      // 返回 true 表示检测到持续说话（用于打断）
      push: function (pcm) {
        var samples = pcm.length >> 1;
        if (!samples) return false;
        var sum = 0;
        for (var i = 0; i < samples; i++) {
          var v = pcm.readInt16LE(i * 2);
          sum += v * v;
        }
        var rms = Math.sqrt(sum / samples);
        if (rms > threshold) {
          loudFrames++;
          if (loudFrames >= loudNeeded && !speaking) {
            speaking = true;
            return true;
          }
        } else {
          loudFrames = Math.max(0, loudFrames - 1);
          if (loudFrames === 0) speaking = false;
        }
        return false;
      }
    };
  }

  /* cfg: {
   *   asr: { apiKey|appId+accessKey, url, resourceId, modelName, endWindowSize },
   *   llm: { baseUrl, apiKey, model },
   *   tts: { voice, rate, format },
   *   vad: { threshold, loudMs },
   *   wsFactory 必填（Node 端 require('ws')）
   * }
   */
  function createCascadeProvider(cfg) {
    var ttsCfg = cfg.tts || {};
    var vadCfg = cfg.vad || {};

    return {
      connect: function (ctx) {
        var onEvent = ctx.onEvent;
        var speaking = false;
        var muted = false;
        var turn = null;
        var asrBuffer = Buffer.alloc(0);
        var vad = createVad(vadCfg);
        var closed = false;
        var history = []; // 最近几轮对话，带给 LLM 保持连贯

        function emit(ev) {
          if (closed && ev.type !== 'closed') return;
          onEvent(ev);
        }

        function cancelTurn() {
          if (!turn) return;
          turn.cancelled = true;
          if (turn.llmJob) turn.llmJob.abort();
          if (turn.ttsJob) turn.ttsJob.abort();
          turn.queue.length = 0;
          turn = null;
          speaking = false;
          vad.reset();
        }

        function finishTurn(t) {
          if (t !== turn || t.cancelled) return;
          var full = (t.text || '').trim();
          if (full) emit({ type: 'reply-final', text: full });
          emit({ type: 'turn-end' });
          turn = null;
          speaking = false;
          vad.reset();
        }

        function pump(t) {
          if (t !== turn || t.cancelled) return;
          if (t.pumping) return;
          if (!t.queue.length) {
            if (t.llmDone) finishTurn(t);
            return;
          }
          t.pumping = true;
          var sentence = t.queue.shift();
          var job = EdgeTts.createEdgeTts({
            text: sentence,
            voice: ttsCfg.voice || EdgeTts.VOICES.hiukaan,
            rate: ttsCfg.rate || '-10%',
            format: ttsCfg.format || EdgeTts.FORMAT_MP3,
            wsFactory: cfg.wsFactory,
            timeoutMs: cfg.ttsTimeoutMs || 20000
          });
          t.ttsJob = job;
          var ttsStart = Date.now();
          job.promise.then(function (r) {
            if (t !== turn || t.cancelled) return;
            if (t.stats.ttsFirst === null) t.stats.ttsFirst = Date.now() - ttsStart;
            emit({ type: 'audio', pcm: r.mp3, codec: 'mp3' });
          }).catch(function (err) {
            if (t !== turn || t.cancelled) return;
            emit({ type: 'error', message: 'TTS 失败: ' + err.message });
          }).then(function () {
            t.pumping = false;
            if (t === turn && !t.cancelled) pump(t);
          });
        }

        function enqueue(t, text) {
          if (!text) return;
          var last = t.queue.length ? t.queue[t.queue.length - 1] : null;
          if (last && last.length < 8) t.queue[t.queue.length - 1] = last + text;
          else t.queue.push(text);
          pump(t);
        }

        // 老人说完一句：起一轮 LLM + 分句朗读
        function startTurn(query, silent) {
          cancelTurn();
          var t = {
            cancelled: false,
            text: '',
            buffer: '',
            queue: [],
            llmDone: false,
            pumping: false,
            llmJob: null,
            ttsJob: null,
            stats: { t0: Date.now(), llmFirst: null, ttsFirst: null }
          };
          turn = t;
          speaking = true;
          vad.reset();

          var llm = (cfg.llmFactory || Llm.createLlm)(cfg.llm || {});
          // 系统提示 + 实时牌局摘要：老人随口问「现在打到哪了」也能接得上
          var system = ctx.systemPrompt || '';
          if (ctx.getContext) {
            var live = '';
            try { live = ctx.getContext() || ''; } catch (e) { live = ''; }
            if (live) system += '\n【当前牌局】' + live;
          }
          // 带最近几轮对话，避免每次回复都像第一次见面
          var messages = history.slice(-4).concat([{ role: 'user', content: query }]);
          t.llmJob = llm.chat({
            system: system,
            messages: messages,
            onDelta: function (delta) {
              if (t !== turn || t.cancelled) return;
              if (t.stats.llmFirst === null) t.stats.llmFirst = Date.now() - t.stats.t0;
              t.text += delta;
              emit({ type: 'reply-delta', text: delta });
              t.buffer += delta;
              var cut = splitSentences(t.buffer, cfg.split);
              t.buffer = cut.rest;
              cut.sentences.forEach(function (s) { enqueue(t, s); });
            },
            onDone: function () {
              if (t !== turn || t.cancelled) return;
              t.llmDone = true;
              if (t.text && !silent) {
                history.push({ role: 'user', content: query },
                             { role: 'assistant', content: t.text });
                if (history.length > 8) history.splice(0, history.length - 8);
              }
              if (t.buffer.trim()) {
                enqueue(t, t.buffer.trim());
                t.buffer = '';
              }
              pump(t);
            },
            onError: function (err) {
              if (t !== turn || t.cancelled) return;
              emit({ type: 'error', message: 'LLM 失败: ' + err.message });
            }
          });
          // abort() 会让 promise 以「aborted」拒绝，这里吸收掉，避免未处理的 rejection
          if (t.llmJob && t.llmJob.promise && t.llmJob.promise.catch) {
            t.llmJob.promise.catch(function () { /* 已由 onError 上报，或属于主动打断 */ });
          }
        }

        var asrOn = !!(cfg.asr && cfg.asr.url !== false);
        var asr = asrOn ? Asr.createDoubaoAsr({
          apiKey: (cfg.asr || {}).apiKey,
          appId: (cfg.asr || {}).appId,
          accessKey: (cfg.asr || {}).accessKey,
          url: (cfg.asr || {}).url,
          resourceId: (cfg.asr || {}).resourceId,
          modelName: (cfg.asr || {}).modelName,
          endWindowSize: (cfg.asr || {}).endWindowSize,
          wsFactory: cfg.wsFactory,
          timeoutMs: cfg.asrTimeoutMs
        }).connect({
          onRaw: cfg.onRaw,
          onEvent: function (ev) {
            if (ev.type === 'asr-partial') {
              emit(ev);
              return;
            }
            if (ev.type === 'asr-final') {
              // 播报中收到的定稿视作回声，忽略；打断由 VAD 负责
              if (speaking) return;
              emit(ev);
              if (ev.text) startTurn(ev.text);
              return;
            }
            if (ev.type === 'error' || ev.type === 'closed') emit(ev);
          }
        }) : null;

        return {
          get speaking() { return speaking; },
          sendAudio: function (pcm) {
            if (!pcm || !pcm.length || closed || !asr) return;
            if (!muted) {
              asrBuffer = Buffer.concat([asrBuffer, pcm]);
              while (asrBuffer.length >= 3200) { // 每 100ms 送一包，降低帧开销
                asr.pushAudio(asrBuffer.slice(0, 3200));
                asrBuffer = asrBuffer.slice(3200);
              }
              if (speaking && vad.push(pcm)) {
                // 老人开口打断：停播报，等这句 ASR 定稿
                cancelTurn();
                emit({ type: 'interrupted' });
              }
            }
          },
          // 直接念一段文本（开场问候），不经过 LLM
          sendText: function (text) {
            if (!text) return;
            cancelTurn();
            var cut = splitSentences(text, cfg.split);
            var queue = cut.sentences.slice();
            if (cut.rest.trim()) queue.push(cut.rest.trim());
            if (!queue.length) queue.push(String(text));
            var t = {
              cancelled: false, text: text, buffer: '', queue: queue,
              llmDone: true, pumping: false, llmJob: null, ttsJob: null,
              stats: { t0: Date.now(), llmFirst: null, ttsFirst: null }
            };
            turn = t;
            speaking = true;
            pump(t);
          },
          // 主动开口：把一句提示当作「用户消息」送进 LLM，让它用一两句口语回应
          // silent=true 时不计入对话历史，避免系统提示被当成老人说的话
          ask: function (query) {
            if (!query) return;
            startTurn(query, true);
          },
          interrupt: function () {
            cancelTurn();
          },
          mute: function () { muted = true; asrBuffer = Buffer.alloc(0); },
          unmute: function () { muted = false; vad.reset(); },
          close: function () {
            closed = true;
            cancelTurn();
            try { asr && asr.close(); } catch (e) { /* 忽略 */ }
          }
        };
      }
    };
  }

  return {
    createCascadeProvider: createCascadeProvider,
    createVad: createVad,
    splitSentences: splitSentences
  };
});
