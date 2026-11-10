/* Edge TTS（微软 Azure 边缘朗读服务）客户端。
 *
 * 免费、无 API Key，国内可直连，作为粤语陪聊的语音合成方案：
 *   ASR（豆包）→ LLM（远端）→ TTS（本模块）→ 扬声器
 *
 * 鉴权靠 TrustedClientToken + Sec-MS-GEC 时间戳签名（v2 算法，上游 2025 年后启用），
 * 算法随 Edge 客户端版本变化，失效表现为握手 403。
 * 无 SLA，微软可能随时调整；需要稳定时改用 Azure 官方语音或豆包「粤语小溏」。
 *
 * 接口：
 *   createEdgeTts({ text, voice, rate, pitch, volume, timeoutMs })
 *     -> { promise, abort() }
 *   promise 解析为 { mp3: Buffer, firstMs, totalMs, chunks }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EdgeTts = factory();
})(this, function () {
  'use strict';

  var crypto = require('crypto');
  var TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
  var CHROMIUM = '143.0.3650.75';
  var MAJOR = CHROMIUM.split('.')[0];
  var GEC_VERSION = '2-' + CHROMIUM;

  var UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/' + MAJOR + '.0.0.0 Safari/537.36 Edg/' + MAJOR + '.0.0.0';

  // ---- Sec-MS-GEC v2：CS64 摘要 + 定制 SHA-256 ----
  var MASK = 0xffffffff;
  var WIN_EPOCH = 11644473600;

  var SHA256_INITIAL = [0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19];
  var SHA256_STATE = [0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A, 0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2];
  var SHA256_SCHEDULE = [0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA, 0xA622EE8C, 0xD1DD9491, 0xC0DD25A0, 0xF9E70AB6,
    0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33, 0xD258B060, 0x72766564];
  var K = [0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
    0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
    0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
    0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
    0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
    0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
    0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
    0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2];

  var ADJUSTMENT = 0xC9DC06A7;
  var SIGMA0_ADJ = 0x059C0B80;
  var SIGMA1_ADJ = 0x000B92C0;
  var BLOCK_K = K.slice();
  BLOCK_K[14] = ADJUSTMENT;

  var CS64_COEFF = [
    [0xE82E91B1, 0xB32700D0], [0x44DE24C6, 0x88DFF51D], [0x3BEB65BC, 0x29514038], [0xC89C5933, 0xB328CBDF],
    [0x8D1EC211, 0xD405B4D5], [0x314EF5D5, 0x26E55F3C], [0xE92491B1, 0x607801C6], [0xF0A5B9D5, 0x82B2C1FB],
    [0x06064CF3, 0xFA51A3DA], [0xDA79FA60, 0x207CC464], [0xBED20560, 0x3C3C74F3], [0x89F9C9F8, 0xD2D14B61],
    [0x35FA38C6, 0xBB04A2C1], [0xCB49E3C6, 0xC5626167]
  ];
  var CS64_FACTOR = 0x82893933;
  var CS64_ADJ0 = 0xF2F90B1A;
  var CS64_ADJ1 = 0x0B1A0000;

  function mul(a, b) { return Math.imul(a, b) >>> 0; }
  function rol16(v) { return (((v & MASK) << 16) | ((v & MASK) >>> 16)) >>> 0; }
  function rotr(v, n) { return ((v >>> n) | (v << (32 - n))) >>> 0; }
  function sigma0(v) { return (((v >>> 7) ^ (v << 25) ^ (v >>> 18) ^ (v << 14) ^ (v >>> 3)) & MASK) >>> 0; }
  function sigma1(v) { return (((v >>> 17) ^ (v << 15) ^ (v >>> 19) ^ (v << 13) ^ (v >>> 10)) & MASK) >>> 0; }

  function ch(x, y, z) { return (z ^ (x & (y ^ z))) >>> 0; }
  function maj(x, y, z) { return ((x & y) | (z & (x | y))) >>> 0; }
  function s1(v) { return (rotr(v, 6) ^ rotr(v, 11) ^ rotr(v, 25)) >>> 0; }
  function s0(v) { return (rotr(v, 2) ^ rotr(v, 13) ^ rotr(v, 22)) >>> 0; }

  // 从 first 轮开始跑压缩函数；first=14 时第 14 轮常量被替换。
  // 展开体里寄存器角色每轮轮转，8 轮后复位，故按上游写法逐轮平移。
  function shaRounds(state, words, first) {
    var a = state[0], b = state[1], c = state[2], d = state[3],
      e = state[4], f = state[5], g = state[6], h = state[7];
    var constants = first === 14 ? BLOCK_K : K;
    var aligned = Math.min(64, Math.floor((first + 7) / 8) * 8);
    var i, t1;

    for (i = first; i < aligned; i++) {
      t1 = (h + s1(e) + ch(e, f, g) + constants[i] + words[i]) >>> 0;
      var t2 = (s0(a) + maj(a, b, c)) >>> 0;
      var na = (t1 + t2) >>> 0, ne = (d + t1) >>> 0;
      h = g; g = f; f = e; e = ne; d = c; c = b; b = a; a = na;
    }

    for (i = aligned; i < 64; i += 8) {
      t1 = (h + s1(e) + ch(e, f, g) + constants[i] + words[i]) >>> 0;
      d = (d + t1) >>> 0;
      h = (t1 + s0(a) + maj(a, b, c)) >>> 0;

      t1 = (g + s1(d) + ch(d, e, f) + constants[i + 1] + words[i + 1]) >>> 0;
      c = (c + t1) >>> 0;
      g = (t1 + s0(h) + maj(h, a, b)) >>> 0;

      t1 = (f + s1(c) + ch(c, d, e) + constants[i + 2] + words[i + 2]) >>> 0;
      b = (b + t1) >>> 0;
      f = (t1 + s0(g) + maj(g, h, a)) >>> 0;

      t1 = (e + s1(b) + ch(b, c, d) + constants[i + 3] + words[i + 3]) >>> 0;
      a = (a + t1) >>> 0;
      e = (t1 + s0(f) + maj(f, g, h)) >>> 0;

      t1 = (d + s1(a) + ch(a, b, c) + constants[i + 4] + words[i + 4]) >>> 0;
      h = (h + t1) >>> 0;
      d = (t1 + s0(e) + maj(e, f, g)) >>> 0;

      t1 = (c + s1(h) + ch(h, a, b) + constants[i + 5] + words[i + 5]) >>> 0;
      g = (g + t1) >>> 0;
      c = (t1 + s0(d) + maj(d, e, f)) >>> 0;

      t1 = (b + s1(g) + ch(g, h, a) + constants[i + 6] + words[i + 6]) >>> 0;
      f = (f + t1) >>> 0;
      b = (t1 + s0(c) + maj(c, d, e)) >>> 0;

      t1 = (a + s1(f) + ch(f, g, h) + constants[i + 7] + words[i + 7]) >>> 0;
      e = (e + t1) >>> 0;
      a = (t1 + s0(b) + maj(b, c, d)) >>> 0;
    }

    return [a, b, c, d, e, f, g, h];
  }

  function expand(words, from) {
    for (var i = from; i < 64; i++) {
      words[i] = (sigma1(words[i - 2]) + words[i - 7] + sigma0(words[i - 15]) + words[i - 16]) >>> 0;
    }
    return words;
  }

  // 定制初始状态：前 7 字节进 words[14]/[15]，其余按 length=57+len 参与补位
  function shaInit(head7) {
    var words = new Array(16).fill(0);
    words[14] = (head7[0] << 16) | (head7[1] << 8) | head7[2];
    words[15] = (head7[3] << 24 | head7[4] << 16 | head7[5] << 8 | head7[6]) >>> 0;
    words[14] >>>= 0;
    for (var i = 16; i <= 29; i++) {
      var value = SHA256_SCHEDULE[i - 16];
      if (i - 2 >= 14) value += (i === 16 ? (sigma1(words[i - 2]) ^ SIGMA1_ADJ) : sigma1(words[i - 2]));
      if (i - 7 >= 14) value += words[i - 7];
      if (i - 15 >= 14) value += (i === 29 ? (sigma0(words[i - 15]) ^ SIGMA0_ADJ) : sigma0(words[i - 15]));
      words[i] = value & MASK;
    }
    words[30] = (sigma1(words[28]) + words[23] + sigma0(words[15]) + words[14] + ADJUSTMENT - K[14]) & MASK;
    expand(words, 31);
    var working = shaRounds(SHA256_STATE, words, 14);
    for (var j = 0; j < 8; j++) working[j] = (working[j] + SHA256_INITIAL[j]) >>> 0;
    return working;
  }

  function shaDigest(data) {
    var length = 57 + data.length;
    var padLen = ((55 - length) % 64 + 64) % 64;
    var padded = Buffer.alloc((data.length - 7) + 1 + padLen + 8);
    data.copy(padded, 0, 7);
    padded[(data.length - 7)] = 0x80;
    padded.writeUInt32BE(0, padded.length - 8);
    padded.writeUInt32BE(length * 8, padded.length - 4);

    var state = shaInit(data);
    for (var off = 0; off < padded.length; off += 64) {
      var words = new Array(16);
      for (var i = 0; i < 16; i++) words[i] = padded.readUInt32BE(off + i * 4);
      expand(words, 16);
      var working = shaRounds(state, words, 0);
      for (var j = 0; j < 8; j++) working[j] = (working[j] + state[j]) >>> 0;
      state = working;
    }
    var out = Buffer.alloc(32);
    for (var k = 0; k < 8; k++) out.writeUInt32BE(state[k], k * 4);
    return out;
  }

  function cs64Digest(data, digest) {
    var keyA = (digest.readUInt32LE(0) | 1) >>> 0;
    var keyB = (digest.readUInt32LE(4) | 1) >>> 0;
    var factors = [mul(keyA, CS64_FACTOR), mul(keyB, CS64_FACTOR)];

    var terms = [], offsets = [];
    for (var i = 0; i < CS64_COEFF.length; i++) {
      terms.push(mul(CS64_COEFF[i][0], factors[i % 2]));
      offsets.push(CS64_COEFF[i][1]);
    }

    var raw = Buffer.concat([Buffer.from([0]), data]);
    var words = [];
    for (var off = 0; off < raw.length; off += 4) {
      var b = Buffer.alloc(4);
      raw.copy(b, 0, off, Math.min(off + 4, raw.length));
      words.push(b.readUInt32LE(0));
    }
    if (words.length % 2) words.push(0);

    for (var w = 0; w < words.length; w++) {
      var even = w % 2 === 0;
      var term = mul(words[w], even ? keyA : keyB);
      var offset = mul(rol16(words[w]), even ? 0xEF0569FB : 0xC31713DB);
      if (w === 0) {
        term = (term + mul(CS64_ADJ0, factors[0])) >>> 0;
        offset = (offset + CS64_ADJ1) >>> 0;
      }
      terms.push(term);
      offsets.push(offset);
    }

    var swapAcc = 0, swapLast = 0, state = 0, acc = 0;
    for (var p = 0; p < terms.length; p += 2) {
      var x = terms[p], y = terms[p + 1];
      var t = rol16((offsets[p] + x) >>> 0);
      var q = mul(t, 0x76F50F34);
      swapAcc = (swapAcc + ((mul(rol16(q), 0xC3EFEA97) + q) >>> 0)) >>> 0;
      t = rol16((offsets[p + 1] + y) >>> 0);
      q = mul(t, 0x1881CE3C);
      swapLast = (mul(rol16(q), 0x35BD1EC9) + q) >>> 0;
      swapAcc = (swapAcc + swapLast) >>> 0;

      state = (mul(state, keyA) + x) >>> 0;
      state = mul(rol16(state), 0xCF98B111);
      state = mul(rol16(state), 0x87085B9F);
      state = mul(rol16(state), 0x12CEB96D);
      state = mul(rol16(state), 0x257E1D83);
      acc = (acc + state) >>> 0;
      t = (mul(state, keyB) + y) >>> 0;
      t = mul(rol16(t), 0xA27416F5);
      t = mul(rol16(t), 0xD38396FF);
      state = mul(rol16(mul(rol16(t), 0x7C932B89)), 0xBFA49F69);
      acc = (acc + state) >>> 0;
    }

    var out = Buffer.alloc(8);
    out.writeUInt32LE((swapLast ^ state) >>> 0, 0);
    out.writeUInt32LE((swapAcc ^ acc) >>> 0, 4);
    return out.toString('hex').toUpperCase();
  }

  function secMsGec(nowMs) {
    var ticks = (nowMs === undefined ? Date.now() : nowMs) / 1000 + WIN_EPOCH;
    ticks -= ticks % 300;
    ticks *= 1e7;
    var data = Buffer.from(Math.round(ticks).toFixed(0) + TOKEN, 'ascii');
    var digest = shaDigest(data);
    return cs64Digest(data, digest) + '-' + digest.toString('hex').toUpperCase();
  }

  // ---- 协议 ----
  function wsUrl(gec) {
    return 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1' +
      '?TrustedClientToken=' + TOKEN +
      '&ConnectionId=' + crypto.randomUUID().replace(/-/g, '') +
      '&Sec-MS-GEC=' + gec +
      '&Sec-MS-GEC-Version=' + GEC_VERSION;
  }

  function headers() {
    return {
      Pragma: 'no-cache',
      'Cache-Control': 'no-cache',
      Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      'Sec-WebSocket-Version': '13',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': UA,
      Cookie: 'muid=' + crypto.randomBytes(16).toString('hex').toUpperCase() + ';'
    };
  }

  function configFrame(format) {
    var body = JSON.stringify({
      context: {
        synthesis: {
          audio: {
            metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
            outputFormat: format
          }
        }
      }
    });
    return 'X-Timestamp:' + new Date().toString() + '\r\n' +
      'Content-Type:application/json; charset=utf-8\r\n' +
      'Path:speech.config\r\n\r\n' + body;
  }

  function ssmlFrame(text, voice, rate, pitch, volume) {
    var lang = voice.indexOf('zh-HK') === 0 ? 'zh-HK' : 'zh-CN';
    var escaped = String(text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    var ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='" + lang + "'>" +
      "<voice name='" + voice + "'>" +
      "<prosody pitch='" + pitch + "' rate='" + rate + "' volume='" + volume + "'>" + escaped + '</prosody>' +
      '</voice></speak>';
    return 'X-RequestId:' + crypto.randomUUID() + '\r\n' +
      'Content-Type:application/ssml+xml\r\n' +
      'X-Timestamp:' + new Date().toISOString() + '\r\n' +
      'Path:ssml\r\n\r\n' + ssml;
  }

  function parseBinary(buf) {
    if (buf.length < 2) return null;
    var headerLen = buf.readUInt16BE(0);
    if (buf.length < 2 + headerLen) return null;
    return { header: buf.slice(2, 2 + headerLen).toString('utf8'), data: buf.slice(2 + headerLen) };
  }

  function parseText(buf) {
    var raw = buf.toString('utf8');
    var idx = raw.indexOf('\r\n\r\n');
    return { header: idx < 0 ? raw : raw.slice(0, idx), body: idx < 0 ? '' : raw.slice(idx + 4) };
  }

  /* 单次合成。opts:
   *   text 必填；voice 默认 zh-HK-HiuMaanNeural
   *   rate / pitch / volume 传 SSML 百分比或 Hz 字符串，如 '-10%'、'+0Hz'
   *   wsFactory 可注入（浏览器端传自身实现）；默认用 ws 包
   *   onFirstChunk(ms) 可选，首包回调
   */
  function createEdgeTts(opts) {
    var WebSocket = opts.wsFactory || require('ws');
    var timeoutMs = opts.timeoutMs || 15000;
    var voice = opts.voice || 'zh-HK-HiuMaanNeural';
    var rate = opts.rate || '-10%';
    var pitch = opts.pitch || '+0Hz';
    var volume = opts.volume || '+0%';
    var format = opts.format || 'audio-24khz-48kbitrate-mono-mp3';
    var text = String(opts.text || '');
    if (!text) throw new Error('Edge TTS 缺少文本');

    var ws = null;
    var aborted = false;
    var settled = false;
    var timer = null;
    var chunks = [];
    var bytes = 0;
    var t0 = Date.now();
    var firstAt = null;

    var promise = new Promise(function (resolve, reject) {
      function cleanup() {
        settled = true;
        if (timer) clearTimeout(timer);
        try { ws && ws.close(); } catch (e) { /* 忽略 */ }
      }
      function fail(err) {
        if (settled) return;
        cleanup();
        reject(err);
      }
      function done() {
        if (settled) return;
        cleanup();
        resolve({
          mp3: Buffer.concat(chunks),
          bytes: bytes,
          chunks: chunks.length,
          firstMs: firstAt === null ? null : firstAt - t0,
          totalMs: Date.now() - t0
        });
      }

      timer = setTimeout(function () {
        fail(new Error('Edge TTS 超时 ' + timeoutMs + 'ms，已收 ' + bytes + ' 字节'));
      }, timeoutMs);

      ws = new WebSocket(wsUrl(secMsGec()), { headers: headers() });

      ws.on('open', function () {
        ws.send(configFrame(format));
        ws.send(ssmlFrame(text, voice, rate, pitch, volume));
      });

      ws.on('message', function (data, isBinary) {
        if (aborted) return;
        if (isBinary) {
          var f = parseBinary(data);
          if (f && /Path:\s*audio/i.test(f.header)) {
            if (firstAt === null) {
              firstAt = Date.now();
              if (opts.onFirstChunk) opts.onFirstChunk(firstAt - t0);
            }
            chunks.push(f.data);
            bytes += f.data.length;
          }
          return;
        }
        var t = parseText(data);
        if (/Path:\s*turn\.end/i.test(t.header)) return done();
      });

      ws.on('error', function (err) { fail(err); });
      ws.on('unexpected-response', function (req, res) {
        fail(new Error('Edge TTS 握手失败 HTTP ' + res.statusCode + '（签名参数可能已变更）'));
      });
      ws.on('close', function (code, reason) {
        if (settled) return;
        if (chunks.length) return done();
        fail(new Error('Edge TTS 连接关闭 code=' + code + ' ' + (reason || '')));
      });
    });

    return {
      promise: promise,
      abort: function () {
        aborted = true;
        if (timer) clearTimeout(timer);
        try { ws && ws.terminate(); } catch (e) { /* 忽略 */ }
      }
    };
  }

  return {
    TOKEN: TOKEN,
    GEC_VERSION: GEC_VERSION,
    VOICES: { hiukaan: 'zh-HK-HiuMaanNeural', wanlung: 'zh-HK-WanLungNeural' },
    // 朗读接口只支持 mp3 / opus，播放端按 codec 解码
    FORMAT_MP3: 'audio-24khz-48kbitrate-mono-mp3',
    FORMAT_MP3_96K: 'audio-24khz-96kbitrate-mono-mp3',
    FORMAT_OPUS_WEBM: 'webm-24khz-16bit-mono-opus',
    secMsGec: secMsGec,
    createEdgeTts: createEdgeTts
  };
});
