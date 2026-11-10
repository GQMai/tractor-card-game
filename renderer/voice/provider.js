/* 会话编排层：统一各家语音 API 的事件，串起状态机与本地记忆。
 *
 * 对话主路径是端到端音频：音频进、音频出，模型自己完成听与说。
 * 事件流里附带的文本（识别稿 / 回复稿）只是旁路元数据，
 * 用来写本地记忆和界面字幕，不参与对话决策，也不作为中间处理步骤。
 *
 * Provider 约定（端到端或级联实现同一套）：
 *   provider.connect({ onEvent, systemPrompt }) -> { sendAudio(buf), sendText(text), interrupt(), close() }
 * 事件类型：
 *   asr-partial   { text }            字幕用中间稿（可选）
 *   asr-final     { text }            本轮老人说的话（旁路元数据，写入记忆）
 *   reply-delta   { text }            字幕用回复增量（可选）
 *   reply-final   { text }            本轮回复文本（旁路元数据，写入记忆）
 *   audio         { pcm }             合成语音分片（主路径）
 *   turn-end      {}                  一轮结束
 *   error         { message }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./memory.js'));
  } else {
    root.VoiceSession = factory(root.VoiceMemory);
  }
})(this, function (VoiceMemory) {
  'use strict';

  var STATE = { IDLE: 'idle', LISTENING: 'listening', SPEAKING: 'speaking' };

  function createSession(opt) {
    var memory = opt.memory;
    var persona = opt.persona || '你是一位耐心的粤语陪聊伙伴。';
    var onEvent = opt.onEvent || function () {};
    var provider = opt.provider;

    var state = STATE.IDLE;
    var api = null;
    var stats = { turns: 0, asrFirst: null, replyFirst: null, audioFirst: null, audioChunks: 0 };
    var turnStart = 0;

    function setState(next) {
      if (state === next) return;
      state = next;
      onEvent({ type: 'state', state: state });
    }

    function emitRaw(ev) {
      if (!ev || !ev.type) return;
      var now = Date.now();
      switch (ev.type) {
        case 'asr-partial':
          if (stats.asrFirst === null && turnStart) stats.asrFirst = now - turnStart;
          break;
        case 'asr-final':
          if (ev.text) memory.record('user', ev.text);
          break;
        case 'reply-delta':
          if (stats.replyFirst === null && turnStart) stats.replyFirst = now - turnStart;
          break;
        case 'reply-final':
          if (ev.text) memory.record('assistant', ev.text);
          break;
        case 'audio':
          stats.audioChunks++;
          if (stats.audioFirst === null && turnStart) stats.audioFirst = now - turnStart;
          setState(STATE.SPEAKING);
          break;
        case 'turn-end':
          stats.turns++;
          turnStart = 0;
          setState(STATE.LISTENING);
          break;
        case 'error':
          setState(STATE.IDLE);
          break;
      }
      onEvent(ev);
    }

    return {
      get state() { return state; },
      get stats() { return stats; },

      async start() {
        var prompt = VoiceMemory.buildPrompt({
          persona: persona,
          facts: memory.facts(),
          recent: memory.recent()
        });
        api = await provider.connect({ onEvent: emitRaw, systemPrompt: prompt });
        turnStart = Date.now();
        setState(STATE.LISTENING);
        return prompt;
      },

      sendAudio: function (buf) {
        if (!api) return;
        if (!turnStart) turnStart = Date.now();
        // 全双工：播报中也要持续上行音频，模型自己处理"边说边听"与插话
        api.sendAudio(buf);
      },

      sendText: function (text) {
        if (!api) return;
        if (!turnStart) turnStart = Date.now();
        api.sendText(text);
      },

      // 关闭/恢复麦克风时必须通知服务端，否则上行静默会导致服务端超时
      mute: function () { if (api && api.mute) api.mute(); },
      unmute: function () { if (api && api.unmute) api.unmute(); },

      // 老人一开口就打断播报，并把识别状态切回来
      interrupt: function () {
        if (api && typeof api.interrupt === 'function') api.interrupt();
        stats.audioFirst = null;
        turnStart = Date.now();
        setState(STATE.LISTENING);
      },

      close: function () {
        if (api && typeof api.close === 'function') api.close();
        api = null;
        setState(STATE.IDLE);
      }
    };
  }

  return { STATE: STATE, createSession: createSession };
});
