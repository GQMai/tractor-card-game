/* Edge TTS 粤语音色 POC：验证免费 TTS 是否可用于级联方案（ASR → LLM → TTS）。
 *
 * 用法：
 *   node test/edge-tts-test.js
 *   node test/edge-tts-test.js --text "陳伯，飲咗茶未呀？" --rate -10 --voice zh-HK-HiuMaanNeural
 *
 * 音频只写系统临时目录，不落项目。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const EdgeTts = require('../renderer/voice/edge-tts.js');

const DEFAULT_TEXT = '陳伯，早晨呀！今日天氣咁好，不如我哋一齊去飲茶，食個叉燒包？';
const DEFAULT_VOICES = [EdgeTts.VOICES.hiukaan, EdgeTts.VOICES.wanlung];

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const text = arg('text', DEFAULT_TEXT);
  const rateNum = parseInt(arg('rate', '-10'), 10);
  const rate = (rateNum > 0 ? '+' : '') + rateNum + '%';
  const voiceArg = arg('voice', '');
  const voices = voiceArg ? [voiceArg] : DEFAULT_VOICES;
  const timeoutMs = parseInt(arg('timeout', '20000'), 10);

  console.log('文本:', text);
  console.log('语速:', rate, '| GEC 版本:', EdgeTts.GEC_VERSION);
  console.log('签名:', EdgeTts.secMsGec());

  for (const v of voices) {
    const job = EdgeTts.createEdgeTts({ text, voice: v, rate, timeoutMs });
    try {
      const r = await job.promise;
      const out = path.join(os.tmpdir(), 'edge-tts-' + v + '-' + Date.now() + '.mp3');
      fs.writeFileSync(out, r.mp3);
      console.log('---');
      console.log('音色:', v);
      console.log('首包:', r.firstMs, 'ms | 总耗时:', r.totalMs, 'ms | 分片:', r.chunks, '| 大小:', r.bytes, '字节');
      console.log('音频:', out);
    } catch (e) {
      console.log('---');
      console.log('音色:', v, '失败:', e.message);
    }
  }
}

main().catch(err => {
  console.error('POC 失败:', err.message);
  process.exit(1);
});
