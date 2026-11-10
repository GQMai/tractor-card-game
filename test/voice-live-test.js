/* 豆包端到端实时语音连通性实测。
 *
 * 用法：
 *   node test/voice-live-test.js --text "你好，今日天气点呀"
 *   node test/voice-live-test.js --wav D:\temp\test16k.wav
 *   node test/voice-live-test.js --config D:\somewhere\voice-config.json
 *
 * 配置默认读 %APPDATA%\Tractor\voice-config.json（不入库、不进安装包）。
 * 返回的 PCM 写到系统临时目录，不会落到项目里。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const V = require('../renderer/voice/config.js');
const D = require('../renderer/voice/doubao.js');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const textArg = arg('text', '');
const wavArg = arg('wav', '');
const voiceArg = arg('voice', '');
const timeoutMs = parseInt(arg('timeout', '25000'), 10);

async function main() {
  const cfg = V.load(arg('config', ''));
  console.log('配置来源:', cfg.path);
  const authHint = cfg.apiKey
    ? 'X-Api-Key ' + cfg.apiKey.slice(0, 6) + '******'
    : '旧版 appId ' + cfg.appId;
  console.log('鉴权:', authHint, '| 音色:', voiceArg || cfg.speaker, '| 方言:', cfg.dialect, '| 模型:', cfg.model);
  console.log('地址:', cfg.url);

  const voice = voiceArg || cfg.speaker;
  const sess = V.buildSession(cfg, { inputMod: textArg ? 'text' : cfg.inputMod, speaker: voice });
  console.log('session.create:', JSON.stringify(sess));

  const provider = D.createDoubaoProvider({
    ...cfg,
    wsFactory: WebSocket,
    session: sess,
    timeoutMs: 15000
  });

  const t0 = Date.now();
  const events = [];
  const pcm = [];
  let api = null;
  let done = false;

  function finish(code) {
    if (done) return;
    done = true;
    try { api && api.close(); } catch (e) { /* 忽略 */ }
    const wall = Date.now() - t0;
    const asr = events.filter(e => e.type === 'asr-final' && e.text).map(e => e.text);
    const reply = events.filter(e => e.type === 'reply-final' && e.text).map(e => e.text);
    const bytes = pcm.reduce((s, b) => s + b.length, 0);
    console.log('---');
    console.log('识别文本:', asr.length ? asr.join(' / ') : '（无）');
    console.log('回复文本:', reply.length ? reply.join(' / ') : '（无）');
    console.log('语音数据:', bytes, '字节');
    console.log('事件时间线:', events.map(e => e.type).join(' > ') || '（无）');
    console.log('总耗时:', wall, 'ms');
    if (bytes > 0) {
      const out = path.join(os.tmpdir(), 'voice-live-' + voice.replace(/^zh_|_uranus_bigtts$/g, '') + '-' + Date.now() + '.wav');
      fs.writeFileSync(out, V.wrapWav(Buffer.concat(pcm), 24000));
      console.log('回复音频已保存:', out);
    }
    setTimeout(() => process.exit(code), 100);
  }

  api = provider.connect({
    systemPrompt: '',
    onRaw: msg => console.log('[srv]', msg.type, JSON.stringify(msg).slice(0, 200)),
    onEvent: ev => {
      events.push(ev);
      if (ev.type === 'audio') pcm.push(ev.pcm);
      if (ev.type === 'connected') {
        console.log('连接成功，开始发送输入…');
        if (textArg) api.sendText(textArg);
        else if (wavArg) {
          const raw = fs.readFileSync(wavArg);
          const data = raw.slice(raw.length > 44 ? 44 : 0); // 去掉 WAV 头
          let offset = 0;
          const timer = setInterval(() => {
            if (offset >= data.length) {
              clearInterval(timer);
              api.commit(); // 音频发完，强制模型判停
              return;
            }
            api.sendAudio(data.slice(offset, offset + 640)); // 20ms @16k
            offset += 640;
          }, 20);
        }
      }
      if (ev.type === 'error') {
        console.error('服务端错误:', ev.message);
        finish(1);
      }
      if (ev.type === 'turn-end') finish(0);
      if (ev.type === 'closed' && !done) {
        console.error('连接被关闭:', ev.code, ev.reason);
        finish(1);
      }
    }
  });

  setTimeout(() => {
    if (!done) {
      console.error('超时，未收到完整一轮回复');
      finish(1);
    }
  }, timeoutMs);
}

main().catch(err => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
