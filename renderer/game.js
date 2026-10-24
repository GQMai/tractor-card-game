/* 拖拉机 · 界面与对局流程 */
(function () {
  'use strict';

  var E = window.TractorEngine;
  var $ = function (sel) { return document.querySelector(sel); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  function loadSettings() {
    var def = { decks: 4, rule: 1, noTrump: true, sound: true, dealSpeed: 200 };
    try {
      var saved = JSON.parse(localStorage.getItem('tractor.settings') || '{}');
      return Object.assign(def, saved);
    } catch (e) { return def; }
  }
  function saveSettings() {
    localStorage.setItem('tractor.settings', JSON.stringify(settings));
  }

  var settings = loadSettings();
  var state = {
    game: null,
    mode: 'idle',
    selected: new Set(),
    busy: false,
    displayTrick: [],
    winnerSeat: null,
    soundOn: settings.sound,
    holdUntil: 0,
    epoch: 0
  };
  var lastTrickKey = '';
  var autoNextTimer = null;

  function clearAutoNext() {
    if (autoNextTimer) { clearInterval(autoNextTimer); autoNextTimer = null; }
  }

  // ------------------------------------------------------------- 音效
  var audioCtx = null;
  function audio() {
    if (!audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }
  function tone(freq, dur, type, gain, delay) {
    var ac = audio();
    if (!ac) return;
    var t = ac.currentTime + (delay || 0);
    var osc = ac.createOscillator();
    var g = ac.createGain();
    osc.type = type || 'sine';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain || 0.05, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(ac.destination);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }
  function sfx(name) {
    if (!state.soundOn) return;
    switch (name) {
      case 'deal': tone(380 + Math.random() * 120, 0.05, 'triangle', 0.022); break;
      case 'click': tone(640, 0.05, 'square', 0.025); break;
      case 'play': tone(180, 0.1, 'sine', 0.05); break;
      case 'error': tone(170, 0.16, 'sawtooth', 0.035); break;
      case 'start':
        tone(392, 0.1, 'triangle', 0.04);
        tone(523, 0.16, 'triangle', 0.04, 0.1);
        break;
      case 'win':
        tone(523, 0.12, 'sine', 0.045);
        tone(659, 0.12, 'sine', 0.045, 0.09);
        tone(784, 0.18, 'sine', 0.045, 0.18);
        break;
      case 'lose':
        tone(330, 0.14, 'sine', 0.04);
        tone(220, 0.22, 'sine', 0.04, 0.12);
        break;
    }
  }

  // ------------------------------------------------------------- 渲染工具
  function ctxForDisplay() {
    var g = state.game;
    if (!g) return null;
    if (g.ctx) return g.ctx;
    return E.makeContext(g.trumpSuit == null ? 4 : g.trumpSuit, g.level || 2, g.bankerTeam);
  }

  var SUIT_FILE = ['diamonds', 'clubs', 'hearts', 'spades'];
  var RANK_FILE = { 11: 'jack', 12: 'queen', 13: 'king', 14: 'ace' };

  function cardFace(card) {
    if (E.isJoker(card)) return 'assets/cards/Joker' + (E.rankOf(card) === 17 ? 1 : 2) + '.png';
    var rank = E.rankOf(card);
    var key = RANK_FILE[rank] || (rank < 10 ? '0' + rank : String(rank));
    return 'assets/cards/' + SUIT_FILE[E.suitOf(card)] + '_' + key + '.png';
  }

  function cardHTML(card, extra) {
    var cls = 'card ' + (extra || '');
    return '<div class="' + cls + '"><img class="face" alt="" draggable="false" src="' +
      cardFace(card) + '"></div>';
  }

  function sortedHand() {
    var g = state.game;
    if (!g) return [];
    var ctx = ctxForDisplay();
    var entries = g.hands[0].map(function (card, idx) { return { card: card, idx: idx }; });
    if (!ctx) return entries;
    entries.sort(function (a, b) {
      var ga = E.groupOf(ctx, a.card), gb = E.groupOf(ctx, b.card);
      var ka = ga === 4 ? -1 : ga, kb = gb === 4 ? -1 : gb;
      if (ka !== kb) return ka - kb;
      var oa = E.orderOf(ctx, a.card), ob = E.orderOf(ctx, b.card);
      if (oa !== ob) return ob - oa;
      return a.card - b.card;
    });
    return entries;
  }

  function selectedCards() {
    var g = state.game, out = [];
    if (!g) return out;
    state.selected.forEach(function (idx) {
      if (g.hands[0][idx] !== undefined) out.push(g.hands[0][idx]);
    });
    return out;
  }

  function renderHeader() {
    var g = state.game;
    if (!g) return;
    $('#lvl0').textContent = g.teamLevels[0];
    $('#lvl1').textContent = g.teamLevels[1];
    $('#team0').classList.toggle('banker', g.bankerTeam === 0);
    $('#team1').classList.toggle('banker', g.bankerTeam === 1);

    var trump;
    if (g.trumpSuit == null) trump = '主牌 未定';
    else if (g.trumpSuit === 4) trump = '主牌 无主';
    else trump = '主牌 ' + E.SUIT_LABEL[g.trumpSuit] + ' ' + E.SUIT_NAME[g.trumpSuit];
    if (g.declarer != null) trump += ' · ' + E.SEAT_NAME[g.declarer] + '亮';
    $('#trumpInfo').textContent = trump;
    $('#roundInfo').textContent = '第 ' + g.roundNo + ' 局 · ' + g.decks + ' 副 · ' +
      (g.rule === 1 ? '规则一' : '规则二');

    var line = 40 * g.decks;
    $('#scoreNow').textContent = g.defenderPoints;
    $('#scoreLine').textContent = line;
    var pct = Math.min(100, line ? g.defenderPoints / line * 100 : 0);
    $('#scoreFill').style.width = pct + '%';
  }

  // 座位身份标记：谁坐庄、谁亮主（含主牌花色）
  var lastTags = {};
  function seatTags(seat) {
    var g = state.game, html = '';
    if (!g) return html;
    if (g.bankerSeat === seat) html += '<span class="seat-tag banker">庄</span>';
    if (g.declarer === seat && g.trumpSuit != null) {
      html += '<span class="seat-tag declarer">亮' +
        (g.trumpSuit === 4 ? '无主' : E.SUIT_LABEL[g.trumpSuit]) + '</span>';
    }
    return html;
  }

  function renderSeats() {
    var g = state.game;
    if (!g) return;
    for (var s = 0; s <= 3; s++) {
      var html2 = seatTags(s);
      if (lastTags[s] !== html2) {
        lastTags[s] = html2;
        $('#tags' + s).innerHTML = html2;
      }
    }
    for (var s = 1; s <= 3; s++) {
      var el = $('#seat' + s);
      var n = g.hands[s].length;
      $('#count' + s).textContent = n;
      var holder = $('#cards' + s);
      var shown = Math.min(n, s === 2 ? 10 : 7);
      var html = '';
      for (var i = 0; i < shown; i++) html += '<div class="mini-back"></div>';
      holder.innerHTML = html;
      el.classList.toggle('active', g.phase === 'play' && g.turn === s && !state.busy);
    }
  }

  // 亮主/扣底阶段：把亮主用的级牌（王）摆在亮主者的出牌位，方便所有人确认主牌
  function bidDisplay() {
    var g = state.game;
    if (!g || (g.phase !== 'deal' && g.phase !== 'bury')) return null;
    if (g.declarer == null || !g.declareCards || !g.declareCards.length) return null;
    return { seat: g.declarer, cards: g.declareCards };
  }

  function renderTrick() {
    var g = state.game;
    if (!g) return;
    var bid = bidDisplay();
    var plays = bid ? [bid] : (state.displayTrick.length ? state.displayTrick : g.trick);
    var key = (bid ? 'bid' : 'play') + '|' +
      plays.map(function (p) { return p.seat + ':' + p.cards.join(','); }).join('|') +
      '|w' + (state.winnerSeat == null ? '' : state.winnerSeat);
    if (key === lastTrickKey) return;
    lastTrickKey = key;

    var area = $('#trickArea');
    var html = '';
    plays.forEach(function (p) {
      var inner = p.cards.map(function (c) { return cardHTML(c, 'mini-card'); }).join('');
      var tag = bid ? '<div class="winner-tag">亮</div>'
        : (state.winnerSeat === p.seat ? '<div class="winner-tag">赢</div>' : '');
      html += '<div class="trick-slot s' + p.seat + '">' + tag + inner + '</div>';
    });
    area.innerHTML = html;
  }

  // 手牌按“主牌 / 主花色 / 各副牌花色”分行，共 5 行
  function handRowKey(card, ctx) {
    if (!ctx || !E.isTrump(ctx, card)) return 's' + E.suitOf(card);
    return 'trump';
  }

  function handRows(entries, ctx) {
    var rows = [], byKey = {};
    function addRow(key, label, cls, red) {
      var row = { key: key, label: label, cls: cls, red: !!red, cards: [] };
      byKey[key] = row;
      rows.push(row);
    }
    if (ctx) {
      addRow('trump', '主', 'trump');
    }
    for (var s = 0; s < 4; s++) {
      if (ctx && ctx.trumpSuit === s) continue;
      addRow('s' + s, E.SUIT_LABEL[s], 'suit', s === 0 || s === 2);
    }
    entries.forEach(function (e) {
      var key = handRowKey(e.card, ctx);
      if (byKey[key]) byKey[key].cards.push(e);
    });
    return rows.filter(function (r) { return r.cards.length > 0; });
  }

  function renderHand() {
    var g = state.game;
    var zone = $('#handCards');
    if (!g) { zone.innerHTML = ''; return; }
    var rows = handRows(sortedHand(), ctxForDisplay());
    var avail = Math.max(280, zone.clientWidth - 46);
    var budget = Math.max(150, zone.clientHeight);
    var n = rows.length || 1;
    var maxCount = 1;
    rows.forEach(function (row) { if (row.cards.length > maxCount) maxCount = row.cards.length; });

    // 每行独立成条，互不压盖：除最后一行完整显示外，其余各行只保留一条露出角标的窄带
    // 窄条高度固定为牌高的 33%，刚好完整露出真实牌面的点数与花色；
    // 其余高度留给最后一行整张牌，使手牌尽量大且不越界
    var cardH0 = Math.round(budget / (1 + 0.33 * (n - 1)));
    var stripH = n > 1 ? Math.round(cardH0 * 0.33) : 0;
    var cardH = n > 1 ? budget - stripH * (n - 1) : Math.min(150, budget);
    cardH = Math.max(60, Math.min(150, cardH));
    var cardW = Math.round(cardH * 0.6875);
    var baseStep = Math.max(22, Math.round(cardW * 0.46));
    var step = maxCount > 1
      ? Math.min(baseStep, Math.floor((avail - cardW) / (maxCount - 1)))
      : baseStep;
    step = Math.max(16, step);
    var blockW = Math.min(avail, cardW + (maxCount - 1) * step);

    var html = '';
    rows.forEach(function (row, ri) {
      var isLast = ri === rows.length - 1;
      var cards = '';
      row.cards.forEach(function (e, i) {
        var sel = state.selected.has(e.idx);
        var style = 'width:' + cardW + 'px;height:' + cardH + 'px;margin-left:' +
          (i === 0 ? 0 : -(cardW - step)) + 'px;--rz:' + (i + 1) + ';';
        cards += cardHTML(e.card, 'hand-card' + (sel ? ' selected' : ''))
          .replace('<div class="', '<div data-idx="' + e.idx + '" style="' + style + '" class="');
      });
      // 每行都按整张牌铺开，后一行用负 margin 压住上一行的下半部分：
      // 上一行只露角标，宽出来的牌则完整显示，不会被裁成半截
      var rowStyle = 'height:' + cardH + 'px;--strip:' + (isLast ? cardH : stripH) + 'px;' +
        (ri === 0 ? '' : 'margin-top:' + (stripH - cardH) + 'px;');
      html += '<div class="hand-row ' + row.cls + (isLast ? '' : ' strip') + '" style="' + rowStyle + '">' +
        '<span class="hand-row-label' + (row.red ? ' red' : '') + '">' + row.label + '</span>' +
        '<div class="hand-row-cards" style="width:' + blockW + 'px;height:' + cardH + 'px">' + cards + '</div>' +
        '</div>';
    });
    zone.innerHTML = html;
  }

  function renderDeclare() {
    var g = state.game;
    var bar = $('#declareBar');
    var show = g && g.phase === 'deal';
    bar.classList.toggle('hidden', !show);
    if (!show) return;
    var buttons = bar.querySelectorAll('.declare-btn');
    for (var i = 0; i < buttons.length; i++) {
      var suit = Number(buttons[i].getAttribute('data-suit'));
      var opt = g.declareOption(0, suit);
      buttons[i].classList.toggle('disabled', !opt.ok);
      buttons[i].title = opt.ok
        ? '叫' + (suit === 4 ? '无主' : E.SUIT_NAME[suit]) + '（' + opt.count + ' 张' + (suit === 4 ? '王' : '级牌') + '）'
        : (opt.msg || '');
    }
  }

  function renderControls() {
    var g = state.game;
    var hint = $('#handHint');
    var btnPlay = $('#btnPlay');
    var btnHint = $('#btnHint');
    var btnClear = $('#btnClear');
    var sel = selectedCards().length;
    var canPlay = false, label = '出牌';

    if (!g) {
      hint.textContent = '准备开始…';
    } else if (g.phase === 'deal') {
      if (g.dealDone) {
        var left = Math.max(0, Math.ceil((state.holdUntil - Date.now()) / 1000));
        hint.textContent = '发牌结束 · 叫主倒计时 ' + left + ' 秒：点“叫主”按钮选花色，张数更多可反主';
      } else {
        hint.textContent = '发牌中 ' + g.hands[0].length + ' / ' + g.perPlayer +
          ' … 手上有级牌时可点“叫主”按钮亮主';
      }
    } else if (g.phase === 'bury') {
      if (g.bankerSeat === 0) {
        hint.textContent = '你是庄家：已选 ' + sel + ' / ' + g.bottomN + ' 张，请扣底（右键可选该花色右侧全部牌）';
        label = '扣底';
        canPlay = sel === g.bottomN && !state.busy;
      } else {
        hint.textContent = '庄家正在扣底…';
      }
    } else if (g.phase === 'play') {
      if (g.turn === 0) {
        if (g.lead) {
          hint.textContent = '轮到你跟牌：需要出 ' + g.lead.cards.length + ' 张' +
            (g.lead.cards.length > 1 ? '（对子/三条/四条/同型链要跟足）' : '') +
            '；右键可选该花色右侧全部牌';
        } else {
          hint.textContent = '轮到你首出：单张 / 对子 / 三条 / 四条 / 拖拉机 / 推土机 / 甩牌；右键选该花色右侧全部牌';
        }
        canPlay = sel > 0 && !state.busy;
      } else {
        hint.textContent = '等待其他玩家出牌…';
      }
    } else if (g.phase === 'roundEnd') {
      hint.textContent = '本局结束';
    }

    btnPlay.textContent = label;
    btnPlay.classList.toggle('disabled', !canPlay);
    btnClear.classList.toggle('disabled', sel === 0 || state.busy);
    var canHint = g && g.phase === 'play' && g.turn === 0 && !state.busy;
    btnHint.classList.toggle('disabled', !canHint);
  }

  function renderCenterTip() {
    var g = state.game;
    var t = '';
    if (g) {
      if (g.phase === 'deal') t = g.dealDone ? '叫主' : '发牌中';
      else if (g.phase === 'bury') t = '扣底';
      else if (g.phase === 'play') t = '第 ' + (g.trickNo + 1) + ' 墩';
      else if (g.phase === 'roundEnd') t = '本局结束';
    }
    $('#centerTipText').textContent = t;
  }

  function render() {
    renderHeader();
    renderSeats();
    renderTrick();
    renderHand();
    renderDeclare();
    renderControls();
    renderCenterTip();
  }

  // ------------------------------------------------------------- 提示
  var toastTimer = null;
  function toast(msg, type) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('error', type === 'error');
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2400);
  }

  // ------------------------------------------------------------- 弹窗
  function showModal(title, bodyHTML, actions) {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = bodyHTML;
    var box = $('#modalActions');
    box.innerHTML = '';
    actions.forEach(function (a) {
      var b = document.createElement('button');
      b.textContent = a.label;
      if (a.primary) b.className = 'primary';
      b.addEventListener('click', function () {
        hideModal();
        if (a.onClick) a.onClick();
      });
      box.appendChild(b);
    });
    $('#modal').classList.remove('hidden');
  }
  function hideModal() {
    clearAutoNext();
    $('#modal').classList.add('hidden');
  }

  function showSettings() {
    var first = !state.game;
    var body =
      '<div class="setting-row"><div class="label"><b>牌副数</b>' +
      '<span>1–4 副牌；偶数副 8 张底牌，奇数副 6 张底牌</span></div>' +
      '<div class="segmented" data-key="decks">' +
      [1, 2, 3, 4].map(function (d) {
        return '<button data-val="' + d + '" class="' + (settings.decks === d ? 'on' : '') + '">' + d + ' 副</button>';
      }).join('') + '</div></div>' +
      '<div class="setting-row"><div class="label"><b>升级规则</b>' +
      '<span>规则一：大光升 3 级；规则二：按差值连续升级</span></div>' +
      '<div class="segmented" data-key="rule">' +
      [1, 2].map(function (r) {
        return '<button data-val="' + r + '" class="' + (settings.rule === r ? 'on' : '') + '">规则' + (r === 1 ? '一' : '二') + '</button>';
      }).join('') + '</div></div>' +
      '<div class="setting-row"><div class="label"><b>发牌速度</b>' +
      '<span>每轮发牌间隔，越慢越有时间看牌、亮主</span></div>' +
      '<div class="segmented" data-key="dealSpeed">' +
      [['慢', 320], ['标准', 200], ['快', 120]].map(function (o) {
        return '<button data-val="' + o[1] + '" class="' + (settings.dealSpeed === o[1] ? 'on' : '') + '">' + o[0] + '</button>';
      }).join('') + '</div></div>' +
      '<div class="setting-row"><div class="label"><b>允许无主</b>' +
      '<span>持有两张王时可亮无主</span></div>' +
      '<div class="segmented" data-key="noTrump">' +
      '<button data-val="on" class="' + (settings.noTrump ? 'on' : '') + '">开</button>' +
      '<button data-val="off" class="' + (!settings.noTrump ? 'on' : '') + '">关</button>' +
      '</div></div>' +
      '<div class="setting-row"><div class="label"><b>音效</b><span>发牌、出牌与收墩提示音</span></div>' +
      '<div class="segmented" data-key="sound">' +
      '<button data-val="on" class="' + (settings.sound ? 'on' : '') + '">开</button>' +
      '<button data-val="off" class="' + (!settings.sound ? 'on' : '') + '">关</button>' +
      '</div></div>';

    var actions = [
      {
        label: first ? '开始游戏' : '开始新局', primary: true, onClick: function () {
          saveSettings();
          startNewGame();
        }
      }
    ];
    if (!first) actions.unshift({ label: '取消' });
    showModal(first ? '开始游戏' : '新局设置', body, actions);

    var segs = document.querySelectorAll('#modalBody .segmented');
    for (var i = 0; i < segs.length; i++) {
      segs[i].addEventListener('click', function (ev) {
        var btn = ev.target.closest('button');
        if (!btn) return;
        var key = this.getAttribute('data-key');
        var val = btn.getAttribute('data-val');
        settings[key] = (key === 'decks' || key === 'rule' || key === 'dealSpeed')
          ? Number(val) : (val === 'on');
        var siblings = this.querySelectorAll('button');
        for (var j = 0; j < siblings.length; j++) siblings[j].classList.toggle('on', siblings[j] === btn);
        if (key === 'sound') {
          state.soundOn = settings.sound;
          updateSoundBtn();
        }
        sfx('click');
      });
    }
  }

  function showRules() {
    var body =
      '<h3>牌型</h3><ul>' +
      '<li>单张、对子（同花色同点数两张）、三条（三副牌起，同点数三张）、四条（四副牌，同点数四张）。</li>' +
      '<li>拖拉机（同花色连续的对子）、推土机（同花色连续的三条）、连四条（同花色连续的四条）。</li>' +
      '<li>甩牌：同花色的多组牌一次打出。只要其中最大的那一段（决定这墩归属的结构）' +
      '大过其余三家可能持有的同型牌、且没人能用同型主牌毙，就能甩；其余小牌被盖过不影响结果。</li>' +
      '<li>比大小必须结构相同：对子只能压对子，三条只能压三条，四条只能压四条，同型链只能压同型链；' +
      '两张单牌压不住对子，两对也压不住四条。</li>' +
      '<li>大小王、级牌与主花色都属于主牌；大王 &gt; 小王 &gt; 正级 &gt; 副级 &gt; A &gt; K … &gt; 2。</li>' +
      '</ul><h3>跟牌</h3><ul>' +
      '<li>首家出什么花色，有该花色的牌就必须跟该花色。</li>' +
      '<li>首家出对子/三条/四条时，手里有同结构必须跟出；没有三条时按“对子+单张”补足，最后才拆单张。</li>' +
      '<li>首家出拖拉机/推土机/连四条时，有同型同长的链必须整段跟出，否则先出完所有对子/三条，再补单张。</li>' +
      '<li>该门牌不够时，必须先出完该门，再用其他牌垫足张数。</li>' +
      '<li>没有该门花色时可以出主牌“毙”，但结构必须对得上首家（毙三条要主牌三条），否则只算垫牌。</li>' +
      '</ul><h3>亮主</h3><ul>' +
      '<li>发牌过程中随时可以亮主：手里有当前级牌即可按花色亮主；张数更多的一方可以反主。</li>' +
      '<li>两张王可以亮无主（需在设置中开启）。</li>' +
      '<li>发完牌后还有 3 秒亮主时间；仍无人亮主时翻底定主：底牌里有庄家级牌就用该花色，否则取牌堆第一张普通牌的花色。</li>' +
      '</ul><h3>计分与升级</h3><ul>' +
      '<li>5 计 5 分，10 和 K 各计 10 分，每副牌共 100 分。</li>' +
      '<li>闲家收墩得分；闲家赢得最后一墩时，底牌分数 × 副数 × 末墩张数一并计入。</li>' +
      '<li>分数线为 40 × 副数。规则一：0 分庄家升 3 级，小于 20×副数升 2 级，未过线升 1 级；' +
      '过线则闲家上台并按每 10×副数升 1 级。</li>' +
      '<li>首局庄家随机；打过 A 后本局结束，可重新开始。</li>' +
      '</ul>';
    showModal('游戏规则', body, [{ label: '知道了', primary: true }]);
  }

  function showRoundEnd() {
    var g = state.game;
    if (!g || !g.roundResult) return;
    var r = g.roundResult;
    var team = E.TEAM_NAME[r.winnerTeam];
    var banker = E.TEAM_NAME[r.bankerTeam];
    var autoNext = !g.gameOver;
    var body =
      '<div class="big">' + (r.winnerTeam === 0 ? '南北' : '东西') + ' 升级 ' + r.delta + ' 级</div>' +
      '<div class="result-line"><span>庄家</span><b>' + banker + '</b></div>' +
      '<div class="result-line"><span>闲家得分</span><b>' + r.defenderPoints + ' 分</b></div>' +
      (g.lastTrickBonus ? '<div class="result-line"><span>其中底牌加分</span><b>' + g.lastTrickBonus + ' 分</b></div>' : '') +
      '<div class="result-line"><span>当前进度</span><b>南北 ' + g.teamLevels[0] + ' · 东西 ' + g.teamLevels[1] + '</b></div>' +
      (r.delta === 0 ? '<div class="note">闲家上台但未达到升级分数，双方等级不变。</div>' : '') +
      (g.gameOver ? '<div class="note">已打过 A，本局结束，可重新开始。</div>'
                  : '<div class="note" id="autoNextNote">3 秒后自动进入下一局</div>');

    var actions = g.gameOver
      ? [{ label: '重新开始', primary: true, onClick: startNewGame }]
      : [{ label: '下一局', primary: true, onClick: nextRound }];
    showModal('本局结束', body, actions);

    // 无需点击，倒计时结束自动开下一局；观众点“下一局”会提前进入并清掉计时器
    if (autoNext) {
      clearAutoNext();
      var left = 3;
      autoNextTimer = setInterval(function () {
        left--;
        var note = document.getElementById('autoNextNote');
        if (left <= 0) {
          clearAutoNext();
          nextRound();
          return;
        }
        if (note) note.textContent = left + ' 秒后自动进入下一局';
      }, 1000);
    }
  }

  // ------------------------------------------------------------- 对局流程
  function alive(epoch) { return state.epoch === epoch; }

  async function startNewGame() {
    hideModal();
    state.epoch++;
    var epoch = state.epoch;
    state.game = new E.Game({
      decks: settings.decks,
      rule: settings.rule,
      allowNoTrump: settings.noTrump,
      humanSeat: 0,
      dealHold: true,
      rng: Math.random
    });
    state.selected.clear();
    state.displayTrick = [];
    state.winnerSeat = null;
    state.mode = 'deal';
    state.busy = false;
    lastTrickKey = 'x';
    state.game.startRound();
    render();
    await dealFlow(state.game, epoch);
  }

  async function dealFlow(g, epoch) {
    state.busy = true;
    state.mode = 'deal';
    state.holdUntil = 0;
    render();
    var interval = Math.max(60, Number(settings.dealSpeed) || 200);
    var holdMs = 6000;
    while (g.phase === 'deal' && !g.dealDone) {
      g.dealStep(1);
      // 发完最后一张就立刻进入叫主倒计时，避免提示闪出“0 秒”
      if (g.dealDone) state.holdUntil = Date.now() + holdMs;
      for (var s = 1; s < 4; s++) g.aiMaybeDeclare(s);
      render();
      sfx('deal');
      await sleep(interval);
      if (!alive(epoch)) return;
    }

    // 叫主窗口：发完牌后留足时间看牌、叫主/反主（旧程序发牌结束后叫牌按钮仍可点）
    if (g.phase === 'deal' && g.dealDone) {
      if (!state.holdUntil) state.holdUntil = Date.now() + holdMs;
      while (g.phase === 'deal' && g.dealDone) {
        render();
        if (Date.now() >= state.holdUntil) break;
        await sleep(100);
        if (!alive(epoch)) return;
      }
      state.holdUntil = 0;
      if (!alive(epoch)) return;
      g.finishDealNow();
    }

    render();
    await sleep(240);
    if (!alive(epoch)) return;

    if (g.phase === 'bury') {
      if (g.bankerSeat === 0) {
        state.mode = 'bury';
        state.busy = false;
        render();
        toast('你是庄家，请选 ' + g.bottomN + ' 张牌扣底');
        return;
      }
      var cards = E.autoBury(g.hands[g.bankerSeat], g.ctx, g.bottomN);
      g.bury(g.bankerSeat, cards);
      render();
      await sleep(320);
      if (!alive(epoch)) return;
    }

    state.mode = 'play';
    state.busy = false;
    sfx('start');
    render();
    if (g.phase === 'play' && g.turn !== 0) runAi();
  }

  async function runAi() {
    var epoch = state.epoch;
    var g = state.game;
    state.busy = true;
    while (g.phase === 'play' && g.turn !== 0) {
      await sleep(430);
      if (!alive(epoch)) return;
      var seat = g.turn;
      var cards = E.aiChoose(g, seat);
      var r = g.play(seat, cards);
      if (!r.ok) {
        console.error('AI 出牌失败', seat, cards, r.msg);
        toast('电脑出牌异常：' + r.msg, 'error');
        break;
      }
      sfx('play');
      if (r.trickEnd) {
        await showTrickEnd(r);
        if (!alive(epoch)) return;
        if (g.phase === 'roundEnd') break;
      } else {
        render();
      }
    }
    if (!alive(epoch)) return;
    state.busy = false;
    if (g.phase !== 'roundEnd') state.mode = 'play';
    render();
  }

  async function showTrickEnd() {
    var g = state.game;
    if (g.lastTrick) {
      state.displayTrick = g.lastTrick.plays.slice();
      state.winnerSeat = g.lastTrick.winner;
    }
    render();
    sfx(E.teamOf(state.winnerSeat) === E.teamOf(0) ? 'win' : 'lose');
    await sleep(1000);
    state.displayTrick = [];
    state.winnerSeat = null;
    render();
    if (g.phase === 'roundEnd') showRoundEnd();
  }

  async function humanPlay() {
    var g = state.game;
    if (!g || state.busy) return;
    var epoch = state.epoch;
    var cards = selectedCards();

    if (state.mode === 'bury') {
      if (g.bankerSeat !== 0) return;
      if (cards.length !== g.bottomN) {
        sfx('error');
        return toast('必须正好选择 ' + g.bottomN + ' 张底牌（当前 ' + cards.length + ' 张）', 'error');
      }
      var br = g.bury(0, cards);
      if (!br.ok) { sfx('error'); return toast(br.msg, 'error'); }
      state.selected.clear();
      state.mode = 'play';
      sfx('click');
      render();
      if (g.turn !== 0) runAi(); else render();
      return;
    }

    if (state.mode !== 'play' || g.turn !== 0) return;
    if (!cards.length) { sfx('error'); return toast('请先选择要出的牌', 'error'); }

    var r = g.play(0, cards);
    if (!r.ok) { sfx('error'); return toast(r.msg, 'error'); }

    state.selected.clear();
    sfx('play');
    if (r.trickEnd) {
      state.busy = true;
      await showTrickEnd();
      if (!alive(epoch)) return;
      state.busy = false;
      if (g.phase === 'play') {
        render();
        if (g.turn !== 0) runAi();
      } else {
        render();
      }
    } else {
      render();
      runAi();
    }
  }

  function nextRound() {
    hideModal();
    var g = state.game;
    if (!g) { startNewGame(); return; }
    if (g.gameOver) { startNewGame(); return; }
    state.epoch++;
    var epoch = state.epoch;
    g.nextRound();
    state.selected.clear();
    state.displayTrick = [];
    state.winnerSeat = null;
    state.mode = 'deal';
    state.busy = false;
    lastTrickKey = 'y' + epoch;
    render();
    dealFlow(g, epoch);
  }

  function hint() {
    var g = state.game;
    if (!g || state.mode !== 'play' || g.turn !== 0 || state.busy) return;
    var cards = E.aiChoose(g, 0);
    state.selected.clear();
    cards.forEach(function (c) {
      for (var i = 0; i < g.hands[0].length; i++) {
        if (g.hands[0][i] === c && !state.selected.has(i)) {
          state.selected.add(i);
          break;
        }
      }
    });
    sfx('click');
    renderHand();
    renderControls();
  }

  function updateSoundBtn() {
    $('#btnSound').textContent = '音效：' + (state.soundOn ? '开' : '关');
  }

  // ------------------------------------------------------------- 事件绑定
  $('#btnNew').addEventListener('click', function () { sfx('click'); showSettings(); });
  $('#btnRules').addEventListener('click', function () { sfx('click'); showRules(); });
  $('#btnSound').addEventListener('click', function () {
    state.soundOn = !state.soundOn;
    settings.sound = state.soundOn;
    saveSettings();
    updateSoundBtn();
    sfx('click');
  });
  function safePlay() {
    humanPlay().catch(function (e) { console.error(e); });
  }
  $('#btnPlay').addEventListener('click', safePlay);
  $('#btnClear').addEventListener('click', function () {
    if (state.busy) return;
    state.selected.clear();
    renderHand();
    renderControls();
    sfx('click');
  });
  $('#btnHint').addEventListener('click', hint);

  $('#handCards').addEventListener('click', function (ev) {
    var el = ev.target.closest('.hand-card');
    if (!el) return;
    var g = state.game;
    if (!g || state.busy) return;
    if (state.mode === 'play' && g.turn !== 0) return;
    if (state.mode !== 'play' && state.mode !== 'bury') return;
    var idx = Number(el.getAttribute('data-idx'));
    if (state.selected.has(idx)) state.selected.delete(idx);
    else state.selected.add(idx);
    sfx('click');
    renderHand();
    renderControls();
  });

  // 右键：把这张牌和同花色右侧（更小）的牌整段选中；这一段已全选时再次右键整段取消
  $('#handCards').addEventListener('contextmenu', function (ev) {
    var el = ev.target.closest('.hand-card');
    if (!el) return;
    ev.preventDefault();
    var g = state.game;
    if (!g || state.busy) return;
    if (state.mode === 'play' && g.turn !== 0) return;
    if (state.mode !== 'play' && state.mode !== 'bury') return;
    var idx = Number(el.getAttribute('data-idx'));
    var ctx = ctxForDisplay();
    var entries = sortedHand();
    var pos = -1;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].idx === idx) { pos = i; break; }
    }
    if (pos < 0) return;
    var key = handRowKey(entries[pos].card, ctx);
    var range = [];
    for (var j = pos; j < entries.length; j++) {
      if (handRowKey(entries[j].card, ctx) !== key) break;
      range.push(entries[j].idx);
    }
    if (!range.length) return;
    var allSelected = range.every(function (k) { return state.selected.has(k); });
    range.forEach(function (k) {
      if (allSelected) state.selected.delete(k);
      else state.selected.add(k);
    });
    sfx('click');
    renderHand();
    renderControls();
  });

  $('#declareBar').addEventListener('click', function (ev) {
    var btn = ev.target.closest('.declare-btn');
    if (!btn || btn.classList.contains('disabled')) return;
    var g = state.game;
    if (!g || g.phase !== 'deal') return;
    var suit = Number(btn.getAttribute('data-suit'));
    var r = g.declare(0, suit);
    if (!r.ok) { sfx('error'); toast(r.msg, 'error'); return; }
    sfx('start');
    toast('亮主成功：' + (suit === 4 ? '无主' : E.SUIT_NAME[suit]));
    render();
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); safePlay(); }
    else if (ev.key === 'Escape') {
      if (!$('#modal').classList.contains('hidden')) {
        if (!state.game) return; // 首次进入必须选择牌副数
        hideModal();
        return;
      }
      state.selected.clear();
      renderHand(); renderControls();
    } else if (ev.key === 'F1') {
      ev.preventDefault();
      showRules();
    } else if (ev.ctrlKey && (ev.key === 'n' || ev.key === 'N')) {
      ev.preventDefault();
      showSettings();
    }
  });

  window.addEventListener('resize', function () {
    if (state.game) renderHand();
  });

  // ------------------------------------------------------------- 启动
  updateSoundBtn();
  showSettings(); // 首次进入先选牌副数与规则
})();
