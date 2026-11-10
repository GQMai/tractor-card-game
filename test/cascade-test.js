/* 级联链路测试：豆包流式 ASR → 远端 LLM → Edge TTS。
 *
 * 用法：
 *   node test/cascade-test.js --offline            只跑本地单元测试（帧格式/切句/VAD）
 *   node test/cascade-test.js --make-wav           用 Edge TTS 粤语女声生成 16k 测试音频
 *   node test/cascade-test.js --asr <wav>          只测 ASR 识别
 *   node test/cascade-test.js --live <wav>         全链路：识别 → LLM → 粤语播报（需配 llm.apiKey）
 *   node test/cascade-test.js --live <wav> --echo  用固定回复替身，跳过 LLM
 *
 * 音频只写系统临时目录。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const V = require('../renderer/voice/config.js');
const Asr = require('../renderer/voice/asr-doubao.js');
const Cascade = require('../renderer/voice/cascade-provider.js');
const EdgeTts = require('../renderer/voice/edge-tts.js');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next && next.indexOf('--') !== 0 ? next : true;
}

function has(name) { return process.argv.indexOf('--' + name) >= 0; }

// ---- 音频工具：mp3 解码 → 24k 转 16k → WAV ----
async function mp3ToPcm16k(mp3) {
  const { MPEGDecoder } = require(path.join(process.env.TEMP, 'audio-tools', 'node_modules', 'mpg123-decoder'));
  const dec = new MPEGDecoder();
  await dec.ready;
  const out = dec.decode(new Uint8Array(mp3));
  dec.free();
  const src = out.channelData[0];
  const srcRate = out.sampleRate;
  if (srcRate === 16000) return Buffer.from(f32ToPcm16(src));
  const ratio = srcRate / 16000;
  const len = Math.floor(src.length / ratio);
  const pcm = Buffer.alloc(len * 2);
  for (let i = 0; i < len; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const v = src[i0] * (1 - frac) + (src[Math.min(i0 + 1, src.length - 1)] || 0) * frac;
    const s = Math.max(-1, Math.min(1, v));
    pcm.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  return pcm;
}

function f32ToPcm16(f32) {
  const pcm = Buffer.alloc(f32.length * 2);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    pcm.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  return pcm;
}

function readWav(file) {
  const raw = fs.readFileSync(file);
  if (raw.slice(0, 4).toString() !== 'RIFF') throw new Error('不是 WAV 文件: ' + file);
  return raw.slice(44); // 测试用 WAV 均为 16k/16bit/单声道
}

function writeWav(file, pcm, rate) {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([head, pcm]));
}

// ---- 离线单元测试 ----
function offline() {
  const assert = require('assert');

  const startPayload = Asr.buildStartPayload({ apiKey: 'x' });
  assert.strictEqual(startPayload.audio.rate, 16000);
  assert.strictEqual(startPayload.request.model_name, 'bigmodel');
  assert.strictEqual(startPayload.request.end_window_size, 800);

  const frame = Asr.pack(Asr.TYPE.FULL_CLIENT, Asr.FLAG.NONE, 1, Buffer.from('{}'));
  assert.strictEqual(frame[0], 0x11);
  assert.strictEqual(frame[1] >> 4, 1);
  assert.strictEqual(frame[2] >> 4, 1);
  assert.strictEqual(frame.readUInt32BE(4), 2);

  // 模拟服务端整帧：头 + sequence + 长度 + JSON
  const json = Buffer.from(JSON.stringify({ result: { text: '陳伯早晨' }, is_last_package: true }));
  const head = Buffer.from([0x11, (9 << 4) | 1, 0x10, 0x00]);
  const seq = Buffer.alloc(4); seq.writeInt32BE(1);
  const len = Buffer.alloc(4); len.writeUInt32BE(json.length);
  const srv = Buffer.concat([head, seq, len, json]);
  const parsed = Asr.unpack(srv);
  assert.strictEqual(parsed.seq, 1);
  assert.strictEqual(JSON.parse(parsed.payload.toString()).result.text, '陳伯早晨');

  const s1 = Cascade.splitSentences('陳伯，早晨呀！今日天氣幾好喎，落樓下行吓啦？');
  assert.deepStrictEqual(s1.sentences, ['陳伯，早晨呀！', '今日天氣幾好喎，落樓下行吓啦？']);
  assert.strictEqual(s1.rest, '');

  const s2 = Cascade.splitSentences('我陪你');
  assert.deepStrictEqual(s2.sentences, []);
  assert.strictEqual(s2.rest, '我陪你');

  const long = Cascade.splitSentences('今日天氣好好，我哋一齊去飲茶啦，食個叉燒包好唔好呀，順便去埋公園行下，跟住返屋企睇電視');
  assert.ok(long.sentences.length >= 1);
  assert.ok(long.sentences[0].length <= 40);
  assert.ok(!long.rest || long.rest.length < 40);

  // VAD：静音不触发，持续满幅触发
  const vad = Cascade.createVad({ threshold: 900, loudMs: 60 });
  const silence = Buffer.alloc(640);
  assert.strictEqual(vad.push(silence), false);
  const loud = Buffer.alloc(640);
  for (let i = 0; i < 320; i++) loud.writeInt16LE(8000, i * 2);
  let fired = 0;
  for (let i = 0; i < 4; i++) if (vad.push(loud)) fired++;
  assert.strictEqual(fired, 1);

  console.log('离线测试通过：帧格式 / 切句 / VAD');
}

// ---- 生成 16k 测试音频 ----
async function makeWav(text) {
  const tts = EdgeTts.createEdgeTts({
    text: text || '陳伯，早晨呀！今日天氣幾好喎，落樓下行吓啦？',
    voice: EdgeTts.VOICES.hiukaan,
    rate: '-10%'
  });
  const r = await tts.promise;
  const pcm = await mp3ToPcm16k(r.mp3);
  const out = path.join(os.tmpdir(), 'cascade-asr-' + Date.now() + '.wav');
  writeWav(out, pcm, 16000);
  console.log('测试音频:', out, '| 时长', (pcm.length / 32000).toFixed(1) + 's');
  return out;
}

function feedWav(api, pcm, paceMs, method) {
  const send = method || 'sendAudio';
  let offset = 0;
  return new Promise(resolve => {
    const timer = setInterval(() => {
      if (offset >= pcm.length) {
        clearInterval(timer);
        resolve();
        return;
      }
      api[send](pcm.slice(offset, offset + 3200)); // 100ms
      offset += 3200;
    }, paceMs);
  });
}

// ---- 只测 ASR ----
async function runAsr(wavFile, cfg) {
  const pcm = readWav(wavFile);
  const asr = Asr.createDoubaoAsr({
    apiKey: cfg.apiKey, appId: cfg.appId, accessKey: cfg.accessKey,
    url: cfg.asr.url, resourceId: cfg.asr.resourceId, modelName: cfg.asr.modelName,
    endWindowSize: cfg.asr.endWindowSize, wsFactory: WebSocket
  }).connect({
    onOpen: () => console.log('ASR 已连接'),
    onEvent: ev => {
      if (ev.type === 'asr-partial') console.log('[partial]', ev.text);
      if (ev.type === 'asr-final') console.log('[final]', ev.text);
      if (ev.type === 'error') console.error('[error]', ev.message);
      if (ev.type === 'closed') console.log('ASR 已关闭');
    }
  });
  await feedWav(asr, pcm, 100, 'pushAudio');
  asr.finish();
  await new Promise(r => setTimeout(r, 4000));
  asr.close();
}

// ---- 全链路 ----
async function runLive(wavFile, cfg) {
  const useEcho = has('echo');
  const pcm = readWav(wavFile);
  const t0 = Date.now();
  const timeline = [];
  const audio = [];
  let done;

  const provider = Cascade.createCascadeProvider({
    asr: {
      apiKey: cfg.apiKey, appId: cfg.appId, accessKey: cfg.accessKey,
      url: cfg.asr.url, resourceId: cfg.asr.resourceId, modelName: cfg.asr.modelName,
      endWindowSize: cfg.asr.endWindowSize
    },
    llm: cfg.llm,
    llmFactory: useEcho ? function () {
      return {
        chat: function (opts) {
          const reply = '係呀，陳伯！今日咁好天，落樓行下啦，我陪你去飲茶囉。';
          let i = 0;
          const timer = setInterval(() => {
            if (i < reply.length) opts.onDelta(reply.slice(i, i + 4));
            else { clearInterval(timer); opts.onDone && opts.onDone(reply); }
            i += 4;
          }, 40);
          return { abort: () => clearInterval(timer) };
        }
      };
    } : undefined,
    tts: { voice: cfg.tts.voice, rate: cfg.tts.rate },
    vad: cfg.vad,
    wsFactory: WebSocket
  });

  const api = provider.connect({
    systemPrompt: V.buildSession(cfg).instructions + '\n' + cfg.cascadePersona,
    onEvent: ev => {
      const ms = Date.now() - t0;
      if (ev.type === 'audio') {
        audio.push(ev.pcm);
        if (audio.length === 1) timeline.push(`audio-first ${ms}ms`);
        return;
      }
      if (ev.type === 'asr-partial' || ev.type === 'reply-delta') return;
      timeline.push(`${ev.type} ${ms}ms` + (ev.text ? ' | ' + ev.text : ''));
      if (ev.type === 'error') console.error('错误:', ev.message);
      if (ev.type === 'turn-end') done && done();
    }
  });

  const ended = new Promise(r => { done = r; });
  await feedWav(api, pcm, 100);
  const timer = setTimeout(() => { console.log('超时'); api.close(); done(); }, 25000);
  await ended;
  clearTimeout(timer);

  console.log('时间线:', timeline.join(' > '));
  if (audio.length) {
    const out = path.join(os.tmpdir(), 'cascade-reply-' + Date.now() + '.mp3');
    fs.writeFileSync(out, Buffer.concat(audio));
    console.log('回复音频:', out);
  }
  api.close();
}

// ---- 自检：LLM SSE 解析 + 级联播报链路（不依赖 ASR 账号） ----
async function selfcheck() {
  const assert = require('assert');
  const http = require('http');
  const Llm = require('../renderer/voice/llm.js');

  // 1) 用本地 SSE 服务验证流式解析
  const reply = '係呀，陳伯！今日咁好天，落樓行下啦。我陪你去飲茶囉。';
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let i = 0;
    const parts = reply.match(/.{1,5}/g);
    const timer = setInterval(() => {
      if (i >= parts.length) {
        clearInterval(timer);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: parts[i++] } }] }) + '\n\n');
    }, 20);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const llm = Llm.createLlm({ baseUrl: 'http://127.0.0.1:' + port, apiKey: 'x', model: 'fake' });
  const text = await llm.chat({ system: 'test', messages: [{ role: 'user', content: 'hi' }] }).promise;
  assert.strictEqual(text, reply);
  server.close();
  console.log('自检 1/2 通过：LLM 流式解析');

  // 2) 级联 sendText → 分句 → Edge TTS 播报（关闭 ASR）
  const events = [];
  const audio = [];
  const provider = Cascade.createCascadeProvider({
    asr: null,
    llm: {},
    tts: { voice: EdgeTts.VOICES.hiukaan, rate: '-10%' },
    vad: {},
    wsFactory: WebSocket
  });
  const api = provider.connect({
    systemPrompt: 'test',
    onEvent: ev => {
      if (ev.type === 'audio') { audio.push(ev.pcm); return; }
      events.push(ev);
    }
  });
  const ended = new Promise(r => {
    const timer = setInterval(() => {
      if (events.some(e => e.type === 'turn-end')) { clearInterval(timer); r(); }
    }, 100);
  });
  api.sendText(reply);
  await Promise.race([ended, new Promise(r => setTimeout(r, 25000))]);
  const final = events.find(e => e.type === 'reply-final');
  assert.ok(final, '缺少 reply-final');
  assert.strictEqual(final.text, reply);
  assert.ok(events.some(e => e.type === 'turn-end'), '缺少 turn-end');
  assert.strictEqual(audio.length, 3, '应按三句切分合成，实际 ' + audio.length);
  assert.ok(audio[0].length > 1000);
  api.close();
  console.log('自检 2/2 通过：分句播报（' + audio.length + ' 段音频）');
  console.log('自检全部通过；ASR 需账号开通后跑 --asr / --live');
}

async function main() {
  if (has('offline')) return offline();
  if (has('selfcheck')) return selfcheck();

  const cfg = V.load(arg('config', ''));
  let wav = arg('wav', '') || arg('asr', '') || arg('live', '');
  if (has('make-wav')) wav = await makeWav(arg('text', ''));
  if (has('asr')) return runAsr(wav, cfg);
  if (has('live')) return runLive(wav, cfg);

  console.log('用法: --offline | --make-wav | --asr <wav> | --live <wav> [--echo]');
}

main().catch(err => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
