/* 实时语音链路自检：会话配置 / 本地记忆 / 会话状态机 / 传输层（全双工 JSON 协议）
 * 运行：node test/voice-test.js
 */
'use strict';
const M = require('../renderer/voice/memory.js');
const S = require('../renderer/voice/provider.js');
const Mock = require('../renderer/voice/mock.js');
const Doubao = require('../renderer/voice/doubao.js');
const V = require('../renderer/voice/config.js');
const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');

let checks = 0;
function ok(cond, msg) {
  if (!cond) throw new Error('断言失败: ' + msg);
  checks++;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function waitFor(events, type, timeout, startIndex) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const from = startIndex || 0;
    const timer = setInterval(() => {
      const hit = events.slice(from).find(e => e.type === type);
      if (hit) { clearInterval(timer); resolve(hit); }
      else if (Date.now() - t0 > (timeout || 3000)) { clearInterval(timer); reject(new Error('等待事件超时: ' + type)); }
    }, 10);
  });
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'voice-test-'));
}

async function main() {
  // 1. 会话配置：新版全双工 JSON 协议
  {
    const cfg = Object.assign({}, V.DEFAULTS, { apiKey: 'test-key' });
    const ev = V.buildSessionCreate(cfg);
    ok(ev.type === 'session.create', '事件类型');
    ok(ev.session.model === '1.2.6.1', '固定模型版本');
    ok(ev.session.audio.input.format.type === 'pcm' && ev.session.audio.input.format.rate === 16000, '上行 16k PCM');
    ok(ev.session.audio.output.format.type === 'pcm_s16le' && ev.session.audio.output.format.rate === 24000, '下行 24k 16bit PCM');
    ok(typeof ev.session.audio.output.voice === 'string', '必选音色');
    ok(!ev.session.extension.tts.extra || !ev.session.extension.tts.extra.explicit_dialect, '默认不带方言参数');
    ok(ev.session.extension.tts.audio_config.format === 'pcm_s16le', 'TTS 输出 PCM');
    ok(/陪老人聊天|普通话/.test(ev.session.instructions), '系统提示词');
    const yue = V.buildSessionCreate(Object.assign({}, cfg, { dialect: 'yue' }));
    ok(yue.session.extension.tts.extra.explicit_dialect === 'yue', '方言参数仍可按需开启');
    ok(V.DEFAULTS.url.indexOf('/api/v3/duplex/realtime/dialogue') >= 0, '全双工地址');
  }

  // 2. 本地记忆
  {
    const dir = tmpDir();
    const store = M.createFileStore(dir);
    const mem = M.createMemory(store, { sessionId: 's1' });
    mem.record('user', '今日天气几好');
    mem.record('assistant', '係呀，出太阳好暖。');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    ok(files.length === 1, '记忆按月落盘');
    const lines = fs.readFileSync(path.join(dir, files[0]), 'utf8').trim().split('\n');
    ok(lines.length === 2, '每条消息一行');
    ok(JSON.parse(lines[0]).role === 'user', '记录角色');

    const recent = mem.recent(5);
    ok(recent.length === 2 && recent[1].text.indexOf('出太阳') >= 0, '读取最近对话');

    const prompt = M.buildPrompt({ persona: '粤语陪聊', facts: { 姓名: '陈伯' }, recent });
    ok(prompt.indexOf('陈伯') >= 0 && prompt.indexOf('老人：今日天气几好') >= 0, '上下文拼装');

    mem.clear();
    ok(fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).length === 0, '清空记忆');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 3. 会话状态机 + 事件顺序 + 延迟
  {
    const dir = tmpDir();
    const mem = M.createMemory(M.createFileStore(dir));
    const events = [];
    const session = S.createSession({
      memory: mem,
      persona: '粤语陪聊',
      provider: Mock.createMockProvider({ latency: { asrFirst: 40, asrFinal: 90, replyFirst: 130, audioFirst: 170 } }),
      onEvent: e => events.push(e)
    });

    await session.start();
    ok(session.state === 'listening', '启动后进入聆听');
    session.sendAudio(Buffer.alloc(320, 0));

    await waitFor(events, 'turn-end', 3000);
    ok(session.stats.turns === 1, '完成一轮');
    ok(session.stats.audioFirst !== null && session.stats.audioFirst < 1000, '首包延迟合理: ' + session.stats.audioFirst + 'ms');

    const order = events.filter(e => ['asr-final', 'reply-final', 'audio', 'turn-end'].includes(e.type)).map(e => e.type);
    ok(order[0] === 'asr-final' && order.indexOf('reply-final') > 0 && order.indexOf('audio') > 0, '事件顺序正确: ' + order.join('>'));

    const recs = mem.recent(10);
    ok(recs.length === 2 && recs[0].role === 'user' && recs[1].role === 'assistant', '一轮对话落盘');

    // 4. 打断：老人开口立刻停止播报并重新聆听
    session.sendAudio(Buffer.alloc(320, 0));
    await sleep(60);
    const before = events.length;
    session.interrupt();
    await waitFor(events, 'turn-end', 3000, before);
    ok(session.stats.turns === 2, '打断后重新完成一轮');
    ok(session.state === 'listening', '打断后回到聆听');

    session.close();
    ok(session.state === 'idle', '关闭后空闲');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 5. 传输层：本地 JSON 回显服务，验证全双工握手与事件映射
  {
    const server = new WebSocket.Server({ port: 0 });
    let sawHeaders = null;
    let sawSession = null;

    await new Promise(resolve => server.on('listening', resolve));
    const port = server.address().port;

    server.on('connection', (ws, req) => {
      sawHeaders = req.headers;
      ws.on('message', data => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'session.create') {
          sawSession = msg.session;
          ws.send(JSON.stringify({ type: 'session.created', session: { id: 's1' } }));
        }
        if (msg.type === 'input_audio_buffer.append') {
          const bytes = Buffer.from(msg.audio, 'base64');
          ok(bytes.length === 640, '上行音频 20ms 分片');
          ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.started' }));
          ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: '你讲咩话' }));
          ws.send(JSON.stringify({ type: 'response.output_text.delta', delta: '我听' }));
          ws.send(JSON.stringify({ type: 'response.output_text.done', text: '我听得好清楚' }));
          ws.send(JSON.stringify({ type: 'response.output_audio.started' }));
          ws.send(JSON.stringify({ type: 'response.output_audio.delta', delta: Buffer.alloc(16, 9).toString('base64') }));
          ws.send(JSON.stringify({ type: 'response.output_audio.done' }));
          ws.send(JSON.stringify({ type: 'response.done' }));
        }
        if (msg.type === 'session.close') {
          ws.send(JSON.stringify({ type: 'session.closed' }));
        }
      });
    });

    const transport = Doubao.createDoubaoProvider({
      url: 'ws://127.0.0.1:' + port,
      apiKey: 'test-key',
      session: V.buildSession(V.DEFAULTS),
      wsFactory: WebSocket
    });

    const events = [];
    const api = transport.connect({ onEvent: e => events.push(e), systemPrompt: '' });
    await sleep(150);
    ok(sawHeaders && sawHeaders['x-api-key'] === 'test-key', '握手仅带 X-Api-Key');
    ok(!sawHeaders['x-api-app-id'], '不再发送旧版 App ID');
    ok(sawSession && sawSession.model === '1.2.6.1', 'session.create 携带模型版本');
    ok(sawSession.audio.output.format.type === 'pcm_s16le', 'session.create 指定 PCM 输出');
    ok(events.some(e => e.type === 'connected'), '连接建立事件');

    events.length = 0;
    api.sendAudio(Buffer.alloc(640, 0));
    await waitFor(events, 'turn-end', 2000);
    ok(events.some(e => e.type === 'asr-final' && e.text === '你讲咩话'), '收到识别文本');
    ok(events.some(e => e.type === 'reply-final' && e.text === '我听得好清楚'), '收到回复文本');
    ok(events.filter(e => e.type === 'audio').length === 1, '收到语音分片');
    ok(events[events.length - 1].type === 'turn-end', '一轮以 turn-end 收尾');

    api.close();
    await waitFor(events, 'closed', 3000);
    ok(true, 'session.close 后有回包并断开');
    await new Promise(resolve => server.close(resolve));
  }

  console.log('语音链路自检通过：' + checks + ' 条断言');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
