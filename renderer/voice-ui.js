/* 语音陪聊前端：麦克风采集 16k PCM → 主进程级联对话（ASR → LLM → Edge TTS）→ 播放 mp3。
 *
 * 页面上只做采音与播放，密钥和网络请求都在主进程（见 voice-host.js）。
 * 语音开关由顶栏「语音」按钮控制，状态与识别/回复文本显示在牌桌左上角。
 */
(function () {
  'use strict';

  var bridge = window.tractorVoice;
  var btn = document.getElementById('btnVoice');
  var bar = document.getElementById('voiceBar');
  var stateEl = document.getElementById('voiceState');
  var lineEl = document.getElementById('voiceLine');

  if (!btn || !bar) return;
  if (!bridge) {
    btn.disabled = true;
    btn.textContent = '语音：不可用';
    return;
  }

  var SEND_SAMPLES = 1600; // 100ms @16kHz

  var active = false;
  var busy = false;
  var replyText = '';
  var mic = { ctx: null, stream: null, source: null, processor: null, sink: null, pending: null };
  var play = { ctx: null, chain: Promise.resolve(), sources: [], at: 0 };

  // 供 reminder.js 判断能不能主动开口（不抢话、不打断）
  var voiceState = window.tractorVoiceState = window.tractorVoiceState || {};
  voiceState.active = false;
  voiceState.speaking = false;
  voiceState.lastHeardAt = 0;
  voiceState.llmReady = false;

  // ------------------------------------------------------------- 状态显示
  function setState(text, kind) {
    stateEl.textContent = text;
    stateEl.className = kind || '';
  }

  function setLine(text) {
    lineEl.textContent = text || '';
  }

  // ------------------------------------------------------------- 麦克风采音
  function appendPcm(int16) {
    var merged = new Int16Array(mic.pending.length + int16.length);
    merged.set(mic.pending, 0);
    merged.set(int16, mic.pending.length);
    var offset = 0;
    while (merged.length - offset >= SEND_SAMPLES) {
      var chunk = merged.subarray(offset, offset + SEND_SAMPLES);
      bridge.audio(new Int16Array(chunk).buffer);
      offset += SEND_SAMPLES;
    }
    mic.pending = merged.slice(offset);
  }

  function openMic() {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    }).then(function (stream) {
      mic.stream = stream;
      var Ctx = window.AudioContext || window.webkitAudioContext;
      // 直接把上下文定在 16k，Chromium 会自动重采样麦克风输入
      mic.ctx = new Ctx({ sampleRate: 16000 });
      mic.source = mic.ctx.createMediaStreamSource(stream);
      mic.processor = mic.ctx.createScriptProcessor(2048, 1, 1);
      mic.sink = mic.ctx.createGain();
      mic.sink.gain.value = 0; // 静音旁路，只为让 processor 持续触发
      mic.source.connect(mic.processor);
      mic.processor.connect(mic.sink);
      mic.sink.connect(mic.ctx.destination);
      mic.pending = new Int16Array(0);

      mic.processor.onaudioprocess = function (e) {
        if (!active) return;
        var input = e.inputBuffer.getChannelData(0);
        var pcm = new Int16Array(input.length);
        for (var i = 0; i < input.length; i++) {
          var v = input[i];
          if (v > 1) v = 1;
          else if (v < -1) v = -1;
          pcm[i] = v < 0 ? v * 32768 : v * 32767;
        }
        appendPcm(pcm);
      };

      if (mic.ctx.state === 'suspended') return mic.ctx.resume();
      return null;
    });
  }

  function closeMic() {
    if (mic.processor) {
      mic.processor.onaudioprocess = null;
      try { mic.processor.disconnect(); } catch (e) { /* 忽略 */ }
    }
    if (mic.sink) { try { mic.sink.disconnect(); } catch (e) { /* 忽略 */ } }
    if (mic.source) { try { mic.source.disconnect(); } catch (e) { /* 忽略 */ } }
    if (mic.stream) {
      mic.stream.getTracks().forEach(function (t) { t.stop(); });
    }
    if (mic.ctx) { try { mic.ctx.close(); } catch (e) { /* 忽略 */ } }
    mic = { ctx: null, stream: null, source: null, processor: null, sink: null, pending: null };
  }

  // ------------------------------------------------------------- 播报播放
  function ensurePlayCtx() {
    if (!play.ctx) {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      play.ctx = new Ctx();
    }
    if (play.ctx.state === 'suspended') play.ctx.resume();
  }

  function stopPlayback() {
    play.sources.slice().forEach(function (src) {
      try { src.stop(0); } catch (e) { /* 忽略 */ }
    });
    play.sources.length = 0;
    play.at = 0;
    play.chain = Promise.resolve();
  }

  function playChunk(bytes) {
    ensurePlayCtx();
    var copy = new Uint8Array(bytes).slice().buffer;
    // 解码是异步的，用链式串行保证分句按顺序排进时间线
    play.chain = play.chain.then(function () {
      return play.ctx.decodeAudioData(copy).then(function (buffer) {
        var src = play.ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(play.ctx.destination);
        play.sources.push(src);
        src.onended = function () {
          var i = play.sources.indexOf(src);
          if (i >= 0) play.sources.splice(i, 1);
        };
        var at = Math.max(play.ctx.currentTime + 0.05, play.at);
        src.start(at);
        play.at = at + buffer.duration;
      });
    }).catch(function () { /* 单个分片解码失败不影响后续 */ });
  }

  // ------------------------------------------------------------- 事件
  bridge.onEvent(function (ev) {
    if (!active) return;
    switch (ev.type) {
      case 'asr-partial':
        setState('正在听…', 'listening');
        setLine(ev.text || '');
        break;
      case 'asr-final':
        replyText = '';
        voiceState.lastHeardAt = Date.now();
        voiceState.speaking = true;
        setState('听到了，正在想…', 'thinking');
        setLine(ev.text || '');
        break;
      case 'reply-delta':
        replyText += ev.text || '';
        voiceState.speaking = true;
        setState('阿春在想…', 'thinking');
        setLine(replyText);
        break;
      case 'reply-final':
        if (ev.text) setLine(ev.text);
        break;
      case 'audio':
        voiceState.speaking = true;
        setState('阿春在讲…', 'speaking');
        if (ev.data) playChunk(ev.data);
        break;
      case 'interrupted':
        stopPlayback();
        voiceState.speaking = false;
        voiceState.lastHeardAt = Date.now();
        setState('已打断，听你说', 'listening');
        break;
      case 'turn-end':
        voiceState.speaking = false;
        setState('正在听…', 'listening');
        break;
      case 'closed':
        stopPlayback();
        voiceState.active = false;
        voiceState.speaking = false;
        setState('连接已断开', 'error');
        break;
      case 'error':
        setState('出错了：' + ev.message, 'error');
        break;
      default:
        break;
    }
  });

  // ------------------------------------------------------------- 开关
  function setBusy(on) {
    busy = on;
    btn.classList.toggle('busy', on);
    btn.disabled = on;
  }

  function startVoice() {
    if (active || busy) return;
    setBusy(true);
    replyText = '';
    bar.classList.remove('hidden');
    setLine('');
    setState('正在连接…');

    Promise.resolve(bridge.start()).then(function (r) {
      if (!r || !r.ok) {
        setState('语音不可用：' + ((r && r.error) || '未知错误'), 'error');
        bar.classList.add('hidden');
        setBusy(false);
        return;
      }
      return openMic().then(function () {
        active = true;
        voiceState.active = true;
        voiceState.llmReady = !!r.llmReady;
        btn.textContent = '语音：开';
        btn.classList.add('on');
        setState('正在听…', 'listening');
        if (!r.llmReady) setLine('提示：配置里还没填 llm.apiKey');
        setBusy(false);
      });
    }).catch(function (e) {
      active = false;
      closeMic();
      bridge.stop();
      btn.textContent = '语音：关';
      btn.classList.remove('on');
      setState('麦克风打开失败：' + e.message, 'error');
      setBusy(false);
    });
  }

  function stopVoice() {
    if (!active) return;
    active = false;
    voiceState.active = false;
    voiceState.speaking = false;
    voiceState.llmReady = false;
    closeMic();
    stopPlayback();
    bridge.stop();
    btn.textContent = '语音：关';
    btn.classList.remove('on');
    bar.classList.add('hidden');
    setLine('');
    setState('语音待机');
  }

  btn.addEventListener('click', function () {
    if (busy) return;
    if (active) stopVoice();
    else startVoice();
  });
})();
