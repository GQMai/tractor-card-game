/* 离线模拟 Provider：不连任何云服务，用于验证整条链路（事件顺序、记忆落盘、延迟统计）。
 * 真实接入时替换成 doubao.js / 级联实现，接口保持不变。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VoiceMockProvider = factory();
})(this, function () {
  'use strict';

  function createMockProvider(opt) {
    opt = opt || {};
    var latency = opt.latency || { asrFirst: 60, asrFinal: 140, replyFirst: 220, audioFirst: 320 };
    var asrText = opt.asrText || '你好呀，今日天气几好';
    var replyText = opt.replyText || '係呀，出太阳好暖，你记得饮多啲水。';
    var timers = [];
    var aborted = false;

    function later(ms, fn) {
      var t = setTimeout(function () {
        if (aborted) return;
        fn();
      }, ms);
      timers.push(t);
      return t;
    }

    return {
      connect: function (ctx) {
        var onEvent = ctx.onEvent;

        function runTurn() {
          aborted = false;
          onEvent({ type: 'state', state: 'listening' });
          later(latency.asrFirst, function () {
            onEvent({ type: 'asr-partial', text: asrText.slice(0, 3) });
          });
          later(latency.asrFinal, function () {
            onEvent({ type: 'asr-final', text: asrText });
          });
          later(latency.replyFirst, function () {
            onEvent({ type: 'reply-delta', text: replyText.slice(0, 2) });
          });
          later(latency.replyFirst + 40, function () {
            onEvent({ type: 'reply-delta', text: replyText.slice(2) });
            onEvent({ type: 'reply-final', text: replyText });
          });
          later(latency.audioFirst, function () {
            onEvent({ type: 'audio', pcm: Buffer.alloc(640, 1) });
          });
          later(latency.audioFirst + 60, function () {
            onEvent({ type: 'audio', pcm: Buffer.alloc(640, 2) });
            onEvent({ type: 'turn-end' });
          });
        }

        runTurn();

        return {
          sendAudio: function () { /* 模拟模式下音频内容不影响结果 */ },
          sendText: function (text) { asrText = text; runTurn(); },
          interrupt: function () {
            aborted = true;
            timers.forEach(clearTimeout);
            timers = [];
            aborted = false; // 重新开始一轮，清掉中断标记
            later(10, function () { runTurn(); });
          },
          close: function () {
            aborted = true;
            timers.forEach(clearTimeout);
            timers = [];
          }
        };
      }
    };
  }

  return { createMockProvider: createMockProvider };
});
