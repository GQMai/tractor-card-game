/* 豆包实时语音配置加载。
 * 密钥只放本机 %APPDATA%\Tractor\voice-config.json（不在仓库内，也不会被打包进源码），
 * 可用环境变量 TRACTOR_VOICE_CONFIG 指向别处。
 *
 * 对应协议：豆包实时语音模型 3.0（Seeduplex）全双工版
 *   wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue
 *   X-Api-Key 鉴权 + 纯 JSON 文本帧，session.model 固定 1.2.6.1
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VoiceConfig = factory();
})(this, function () {
  'use strict';

  var DEFAULTS = {
    url: 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue',
    model: '1.2.6.1',
    resourceId: 'volc.speech.dialog',
    appKey: 'PlgvMymc7f3tQnJ6',
    // 2.0 音色才支持方言参数；Vivi 2.0 女声，适合陪聊
    speaker: 'zh_female_vv_uranus_bigtts',
    // 全双工 S2S 的 explicit_dialect 只产生带口音的普通话，ASR 也不支持纯方言，默认关闭
    dialect: null,
    inputRate: 16000,
    outputRate: 24000,
    speed: 0,
    loudness: 0,
    inputMod: 'audio',
    endSmoothWindowMs: 1200,
    botName: '阿春',
    instructions: '你是一位陪老人聊天的伙伴，语气亲切、有耐心。每次只说一两句话，语速慢，不要长篇大论，多听老人讲。',

    // 级联方案（豆包流式 ASR → 远端 LLM → Edge TTS）专用配置
    asr: {
      url: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
      resourceId: 'volc.seedasr.sauc.duration',
      modelName: 'bigmodel',
      endWindowSize: 800
    },
    llm: {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: ''
    },
    tts: {
      // 微软香港官方音色：女声 HiuMaan / 男声 WanLung
      voice: 'zh-HK-HiuMaanNeural',
      rate: '-10%'
    },
    vad: { threshold: 900, loudMs: 300 },
    // 级联人设：讲粤语口语，短句，语气词，不要书面语
    cascadePersona: '你係一位陪老人家傾偈嘅伙伴，講香港粵語口語，語氣親切、有耐性。每次只講一兩句，句子要短，多用「啦、囉、㗎、喎、喇」等語氣詞，唔好講書面語，唔好長篇大論，多啲聽老人講。'
  };

  // 仅这 4 个 2.0 音色支持 explicit_dialect
  var DIALECT_VOICES = [
    'zh_female_vv_uranus_bigtts',
    'zh_female_xiaohe_uranus_bigtts',
    'zh_male_m191_uranus_bigtts',
    'zh_male_taocheng_uranus_bigtts'
  ];

  // 与 Electron 的 userData 目录保持一致：%APPDATA%\tractor-win7
  // 同时兼容早前提示过的 %APPDATA%\Tractor
  function defaultPath() {
    var path = require('path');
    var fs = require('fs');
    var os = require('os');
    var base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    var current = path.join(base, 'tractor-win7', 'voice-config.json');
    var legacy = path.join(base, 'Tractor', 'voice-config.json');
    if (!fs.existsSync(current) && fs.existsSync(legacy)) return legacy;
    return current;
  }

  function load(filePath) {
    var fs = require('fs');
    var p = filePath || process.env.TRACTOR_VOICE_CONFIG || defaultPath();
    if (!fs.existsSync(p)) {
      throw new Error('找不到配置文件：' + p + '\n请把 voice-config.example.json 复制过去并填入 apiKey。');
    }
    var raw = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    var cfg = {};
    Object.keys(DEFAULTS).forEach(function (k) { cfg[k] = raw[k] === undefined ? DEFAULTS[k] : raw[k]; });

    // 鉴权：优先新版 API Key；否则沿用旧版控制台的 appId/accessKey（新版服务端仍兼容）
    if (raw.apiKey) {
      cfg.apiKey = String(raw.apiKey);
    } else if (raw.appId && raw.accessKey) {
      cfg.appId = String(raw.appId);
      cfg.accessKey = String(raw.accessKey);
      cfg.resourceId = raw.resourceId || DEFAULTS.resourceId;
      cfg.appKey = raw.appKey || DEFAULTS.appKey;
    } else {
      throw new Error('配置文件缺少 apiKey（或旧版 appId + accessKey）');
    }

    // 协议固定值：旧配置里的 1.2.1.1 / 旧地址会被纠正
    cfg.model = DEFAULTS.model;
    if (!/\/duplex\//.test(cfg.url)) cfg.url = DEFAULTS.url;

    // 方言只有 2.0 音色支持，旧音色自动回退
    if (cfg.dialect && DIALECT_VOICES.indexOf(cfg.speaker) < 0) cfg.speaker = DEFAULTS.speaker;

    // 级联配置按段深合并，缺省字段沿用默认值
    ['asr', 'llm', 'tts', 'vad'].forEach(function (k) {
      var merged = {};
      var src = raw[k] || {};
      Object.keys(DEFAULTS[k]).forEach(function (f) { merged[f] = src[f] === undefined ? DEFAULTS[k][f] : src[f]; });
      cfg[k] = merged;
    });
    cfg.cascadePersona = raw.cascadePersona || DEFAULTS.cascadePersona;

    cfg.path = p;
    return cfg;
  }

  // session.create / session.update 的 session 字段
  function buildSession(cfg, overrides) {
    var o = overrides || {};
    var session = {
      model: o.model || cfg.model,
      instructions: o.instructions || cfg.instructions,
      audio: {
        input: {
          format: { type: 'pcm', rate: o.inputRate || cfg.inputRate }
        },
        output: {
          format: { type: 'pcm_s16le', rate: o.outputRate || cfg.outputRate },
          voice: o.speaker || cfg.speaker,
          speed: o.speed === undefined ? cfg.speed : o.speed,
          loudness: o.loudness === undefined ? cfg.loudness : o.loudness
        }
      },
      extension: {
        asr: {
          extra: {
            end_smooth_window_ms: o.endSmoothWindowMs || cfg.endSmoothWindowMs,
            enable_custom_vad: true
          }
        },
        tts: {
          // 默认下行是 ogg_opus，这里明确要 24k/16bit PCM，便于直接播放
          audio_config: { channel: 1, format: 'pcm_s16le', sample_rate: o.outputRate || cfg.outputRate }
        },
        dialog: {
          // 透传原 StartSessionPayload：bot_name 在 dialog 层，审核/输入模式在 extra 里
          bot_name: o.botName || cfg.botName,
          extra: {
            strict_audit: false,
            input_mod: o.inputMod || cfg.inputMod
          }
        }
      }
    };
    if (cfg.dialect || o.dialect) {
      session.extension.tts.extra = { explicit_dialect: o.dialect || cfg.dialect };
    }
    return session;
  }

  function buildSessionCreate(cfg, overrides) {
    return { type: 'session.create', session: buildSession(cfg, overrides) };
  }

  function wrapWav(pcm, sampleRate) {
    var rate = sampleRate || 24000;
    var head = Buffer.alloc(44);
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
    return Buffer.concat([head, pcm]);
  }

  return {
    DEFAULTS: DEFAULTS,
    defaultPath: defaultPath,
    load: load,
    buildSession: buildSession,
    buildSessionCreate: buildSessionCreate,
    wrapWav: wrapWav
  };
});
