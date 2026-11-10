/* 主动语音：定时提醒（喝水 / 起身 / 做饭）+ 牌局闲聊（关键墩、局势、局末）。
 *
 * 只在「语音开着、没在说话、老人也没刚开口」时主动开口，避免抢话。
 * 同时每 5 秒把实时牌局摘要推给主进程，让老人随口问「打到边」时也答得出。
 *
 * 参数存在本地：localStorage['tractor.reminders']
 *   { enabled: true, waterMin: 45, standMin: 60,
 *     cookTimes: ['10:30', '17:00'], chatMin: 6 }
 */
(function () {
  'use strict';

  var bridge = window.tractorVoice;
  var vs = window.tractorVoiceState =
    window.tractorVoiceState || { active: false, speaking: false, lastHeardAt: 0, llmReady: false };

  var DEF = {
    enabled: true, waterMin: 45, standMin: 60,
    cookTimes: ['10:30', '17:00'], chatMin: 6
  };
  var cfg = (function () {
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem('tractor.reminders') || '{}'); } catch (e) { saved = {}; }
    var out = {};
    for (var k in DEF) out[k] = saved[k] === undefined ? DEF[k] : saved[k];
    return out;
  })();

  var lastWater = Date.now();
  var lastStand = Date.now();
  var lastCook = {};      // '2026-10-24 17:00' -> true，同一时刻只提醒一次
  var lastChat = Date.now(); // 上一次主动聊牌局
  var lastSpoke = 0;      // 上一次开口（任何话术），用于控制密度

  function canTalk(gapMs) {
    if (!bridge || !vs.active) return false;
    if (vs.speaking) return false;
    return Date.now() - (vs.lastHeardAt || 0) > gapMs;
  }

  // 固定话术，不经过大模型：零延迟、零成本
  function say(text) {
    if (!canTalk(20000)) return false;
    if (Date.now() - lastSpoke < 15000) return false;
    bridge.text(text);
    lastSpoke = Date.now();
    return true;
  }

  // 交给大模型生成口语回复（没配 llm.apiKey 时不发，避免报错）
  function ask(query) {
    if (!vs.llmReady) return false;
    if (!canTalk(25000)) return false;
    if (Date.now() - lastSpoke < 15000) return false;
    bridge.ask(query);
    lastSpoke = Date.now();
    return true;
  }

  function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

  var WATER = ['飲啖水先啦，講咗咁耐。', '夠鐘飲水喇，潤下喉嚨。'];
  var STAND = ['坐咗咁耐，起身行兩步，鬆下腳骨。', '腰骨攰唔攰呀？企起身伸個懶腰啦。'];
  var LUNCH = ['差唔多食飯喇，係時候準備午飯。', '中午喇，去煮啲嘢食，牌留住返嚟再打。'];
  var DINNER = ['夠鐘煮晚飯喇，唔好餓親。', '天黑喇，去張羅下晚飯啦。'];

  function checkCook() {
    var now = new Date();
    var day = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate();
    for (var i = 0; i < cfg.cookTimes.length; i++) {
      var parts = String(cfg.cookTimes[i]).split(':');
      var h = parseInt(parts[0], 10);
      var m = parseInt(parts[1], 10) || 0;
      if (isNaN(h)) continue;
      var at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
      var late = now - at;
      if (late < 0 || late > 30 * 60000) continue; // 到点后 30 分钟内提醒，错过就不补
      var key = day + ' ' + cfg.cookTimes[i];
      if (lastCook[key]) continue;
      if (say(pick(h < 15 ? LUNCH : DINNER))) lastCook[key] = true;
    }
  }

  function snapshot() {
    try { return (window.tractorSnapshot && window.tractorSnapshot()) || ''; } catch (e) { return ''; }
  }

  // 实时牌局推给主进程：让每一次对话都带着当前局势
  function publish() {
    if (!bridge || !vs.active) return;
    var s = snapshot();
    if (s) bridge.context(s);
  }

  // 每 30 秒：提醒 + 局势闲聊
  function tick() {
    if (!cfg.enabled) return;
    var t = Date.now();
    publish();
    // 语音没开时不做提醒，同时把计时器拨到现在，避免下次开语音时连珠炮补发
    if (!vs.active) {
      lastWater = t;
      lastStand = t;
      lastChat = t;
      return;
    }
    if (t - lastWater >= cfg.waterMin * 60000 && say(pick(WATER))) lastWater = t;
    if (t - lastStand >= cfg.standMin * 60000 && say(pick(STAND))) lastStand = t;
    checkCook();

    // 隔一阵主动聊一句局势
    if (t - lastChat >= cfg.chatMin * 60000) {
      var angles = [
        '讲下而家边边队佔上风。',
        '提点下老人家手上副牌点样安排。',
        '讲下仲差几多分先过线。',
        '问下佢觉得呢局有无把握。'
      ];
      var okChat = ask('（系統提示，唔係老人家講嘢）而家嘅牌局係：' + snapshot() +
                       '。請用廣東話口語主動同老人家傾兩句，' + pick(angles) +
                       '唔好羅列數字，唔好講書面語，句子要短。');
      if (okChat) lastChat = t;
    }
  }

  setInterval(tick, 30000);
  setInterval(publish, 5000);

  window.tractorChat = {
    cfg: cfg,
    say: say,
    ask: ask,
    snapshot: snapshot,
    // 一局结束：让大模型用一两句口语点评这局
    onRoundEnd: function () {
      var snap = snapshot();
      if (!snap) return;
      ask('（系統提示，唔係老人家講嘢）呢局牌啱啱打完：' + snap +
          '。請用廣東話口語，好似陪老人家睇牌咁，講一兩句好短嘅點評，' +
          '可以講下邊個打得靚、邊手牌可惜，唔好羅列數字，唔好講書面語。');
    },
    // 关键墩：有分或者被毙的时候点评一句，别每墩都吵
    onTrickEnd: function (last, g) {
      if (!last) return;
      var pts = last.points || 0;
      if (!pts && Math.random() > 0.15) return;
      if (pts < 5 && Math.random() > 0.35) return;
      if (Date.now() - lastSpoke < 45000) return;
      var mine = (last.winner % 2) === 0;
      var winTxt = mine ? '你嗰边赢咗呢一墩' : '对面赢咗呢一墩';
      var SEAT = (window.TractorEngine && window.TractorEngine.SEAT_NAME) || ['你', '东', '北', '西'];
      var plays = (last.plays || []).map(function (p) {
        return (p.seat === 0 ? '你' : SEAT[p.seat]) + '出咗' + p.cards.length + '张';
      }).join('，');
      ask('（系統提示，唔係老人家講嘢）啱啱完咗一墩：' + winTxt +
          (pts ? '，呢一墩有 ' + pts + ' 分' : '，呢一墩冇分') +
          '（' + plays + '）。而家牌局：' + snapshot() +
          '。請用廣東話口語講一兩句好短嘅反應，好似陪老人家睇牌咁，唔好羅列數字。');
    }
  };
})();
