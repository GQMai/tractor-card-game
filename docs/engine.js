/*
 * 阿春拖拉机 · 规则内核（现代重制版）
 * ------------------------------------------------
 * 依据 Tractor.exe 逆向结果重写：
 *   牌编码   id 0..53，suit = id/13，rank = id%13+2（52/53 为王）
 *   发牌     偶数副 8 张底、奇数副 6 张底，四人均分
 *   亮主     按花色统计当前级牌张数，张数多者压过
 *   牌型     单张 / 对子 / 三条 / 四条 / 拖拉机 / 推土机 / 连四条 / 甩牌
 *   跟牌     有同门必须跟同门，按四条 > 三条 > 对子 > 单张的结构跟足
 *   毙牌     全为主牌且牌型结构与首家一致，才算有效毙牌
 *   升级     大光小光制 / 差值制，收墩后按 0x4076a0 的公式结算
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TractorEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- 基础编码
  var SUIT_LABEL = ['♦', '♣', '♥', '♠'];
  var SUIT_NAME = ['方块', '梅花', '红桃', '黑桃'];
  var RANK_LABEL = {
    2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
    10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 16: '小王', 17: '大王'
  };
  var JOKER_SMALL = 52, JOKER_BIG = 53;

  function suitOf(id) { return Math.floor(id / 13); }
  function rankOf(id) {
    if (id === JOKER_SMALL) return 16;
    if (id === JOKER_BIG) return 17;
    return id % 13 + 2;
  }
  function isJoker(id) { return id >= 52; }
  function pointOf(id) {
    var r = rankOf(id);
    return r === 5 ? 5 : (r === 10 || r === 13) ? 10 : 0;
  }
  function isRed(id) {
    if (id === JOKER_BIG) return true;
    if (id === JOKER_SMALL) return false;
    return suitOf(id) === 0 || suitOf(id) === 2; // ♦ ♥
  }
  function cardName(id) {
    if (isJoker(id)) return RANK_LABEL[rankOf(id)];
    return SUIT_LABEL[suitOf(id)] + RANK_LABEL[rankOf(id)];
  }
  function cardLabel(id) {
    if (isJoker(id)) return rankOf(id) === 17 ? '大王' : '小王';
    return RANK_LABEL[rankOf(id)];
  }

  function makeDeck(decks) {
    var d = [];
    for (var i = 0; i < decks * 54; i++) d.push(i % 54);
    return d;
  }
  function bottomSize(decks) { return decks % 2 === 0 ? 8 : 6; }

  function shuffle(arr, rng) {
    rng = rng || Math.random;
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  // 可复现随机数（测试用）
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------- 主牌体系
  function makeContext(trumpSuit, levels, bankerTeam) {
    var lv = Array.isArray(levels) ? levels.slice() : [levels, levels];
    return {
      trumpSuit: trumpSuit,
      levels: lv,
      topLevel: Math.max.apply(null, lv),
      lowLevel: Math.min.apply(null, lv),
      bankerTeam: bankerTeam || 0
    };
  }

  function isTrump(ctx, id) {
    if (isJoker(id)) return true;
    if (ctx.trumpSuit !== 4 && suitOf(id) === ctx.trumpSuit) return true;
    return ctx.levels.indexOf(rankOf(id)) >= 0;
  }
  function groupOf(ctx, id) { return isTrump(ctx, id) ? 4 : suitOf(id); }

  // 主牌顺序：大王 1700 > 小王 1600 > 主级牌 1500 > 副级牌 1400 > A..2
  // 主级牌 = 主花色的级牌；副级牌 = 其他花色的级牌（无主时所有级牌都算副级）
  function orderOf(ctx, id) {
    var r = rankOf(id);
    if (r === 17) return 1700;
    if (r === 16) return 1600;
    if (isTrump(ctx, id) && (r === ctx.topLevel || r === ctx.lowLevel)) {
      return (ctx.trumpSuit !== 4 && suitOf(id) === ctx.trumpSuit) ? 1500 : 1400;
    }
    return r * 10;
  }

  // ---------------------------------------------------------------- 牌型分解
  /**
   * 把一组牌拆成 单张/对子/拖拉机 单元。
   * unit = { len:连续点数个数, copies:每点张数, start:最小 order, cards, group }
   */
  function decompose(cards, ctx) {
    var map = {};
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      var g = groupOf(ctx, c);
      var key = isJoker(c) ? 'J' + rankOf(c) : 'S' + suitOf(c);
      var o = orderOf(ctx, c);
      var k = g + '|' + key + '|' + o;
      if (!map[k]) map[k] = { group: g, key: key, order: o, cards: [] };
      map[k].cards.push(c);
    }
    var units = [];
    for (var k2 in map) {
      if (!map.hasOwnProperty(k2)) continue;
      var b = map[k2];
      units.push({
        len: 1, copies: b.cards.length, start: b.order, last: b.order,
        key: b.key, group: b.group, cards: b.cards
      });
    }
    units.sort(function (a, b) {
      if (a.group !== b.group) return a.group - b.group;
      if (a.key !== b.key) return a.key < b.key ? -1 : 1;
      return a.start - b.start;
    });
    var out = [];
    for (var j = 0; j < units.length; j++) {
      var u = units[j];
      var prev = out[out.length - 1];
      if (prev && prev.group === u.group && prev.key === u.key &&
          prev.copies === u.copies && u.copies >= 2 &&
          u.start === prev.last + 10) {
        prev.len += 1;
        prev.last = u.start;
        prev.cards = prev.cards.concat(u.cards);
      } else {
        out.push({
          len: u.len, copies: u.copies, start: u.start, last: u.last,
          key: u.key, group: u.group, cards: u.cards.slice()
        });
      }
    }
    return out;
  }

  function pairCount(units) {
    var n = 0;
    for (var i = 0; i < units.length; i++) {
      if (units[i].copies >= 2) n += units[i].len;
    }
    return n;
  }

  function unitTop(u) { return u.start + (u.len - 1) * 10; }

  function unitName(u) {
    if (u.len === 1) {
      if (u.copies >= 4) return '四条';
      if (u.copies === 3) return '三条';
      return u.copies === 2 ? '对子' : '单张';
    }
    if (u.copies >= 4) return u.len + ' 连四条';
    if (u.copies === 3) return u.len + ' 连三条（推土机）';
    return u.len + ' 连对（拖拉机）';
  }

  // 结构向量：[四张牌数, 三张牌数, 对子牌数]，用于跟牌时比较“能跟出的最强结构”
  function structuralVector(units) {
    var v = [0, 0, 0];
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      if (u.copies >= 4) v[0] += u.cards.length;
      else if (u.copies === 3) v[1] += u.cards.length;
      else if (u.copies === 2) v[2] += u.cards.length;
    }
    return v;
  }

  // ---------------------------------------------------------------- 出牌校验
  /**
   * 首家出牌：同门内的单张/对子/拖拉机，或“甩牌”。
   * 甩牌要求每个组件都大于其余三家可能持有的同型牌，否则整手不合法。
   * unseen 是除自己外所有人手里的牌（含底牌），只用于判断“是否还存在更大的牌”，
   * 不会向玩家暴露具体是哪一家、哪一张。
   */
  function validateLead(cards, ctx, unseen) {
    if (!cards || !cards.length) return { ok: false, msg: '请选择要出的牌' };
    var g = groupOf(ctx, cards[0]);
    for (var i = 1; i < cards.length; i++) {
      if (groupOf(ctx, cards[i]) !== g) {
        return { ok: false, msg: '首家出牌必须是同一门花色' };
      }
    }
    var units = decompose(cards, ctx);
    if (units.length === 1) {
      return { ok: true, lead: { cards: cards.slice(), group: g, units: units } };
    }
    // 甩主牌：要么每一段都是最大的（全大），要么其他家手里一张主牌都没有
    if (g === 4 && unseen && unseen.length) {
      var trumpHands = Array.isArray(unseen[0]) ? unseen : [unseen];
      var othersTrump = false;
      for (var a = 0; a < trumpHands.length && !othersTrump; a++) {
        for (var b = 0; b < trumpHands[a].length; b++) {
          if (groupOf(ctx, trumpHands[a][b]) === 4) { othersTrump = true; break; }
        }
      }
      var okTrump = { ok: true, lead: { cards: cards.slice(), group: g, units: units } };
      if (!othersTrump) return okTrump; // 别人都没主，随便甩
      for (var ui = 0; ui < units.length; ui++) {
        var u = units[ui];
        for (var hh = 0; hh < trumpHands.length; hh++) {
          var theirsT = decompose(trumpHands[hh].filter(function (c) {
            return groupOf(ctx, c) === 4;
          }), ctx);
          for (var tt = 0; tt < theirsT.length; tt++) {
            var o2 = theirsT[tt];
            if (o2.copies === u.copies && o2.len >= u.len && unitTop(o2) > unitTop(u)) {
              return {
                ok: false,
                msg: '甩主牌不成立：其他家还有更大的' + unitName(u) +
                     '，主牌必须全大才能甩'
              };
            }
          }
        }
      }
      return okTrump;
    }
    // 甩牌只看决定这一墩归属的那一段（最大的结构），与收墩时的判定保持一致：
    // 其余小牌即使被更大的单牌盖过，也改变不了这一墩的归属，不该因此否决整手
    var key = leadKeyUnit(units);
    if (unseen && unseen.length) {
      var hands = Array.isArray(unseen[0]) ? unseen : [unseen];
      for (var h = 0; h < hands.length; h++) {
        var sameSuit = hands[h].filter(function (c) {
          return groupOf(ctx, c) === g;
        });
        var theirs = decompose(sameSuit, ctx);
        // 只有这一门完全没有牌的人才能用主牌毙；还有该门牌的人必须先跟该门
        var canRuff = g !== 4 && sameSuit.length === 0;
        var trumps = canRuff ? decompose(hands[h].filter(function (c) {
          return groupOf(ctx, c) === 4;
        }), ctx) : [];
        for (var t = 0; t < theirs.length; t++) {
          var o = theirs[t];
          if (o.copies === key.copies && o.len >= key.len && o.start > key.start) {
            return {
              ok: false,
              msg: '甩牌不成立：其他家还有更大的' + unitName(key) +
                   '，请改出这门最小的牌'
            };
          }
        }
        // 副牌甩牌还可能被主牌毙掉，主牌结构对得上就不保险
        for (var r = 0; r < trumps.length; r++) {
          if (trumps[r].copies === key.copies && trumps[r].len >= key.len) {
            return {
              ok: false,
              msg: '甩牌不成立：其他家可能用主牌毙掉' + unitName(key) +
                   '，请改出这门最小的牌'
            };
          }
        }
      }
    }
    return { ok: true, lead: { cards: cards.slice(), group: g, units: units } };
  }

  function leadKeyUnit(units) {
    var best = null;
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      if (!best) { best = u; continue; }
      var us = u.len * u.copies, bs = best.len * best.copies;
      if (us > bs || (us === bs && (u.len > best.len || (u.len === best.len && u.start > best.start)))) {
        best = u;
      }
    }
    return best;
  }

  function leadChainUnit(units) {
    var best = null;
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      if (u.copies < 2 || u.len < 2) continue;
      if (!best || u.len > best.len || (u.len === best.len && u.copies > best.copies)) best = u;
    }
    return best;
  }

  // 在一手牌的分解结果里找能“对得上”首家大牌型的单元（张数结构不弱于首家）
  function findMatchUnit(units, target) {
    if (!target) return null;
    var best = null;
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      if (u.copies !== target.copies || u.len < target.len) continue;
      if (!best || unitTop(u) > unitTop(best)) best = u;
    }
    return best;
  }

  function countCards(arr) {
    var m = {};
    for (var i = 0; i < arr.length; i++) m[arr[i]] = (m[arr[i]] || 0) + 1;
    return m;
  }
  function containsAll(hand, cards) {
    var h = countCards(hand), need = countCards(cards);
    for (var k in need) {
      if (!h[k] || h[k] < need[k]) return false;
    }
    return true;
  }
  function removeCards(hand, cards) {
    var out = hand.slice();
    for (var i = 0; i < cards.length; i++) {
      var idx = out.indexOf(cards[i]);
      if (idx >= 0) out.splice(idx, 1);
    }
    return out;
  }

  /**
   * 跟牌校验：
   *   1. 张数必须一致；
   *   2. 同门牌足够时，必须全部出同门，并且按首家的结构跟足
   *      （四条跟四条、三条跟三条、推土机跟同长推土机，其次对子，最后单张）；
   *   3. 同门牌不足时，必须先出完该门所有牌，其余可垫任意牌。
   */
  function validateFollow(hand, selection, lead, ctx) {
    var n = lead.cards.length;
    if (selection.length !== n) return { ok: false, msg: '必须出 ' + n + ' 张' };
    if (!containsAll(hand, selection)) return { ok: false, msg: 'selection 不在手牌中' };

    var lg = lead.group;
    var same = hand.filter(function (c) { return groupOf(ctx, c) === lg; });
    var selSame = selection.filter(function (c) { return groupOf(ctx, c) === lg; });

    if (same.length >= n) {
      if (selSame.length !== n) return { ok: false, msg: '必须跟同门花色' };

      // 有同型链（拖拉机/推土机/连四条）时必须整段跟出
      var chain = leadChainUnit(lead.units);
      if (chain) {
        var hasChain = decompose(same, ctx).some(function (u) {
          return u.copies >= chain.copies && u.len >= chain.len;
        });
        if (hasChain) {
          var playedChain = decompose(selSame, ctx).some(function (u) {
            return u.copies >= chain.copies && u.len >= chain.len;
          });
          if (!playedChain) return { ok: false, msg: '首家有' + unitName(chain) + '，必须跟出同型链' };
        }
      }

      // 结构数量不得低于按规则能跟出的最强结构（仅当首家带对子以上牌型时）
      if (leadMaxCopies(lead.units) >= 2) {
        var needPlan = buildFollowPlan(same, lead, ctx, false);
        if (needPlan.length === n) {
          var req = structuralVector(decompose(needPlan, ctx));
          var got = structuralVector(decompose(selSame, ctx));
          var names = ['四条', '三条', '对子'];
          var unitSize = [4, 3, 2];
          for (var i = 0; i < 3; i++) {
            if (got[i] < req[i]) {
              return {
                ok: false,
                msg: '首家有' + names[i] + '，必须先跟' + names[i] +
                     '（还差 ' + Math.ceil((req[i] - got[i]) / unitSize[i]) + ' 组）'
              };
            }
          }
        }
      }
      return { ok: true, msg: '跟牌' };
    }

    // 同门不足：必须先把该门出完
    var needMap = countCards(same);
    var selMap = countCards(selection);
    for (var k in needMap) {
      if ((selMap[k] || 0) < needMap[k]) {
        return { ok: false, msg: '必须先出完该门花色（还差 ' + (needMap[k] - (selMap[k] || 0)) + ' 张）' };
      }
    }
    return { ok: true, msg: '垫牌' };
  }

  /**
   * 一墩胜负：
   *   * 只有同门，或用主牌毙，才有资格比大小；
   *   * 必须拿出与首家最大牌型相同结构的牌（对子压对子、拖拉机压拖拉机），
   *     两张单牌压不住对子，两组普通对子也压不住拖拉机；
   *   * 同结构比最大 order；完全相同则先出者为大。
   */
  function trickBest(plays, lead, ctx) {
    var best = null;
    var keyUnit = leadKeyUnit(lead.units);
    for (var i = 0; i < plays.length; i++) {
      var p = plays[i];
      if (!p.cards || !p.cards.length) continue;
      var g0 = groupOf(ctx, p.cards[0]);
      var uniform = p.cards.every(function (c) { return groupOf(ctx, c) === g0; });
      if (!uniform) continue;

      var cat;
      if (g0 === lead.group) cat = 1;
      else if (g0 === 4 && lead.group !== 4) cat = 2;
      else continue;

      var match = findMatchUnit(decompose(p.cards, ctx), keyUnit);
      if (!match) continue; // 结构不如首家，只能算垫牌

      var key = [cat, unitTop(match), match.copies];
      if (!best || key[0] > best.key[0] ||
          (key[0] === best.key[0] && key[1] > best.key[1]) ||
          (key[0] === best.key[0] && key[1] === best.key[1] && key[2] > best.key[2])) {
        best = { seat: p.seat, key: key, unit: match };
      }
    }
    return best;
  }

  function trickWinner(plays, lead, ctx) {
    var best = trickBest(plays, lead, ctx);
    return best ? best.seat : (plays.length ? plays[0].seat : null);
  }

  // ---------------------------------------------------------------- 升级结算
  function settle(levelA, levelB, bankerTeam, defenderPoints, decks, rule) {
    var m = decks, line = 40 * m;
    var levels = [levelA, levelB];
    var delta, winner;
    if (rule === 1) {
      if (defenderPoints === 0) { delta = 3; winner = bankerTeam; }
      else if (defenderPoints < 20 * m) { delta = 2; winner = bankerTeam; }
      else if (defenderPoints < line) { delta = 1; winner = bankerTeam; }
      else { delta = Math.floor((defenderPoints - line) / (10 * m)); winner = 1 - bankerTeam; }
    } else {
      if (defenderPoints < line) {
        delta = Math.floor((line - defenderPoints) / (10 * m)) + 1;
        winner = bankerTeam;
      } else {
        delta = Math.floor((defenderPoints - line) / (10 * m));
        winner = 1 - bankerTeam;
      }
    }
    levels[winner] += delta;
    return {
      defenderPoints: defenderPoints,
      bankerTeam: bankerTeam,
      levels: levels,
      winnerTeam: winner,
      delta: delta,
      reset: levels[winner] > 14
    };
  }

  // ---------------------------------------------------------------- 电脑决策
  function pairBuckets(cards, ctx, high) {
    var map = {};
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      var o = orderOf(ctx, c);
      var base = isJoker(c) ? 'J' + rankOf(c) : 'S' + suitOf(c);
      var k = base + '|' + o;
      if (!map[k]) map[k] = { key: k, base: base, order: o, cards: [] };
      map[k].cards.push(c);
    }
    var list = [];
    for (var k2 in map) {
      if (map.hasOwnProperty(k2)) list.push(map[k2]);
    }
    list.sort(function (a, b) { return high ? b.order - a.order : a.order - b.order; });
    return list;
  }

  // 从同门牌中挑 n 张，尽量凑出 need 个对子
  function buildFromSuit(S, n, need, ctx, high) {
    var buckets = pairBuckets(S, ctx, high);
    var chosen = [];
    var pairsLeft = need;
    var i, j;
    for (i = 0; i < buckets.length && pairsLeft > 0; i++) {
      if (buckets[i].cards.length >= 2) {
        chosen.push(buckets[i].cards[0], buckets[i].cards[1]);
        buckets[i].cards.splice(0, 2);
        pairsLeft--;
      }
    }
    // 补齐剩余张数时先用真正不成对的散牌，避免为了凑一张就把对子拆开
    for (i = 0; i < buckets.length && chosen.length < n; i++) {
      if (buckets[i].cards.length !== 1) continue;
      chosen.push(buckets[i].cards[0]);
      buckets[i].cards.splice(0, 1);
    }
    for (i = 0; i < buckets.length && chosen.length < n; i++) {
      for (j = 0; j < buckets[i].cards.length && chosen.length < n; j++) {
        chosen.push(buckets[i].cards[j]);
      }
    }
    return chosen;
  }

  function beatsCurrent(game, cards) {
    if (!game.trick.length) return true;
    var probe = game.trick.concat([{ seat: -1, cards: cards }]);
    return trickWinner(probe, game.lead, game.ctx) === -1;
  }

  function leadMaxCopies(units) {
    var m = 1;
    for (var i = 0; i < units.length; i++) if (units[i].copies > m) m = units[i].copies;
    return m;
  }

  // 在按点数分好的桶里找一段连续的、每点至少 copies 张的链
  function findChainRun(buckets, copies, len, high) {
    var byKey = {};
    for (var i = 0; i < buckets.length; i++) {
      var b = buckets[i];
      (byKey[b.base] = byKey[b.base] || []).push(b);
    }
    var best = null;
    for (var k in byKey) {
      if (!byKey.hasOwnProperty(k)) continue;
      var arr = byKey[k].slice().sort(function (a, b) { return a.order - b.order; });
      var run = [];
      for (var j = 0; j < arr.length; j++) {
        if (arr[j].cards.length < copies) { run = []; continue; }
        if (run.length && arr[j].order !== run[run.length - 1].order + 10) run = [];
        run.push(arr[j]);
        if (run.length >= len) {
          var cand = run.slice(run.length - len);
          if (!best || (high ? cand[0].order > best[0].order : cand[0].order < best[0].order)) {
            best = cand;
          }
        }
      }
    }
    return best;
  }

  /**
   * 按规则装配一手合法跟牌：
   *   先整段跟同型链，再按“四条 > 三条 > 对子 > 单张”的顺序补齐。
   * high 为 true 时优先用大牌，false 时优先用最小的牌。
   */
  function buildFollowPlan(S, lead, ctx, high) {
    var n = lead.cards.length;
    var buckets = pairBuckets(S, ctx, high);
    var chosen = [];
    var remain = n;

    function takeFrom(b, k) {
      k = Math.min(k, b.cards.length, remain);
      for (var i = 0; i < k; i++) chosen.push(b.cards.shift());
      remain -= k;
    }

    // 1) 首家出拖拉机/推土机/连四条时，先跟同型链
    var chain = leadChainUnit(lead.units);
    if (chain && chain.len >= 2) {
      var run = findChainRun(buckets, chain.copies, chain.len, high);
      if (run) {
        for (var q = 0; q < run.length; q++) takeFrom(run[q], chain.copies);
      }
    }

    // 2) 按首家最强的结构决定补齐优先级
    var maxCopies = leadMaxCopies(lead.units);
    var prio = maxCopies >= 4 ? [4, 3, 2, 1] :
               maxCopies === 3 ? [3, 2, 1] :
               maxCopies === 2 ? [2, 1] : [1];
    for (var p = 0; p < prio.length && remain > 0; p++) {
      var level = prio[p];
      // 用单张补齐时先挑真正不成对的散牌，最后才考虑拆对子/三条
      if (level === 1) {
        for (var li = 0; li < buckets.length && remain > 0; li++) {
          if (buckets[li].cards.length !== 1) continue;
          takeFrom(buckets[li], 1);
        }
      }
      for (var bi = 0; bi < buckets.length && remain > 0; bi++) {
        if (buckets[bi].cards.length >= level) takeFrom(buckets[bi], level);
      }
    }

    // 3) 同门牌凑不出结构时，用剩下的牌补足张数
    for (var ri = 0; ri < buckets.length && remain > 0; ri++) {
      takeFrom(buckets[ri], buckets[ri].cards.length);
    }
    return chosen.slice(0, n);
  }

  // 兜底跟牌：保证先出完同门，并按结构整段跟出
  function fallbackFollow(hand, lead, ctx, high) {
    var n = lead.cards.length, lg = lead.group;
    var S = hand.filter(function (c) { return groupOf(ctx, c) === lg; });

    if (S.length < n) {
      var rest = hand.filter(function (c) { return groupOf(ctx, c) !== lg; })
        .sort(function (a, b) {
          return high ? orderOf(ctx, b) - orderOf(ctx, a) : orderOf(ctx, a) - orderOf(ctx, b);
        });
      return S.concat(rest.slice(0, n - S.length));
    }
    return buildFollowPlan(S, lead, ctx, high);
  }

  function currentTrickPoints(game) {
    var pts = 0;
    for (var i = 0; i < game.trick.length; i++) {
      for (var j = 0; j < game.trick[i].cards.length; j++) pts += pointOf(game.trick[i].cards[j]);
    }
    return pts;
  }

  // ---------------------------------------------------------------- 电脑决策辅助
  function partnerOf(seat) { return (seat + 2) % 4; }
  function sameTeam(a, b) { return a >= 0 && b >= 0 && (a % 2) === (b % 2); }

  function countTrumps(cards, ctx) {
    var n = 0;
    for (var i = 0; i < cards.length; i++) if (groupOf(ctx, cards[i]) === 4) n++;
    return n;
  }

  function currentWinner(game) {
    if (!game.trick.length) return -1;
    return trickWinner(game.trick, game.lead, game.ctx);
  }

  // 当前最大牌是不是主牌毙出来的（前面已经有人毙牌）
  function currentWinnerRuffed(game) {
    var w = currentWinner(game);
    if (w < 0) return false;
    for (var i = 0; i < game.trick.length; i++) {
      if (game.trick[i].seat !== w) continue;
      var cs = game.trick[i].cards;
      if (!cs || !cs.length) return false;
      for (var j = 0; j < cs.length; j++) {
        if (groupOf(game.ctx, cs[j]) !== 4) return false;
      }
      return true;
    }
    return false;
  }

  // 当前这墩的赢家信息（含赢牌单元），用于判断队友这一手是否已经必大
  function currentWinBest(game) {
    if (!game.trick.length || !game.lead) return null;
    return trickBest(game.trick, game.lead, game.ctx);
  }

  // 本墩出完是否所有人手牌清空（最后一墩）
  function finalTrick(game, seat, outCount) {
    return game.hands[seat].length === outCount;
  }

  function anyOpponentVoid(game, seat, group) {
    for (var s = 0; s < 4; s++) {
      if (s === seat || sameTeam(s, seat)) continue;
      if (game.voids && game.voids[s] && game.voids[s][group]) return true;
    }
    return false;
  }

  function anyPartnerVoid(game, seat, group) {
    var p = partnerOf(seat);
    return !!(game.voids && game.voids[p] && game.voids[p][group]);
  }

  function opponentTrumps(game, seat) {
    var n = 0;
    for (var s = 0; s < 4; s++) if (!sameTeam(s, seat) && s !== seat) n += game.trumpLeft[s] || 0;
    return n;
  }

  // 这一墩里还会在我之后出牌的座位
  function laterSeats(game, seat) {
    var out = [], left = 3 - game.trick.length;
    for (var k = 1; k <= left; k++) out.push((seat + k) % 4);
    return out;
  }

  // 某门牌在自己手牌与已出牌之外还剩多少张
  function unseenInGroup(game, seat, group) {
    var total = 0;
    for (var id = 0; id < 54; id++) {
      if (groupOf(game.ctx, id) !== group) continue;
      total += remainingCount(game, seat, id);
    }
    return total;
  }

  // 后面还没出牌的对手反毙这一手的概率估算
  function overRuffRisk(game, seat, sel) {
    var ctx = game.ctx, lead = game.lead;
    if (!lead || lead.group === 4) return 0;
    var later = laterSeats(game, seat);
    if (!later.length) return 0;

    var unseenTotal = 0;
    for (var s = 0; s < 4; s++) if (s !== seat) unseenTotal += (game.hands[s] || []).length;
    if (unseenTotal <= 0) return 0;

    var suitLeft = unseenInGroup(game, seat, lead.group);
    var unseenTrumps = unseenInGroup(game, seat, 4);
    if (unseenTrumps <= 0) return 0;

    var top = 0;
    for (var i = 0; i < sel.length; i++) top = Math.max(top, orderOf(ctx, sel[i]));
    var higherLeft = 0;
    for (var id = 0; id < 54; id++) {
      if (groupOf(ctx, id) !== 4 || orderOf(ctx, id) <= top) continue;
      higherLeft += remainingCount(game, seat, id);
    }
    if (higherLeft <= 0) return 0;

    // 多张毙牌需要对手有同结构的更大主牌，按结构折算
    var shape = 1, cnt = {};
    for (var q = 0; q < sel.length; q++) {
      var o = orderOf(ctx, sel[q]);
      cnt[o] = (cnt[o] || 0) + 1;
      if (cnt[o] > shape) shape = cnt[o];
    }
    var qHigh = Math.min(1, higherLeft / unseenTrumps);

    var risk = 1;
    for (var k = 0; k < later.length; k++) {
      var t = later[k];
      if (sameTeam(t, seat)) continue;
      var h = (game.hands[t] || []).length;
      var trumps = game.trumpLeft[t] || 0;
      if (h <= 0 || trumps <= 0) continue;
      // 缺门概率：已经亮过缺门则是确定的，否则按这门牌在暗牌中的占比估算
      var pVoid = (game.voids && game.voids[t] && game.voids[t][lead.group]) ? 1 :
        Math.pow(1 - Math.min(1, suitLeft / unseenTotal), h);
      var groups = Math.max(1, Math.floor(trumps / shape));
      var pHigh = 1 - Math.pow(1 - qHigh, groups);
      risk *= (1 - pVoid * pHigh);
    }
    return 1 - risk;
  }

  // 毙牌用掉主牌的代价（折算成分值）：牌越大越贵，拆主牌对子/拖拉机额外记代价
  function ruffCost(game, seat, sel) {
    var ctx = game.ctx, hand = game.hands[seat];
    var cost = 0, left = countCards(sel);
    for (var i = 0; i < sel.length; i++) {
      cost += 1 + Math.max(0, orderOf(ctx, sel[i]) - 20) / 450;
    }
    var units = decompose(hand, ctx);
    for (var u = 0; u < units.length; u++) {
      var unit = units[u];
      if (unit.group !== 4 || unit.cards.length < 2) continue;
      var got = 0;
      for (var j = 0; j < unit.cards.length; j++) {
        if (left[unit.cards[j]]) { left[unit.cards[j]]--; got++; }
      }
      if (got > 0 && got < unit.cards.length) cost += 3.0;
    }
    return cost;
  }

  // 后面还没出牌、且已经确定缺门的对手（肯定能毙这一门）
  function knownRuffers(game, seat) {
    var out = [];
    var lead = game.lead;
    if (!lead || lead.group === 4) return out;
    var later = laterSeats(game, seat);
    for (var i = 0; i < later.length; i++) {
      var t = later[i];
      if (sameTeam(t, seat)) continue;
      if (game.voids && game.voids[t] && game.voids[t][lead.group] &&
          (game.trumpLeft[t] || 0) > 0) out.push(t);
    }
    return out;
  }

  // 队友是否可能在后面毙掉这一墩；以及队友毙完之后能不能真的比当前这手更大。
  // 只认已经确定的信息：队友对该门缺门且有足够主牌。
  // over 表示「队友这一毙不一定能赢」，此时不能把分牌垫过去。
  function partnerRuffInfo(game, seat, lg) {
    var res = { ruff: false, over: false };
    var lead = game.lead;
    if (!lead || lg === 4) return res;
    var p = partnerOf(seat);
    var later = laterSeats(game, seat);
    if (later.indexOf(p) < 0) return res;
    var n = lead.cards.length;
    if (!(game.voids && game.voids[p] && game.voids[p][lg])) return res;
    var trumps = game.trumpLeft[p] || 0;
    if (trumps < n) return res;
    res.ruff = true;

    // 1) 已经有人用主牌毙过：队友得凑出更大的同结构主牌，基本抢不过
    var winner = currentWinner(game);
    if (winner >= 0) {
      for (var i = 0; i < game.trick.length; i++) {
        var entry = game.trick[i];
        if (entry.seat !== winner || !entry.cards.length) continue;
        var allTrump = true;
        for (var j = 0; j < entry.cards.length; j++) {
          if (groupOf(game.ctx, entry.cards[j]) !== 4) { allTrump = false; break; }
        }
        if (allTrump) { res.over = true; return res; }
      }
    }

    // 2) 首出是拖拉机/三条/四条时，队友必须凑出同结构的主牌；
    //    主牌只有刚够张数的量时按「不一定比他更大」处理
    var chain = leadChainUnit(lead.units);
    var maxCopies = 1;
    for (var ui = 0; ui < lead.units.length; ui++) {
      if (lead.units[ui].copies > maxCopies) maxCopies = lead.units[ui].copies;
    }
    if (chain && chain.len >= 2 && trumps < n + 2) res.over = true;
    else if (!chain && maxCopies >= 3 && trumps < n + 1) res.over = true;
    return res;
  }

  // 超几何分布：池子里 pool 张、其中 cnt 张属于某点数，抽 draws 张至少拿到 need 张的概率。
  // 判定结构必须严格相等时用它，避免把"任意几张主牌"都当成能毙对子/三条。
  function logChoose(n, k) {
    if (k < 0 || k > n) return -Infinity;
    var r = 0;
    for (var i = 1; i <= k; i++) r += Math.log(n - k + i) - Math.log(i);
    return r;
  }

  function hyperAtLeast(cnt, pool, draws, need) {
    var n = Math.min(draws, pool);
    if (n <= 0 || cnt <= 0 || need <= 0) return 0;
    var base = logChoose(pool, n);
    if (base === -Infinity) return 0;
    var p = 0, hi = Math.min(cnt, n);
    for (var i = need; i <= hi; i++) {
      var lp = logChoose(cnt, i) + logChoose(pool - cnt, n - i) - base;
      if (lp > -Infinity) p += Math.exp(lp);
    }
    return Math.min(1, p);
  }

  // 缺门玩家用主牌毙牌的概率。结构必须严格相等：
  // 对子要主牌对子、三条要主牌三条，不能拿任意几张主牌算。
  function sameKindTrumpChance(game, seat, needCopies, trumps) {
    var ctx = game.ctx;
    var pool = unseenInGroup(game, seat, 4);
    if (pool <= 0 || trumps < needCopies) return 0;
    var pBest = 0;
    for (var id = 0; id < 54; id++) {
      if (groupOf(ctx, id) !== 4) continue;
      var cnt = remainingCount(game, seat, id);
      if (cnt < needCopies) continue;
      var p = hyperAtLeast(cnt, pool, trumps, needCopies);
      if (p > pBest) pBest = p;
    }
    if (pBest <= 0) return 0;
    var groups = Math.max(1, Math.floor(trumps / needCopies));
    return Math.min(1, 1 - Math.pow(1 - pBest, groups));
  }

  // 后面某一家压过当前最大牌的概率估计：按暗牌里的同型大牌与主牌分布折算
  function beatChance(game, seat, t, best) {
    var ctx = game.ctx, lead = game.lead;
    var h = (game.hands[t] || []).length;
    if (!best || h <= 0) return 0;
    var unit = best.unit, top = unitTop(unit);
    var shape = Math.max(1, Math.min(unit.copies, h));
    var unseenTotal = 0;
    for (var s = 0; s < 4; s++) if (s !== seat) unseenTotal += (game.hands[s] || []).length;
    if (unseenTotal <= 0) return 0;

    // 主牌墩：只能靠更大的同型主牌压
    if (lead.group === 4) {
      var trumpPool = unseenInGroup(game, seat, 4);
      var trumpsT = game.trumpLeft[t] || 0;
      if (trumpPool <= 0 || trumpsT <= 0) return 0;
      var pBestT = 0;
      for (var id = 0; id < 54; id++) {
        if (groupOf(ctx, id) !== 4 || orderOf(ctx, id) <= top) continue;
        var cntH = remainingCount(game, seat, id);
        if (cntH < shape) continue;
        var pH = hyperAtLeast(cntH, trumpPool, trumpsT, shape);
        if (pH > pBestT) pBestT = pH;
      }
      if (pBestT <= 0) return 0;
      // 单张时每张主牌都是机会；对子/三条必须凑同点，同一家凑出多组极罕见
      var groupsT = shape === 1 ? Math.max(1, trumpsT) : Math.max(1, Math.floor(trumpsT / shape));
      return Math.min(1, 1 - Math.pow(1 - pBestT, groupsT));
    }

    var p = 0;
    var sameLeft = unseenInGroup(game, seat, lead.group);
    var voidKnown = !!(game.voids && game.voids[t] && game.voids[t][lead.group]);
    var pVoid = voidKnown ? 1 :
      Math.pow(1 - Math.min(1, sameLeft / unseenTotal), h);

    // 还有这一门的人：必须用同门更大的同型牌压。对子/三条同样要凑点数
    if (!voidKnown && sameLeft > 0) {
      var draws = Math.max(1, Math.floor(h * sameLeft / unseenTotal));
      var pSame = 0;
      for (var id2 = 0; id2 < 54; id2++) {
        if (groupOf(ctx, id2) !== lead.group || orderOf(ctx, id2) <= top) continue;
        var cntS = remainingCount(game, seat, id2);
        if (cntS < shape) continue;
        var pS = hyperAtLeast(cntS, sameLeft, draws, shape);
        if (pS > pSame) pSame = pS;
      }
      if (shape === 1) {
        var higherSame = 0;
        for (var id3 = 0; id3 < 54; id3++) {
          if (groupOf(ctx, id3) !== lead.group || orderOf(ctx, id3) <= top) continue;
          higherSame += remainingCount(game, seat, id3);
        }
        pSame = 1 - Math.pow(1 - Math.min(1, higherSame / sameLeft), draws);
      }
      p += (1 - pVoid) * pSame;
    }
    // 缺门的人：单张任意主牌都能毙；对子/三条必须凑出主牌对子/主牌三条
    var trumps = game.trumpLeft[t] || 0;
    if (trumps > 0) {
      var pRuff;
      if (unit.len === 1 && shape >= 2) {
        pRuff = sameKindTrumpChance(game, seat, shape, trumps);
      } else {
        pRuff = 1 - Math.pow(1 - Math.min(1, trumps / h), shape);
      }
      p += pVoid * pRuff;
    }
    return Math.min(1, p);
  }

  // 我方赢下本墩的概率：自己这一手算已出，再折算后面几家的反压机会
  function teamWinChance(game, seat, sel) {
    var ctx = game.ctx, lead = game.lead;
    if (!lead) return 0;
    var probe = game.trick.concat([{ seat: seat, cards: sel }]);
    var best = trickBest(probe, lead, ctx);
    if (!best) return 0;
    var later = laterSeats(game, seat);
    var ours = sameTeam(best.seat, seat);
    if (!later.length) return ours ? 1 : 0;

    if (ours) {
      // 后面只剩队友时不影响；只剩对手时逐个折算反压概率
      var keep = 1;
      for (var i = 0; i < later.length; i++) {
        var t = later[i];
        if (sameTeam(t, seat)) continue;
        keep *= (1 - beatChance(game, seat, t, best));
      }
      return keep;
    }
    // 当前不是我们赢：只有还没出牌的队友可能翻回来
    var p = 0;
    for (var j = 0; j < later.length; j++) {
      var m = later[j];
      if (!sameTeam(m, seat)) continue;
      var pc = beatChance(game, seat, m, best);
      // 队友后面还有对手时可能被反压，折算一下；队友是末位就不用折
      var oppAfter = 0;
      for (var k = j + 1; k < later.length; k++) {
        if (!sameTeam(later[k], seat)) oppAfter++;
      }
      if (oppAfter > 0) pc *= 0.75;
      p = Math.max(p, pc);
    }
    return Math.min(1, p);
  }

  // 本墩已经落下的分按队伍统计：队友垫进来的分，只有我方赢墩才拿得到
  function trickSidePoints(game, seat) {
    var mine = 0, theirs = 0;
    for (var i = 0; i < game.trick.length; i++) {
      var p = game.trick[i];
      for (var j = 0; j < p.cards.length; j++) {
        var v = pointOf(p.cards[j]);
        if (sameTeam(p.seat, seat)) mine += v; else theirs += v;
      }
    }
    return { mine: mine, theirs: theirs };
  }

  // 毙牌决策：墩面分数越高越愿意毙；后手反毙风险高时改用更大的主牌
  function chooseRuff(game, seat, wins, pts, isFinal, lastToPlay) {
    var pot = pts;
    if (isFinal) {
      // 末墩赢家拿底牌，收益远大于普通墩面分
      pot += (game.bottomPoints || 0) * (game.decks || 1) *
        (game.lead ? game.lead.cards.length : 1);
    }
    // 队友已经垫了分（这部分分只有我方赢墩才归我方），对手手里也有分时拦下来更值
    var side = trickSidePoints(game, seat);
    var winner = currentWinner(game);
    var blocking = winner != null && !sameTeam(winner, seat);
    var endgame = game.hands[seat].length <=
      (game.lead ? game.lead.cards.length : 1) + 4;
    var denyVal = blocking ? (endgame ? 3.2 : 1.6) + (side.theirs > 0 ? 0.8 : 0) : 0;
    var rescue = side.mine * 0.4; // 队友跑分的额外价值

    // 前面已经有人用主牌毙过：要么用更大的主牌压过去，要么干脆不毙、跟无用牌。
    // 这种局面抢出牌权的意义很小，只看墩面分成不成正比，避免烧掉大主去反毙一张小主。
    // 能压住由 aiFollow 的 beatsCurrent 保证（严格更大才进 wins）。
    if (currentWinnerRuffed(game)) {
      var gain = 2 * pot + rescue + (side.theirs > 0 ? 1.2 : 0);
      var overBest = null, overVal = -Infinity;
      for (var oi = 0; oi < wins.length; oi++) {
        var osel = wins[oi];
        var orisk = overRuffRisk(game, seat, osel);
        var ocost = ruffCost(game, seat, osel);
        var oval = (1 - orisk) * gain - ocost;
        if (oval > overVal) { overVal = oval; overBest = osel; }
      }
      if (!overBest) return null;
      // 不划算就放弃反毙，改垫无用牌；末墩为了底牌加成仍然要争
      if (!isFinal && overVal <= 0.5) return null;
      return overBest;
    }

    var best = null, bestVal = -Infinity, bestRisk = 0;
    var safest = null, safestRisk = Infinity, safestCost = Infinity;
    for (var i = 0; i < wins.length; i++) {
      var sel = wins[i];
      var risk = overRuffRisk(game, seat, sel);
      var cost = ruffCost(game, seat, sel);
      // 我方赢墩得 pot、放过则对手得 pot，所以按差值算：2×墩面分
      // 再加上掐掉对手先手、救回队友分牌的收益，扣掉被反毙与主牌代价
      var val = 2 * (1 - risk) * pot + (1 - risk) * (denyVal + rescue) - cost;
      if (val > bestVal) { bestVal = val; best = sel; bestRisk = risk; }
      // 同风险时优先用便宜的主牌，避免白拆主牌对子
      if (risk < safestRisk - 1e-9 ||
          (Math.abs(risk - safestRisk) <= 1e-9 && cost < safestCost)) {
        safestRisk = risk; safestCost = cost; safest = sel;
      }
    }
    if (!best) return null;
    // 墩面有分、后手又可能反毙：宁可多花主牌，也先确保把分拿下来
    var threat = knownRuffers(game, seat).length > 0;
    if ((pot >= 5 || isFinal) && (threat || bestRisk > 0.15) &&
        bestRisk - safestRisk > 0.03) {
      return safest;
    }
    // 零分墩要明显划算才毙：刚好抵消主牌代价的毙牌不值，宁可跟小的没用牌
    if (bestVal > 0.5 || isFinal) return best;
    if (lastToPlay && pts >= 5) return best;
    return null;
  }

  // 以某种花色为主时的手牌强度：主牌数量、对子/拖拉机、控制牌、分牌
  function suitPower(hand, ctx) {
    var trumps = [], sideAces = 0, pts = 0;
    for (var i = 0; i < hand.length; i++) {
      var c = hand[i];
      if (groupOf(ctx, c) === 4) trumps.push(c);
      else if (rankOf(c) === 14) sideAces++;
      pts += pointOf(c);
    }
    var units = decompose(trumps, ctx);
    var pairs = 0, tractorLen = 0, top = 0;
    for (var u = 0; u < units.length; u++) {
      if (units[u].copies >= 2) pairs++;
      if (units[u].copies >= 2 && units[u].len >= 2) tractorLen += units[u].len;
    }
    for (var t = 0; t < trumps.length; t++) {
      if (orderOf(ctx, trumps[t]) >= 1400) top++;
    }
    return trumps.length * 1.15 + pairs * 1.4 + tractorLen * 2.2 +
      top * 1.2 + sideAces * 0.9 + pts * 0.15;
  }

  // 亮主/反主决策：比较各花色做主时的手牌强度，并考虑时机与队友
  function aiDeclare(game, seat) {
    if (game.phase !== 'deal') return null;
    var hand = game.hands[seat];
    var opts = [];
    for (var s = 0; s < 4; s++) {
      var o = game.declareOption(seat, s);
      if (!o.ok) continue;
      opts.push({
        suit: s, rank: o.rank, count: o.count,
        score: suitPower(hand, makeContext(s, game.level, game.bankerTeam))
      });
    }
    var on = game.declareOption(seat, 4);
    if (on.ok) {
      opts.push({
        suit: 4, rank: on.rank, count: on.count,
        score: suitPower(hand, makeContext(4, game.level, game.bankerTeam)) - 2.5
      });
    }
    if (!opts.length) return null;

    opts.sort(function (a, b) { return b.score - a.score; });
    var best = opts[0];
    var nearDone = hand.length >= (game.perPlayer || 0) - 4;
    // 没有对子以上的强牌时，等到发牌接近结束再亮，避免被轻易反主
    if (!nearDone && best.rank < 20) return null;
    if (!nearDone && hand.length < 8) return null;

    var cur = game.trumpSuit;
    var hasBid = cur !== null && cur !== undefined && game.bidRank > 0;
    if (hasBid) {
      var curScore = suitPower(hand, makeContext(cur, game.level, game.bankerTeam));
      if (cur === 4) curScore -= 2.5;
      var gain = best.score - curScore;
      var partnerOwns = game.declarer != null && sameTeam(game.declarer, seat);
      // 队友已亮主时不抢，除非自己这手明显强得多且能提升张数级别
      if (partnerOwns) {
        if (gain < 6 || best.rank < game.bidRank + 10) return null;
      } else if (gain < 3.5) {
        return null;
      }
    } else if (!(best.score >= 11 || (nearDone && best.score >= 7.5))) {
      return null;
    }
    return best;
  }

  // 某张牌在其他人手里还剩几张（自己手牌与已出牌之外）
  function remainingCount(game, seat, id) {
    var own = 0, hand = game.hands[seat] || [];
    for (var i = 0; i < hand.length; i++) if (hand[i] === id) own++;
    var seen = (game.seen && game.seen[id]) || 0;
    return Math.max(0, (game.decks || 1) - own - seen);
  }

  // 这一手同门牌是否已经“必大”（外面不存在能压住的同型牌，且没人能毙）
  function isBossUnit(game, seat, unit) {
    var ctx = game.ctx;
    var top = unitTop(unit);
    if (unit.group !== 4 && anyOpponentVoid(game, seat, unit.group) &&
        opponentTrumps(game, seat) > 0) {
      return false;
    }
    if (unit.len === 1) {
      for (var id = 0; id < 54; id++) {
        if (groupOf(ctx, id) !== unit.group) continue;
        if (orderOf(ctx, id) <= top) continue;
        if (remainingCount(game, seat, id) >= unit.copies) return false;
      }
      return true;
    }
    // 拖拉机只可能由普通点数的连续对子组成
    for (var base = 30; base <= 140; base += 10) {
      if (base <= unit.start) continue;
      var ok = true;
      for (var k = 0; k < unit.len && ok; k++) {
        var need = unit.copies, cnt = 0;
        for (var j = 0; j < 54; j++) {
          if (groupOf(ctx, j) === unit.group && orderOf(ctx, j) === base + k * 10) {
            cnt += remainingCount(game, seat, j);
          }
        }
        if (cnt < need) ok = false;
      }
      if (ok) return false;
    }
    return true;
  }

  // 出牌代价：点数越大越贵，主牌、王、分牌更贵
  function cardValue(ctx, c) {
    var v = orderOf(ctx, c) / 100;
    if (isJoker(c)) v += 6;
    else if (groupOf(ctx, c) === 4) v += 1.6;
    v += pointOf(c) * 0.3;
    return v;
  }

  function selectionValue(ctx, cards) {
    var v = 0;
    for (var i = 0; i < cards.length; i++) v += cardValue(ctx, cards[i]);
    return v;
  }

  // 拆对子/拆拖拉机的额外代价：对子、拖拉机是后面抢分和控场的本钱，
  // 代价远高于单张，避免为了跟一手小牌就把结构拆散
  function breakPenalty(hand, cards, ctx) {
    var units = decompose(hand, ctx);
    var left = countCards(cards);
    var pen = 0;
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      if (u.cards.length < 2) continue;
      var got = 0;
      // 多副牌同一点数共用同一 id，必须先扣减已用张数，才能判断是否拆开了结构
      for (var j = 0; j < u.cards.length; j++) {
        if (left[u.cards[j]]) { left[u.cards[j]]--; got++; }
      }
      if (got > 0 && got < u.cards.length) {
        pen += 6 + (u.cards.length - 2) * 2; // 对子 6、三条 8、四条 10、两连对 10
        if (u.len >= 2) pen += 2;            // 拖拉机/推土机再加 2
      }
    }
    return pen;
  }

  function dedupeCandidates(list) {
    var seen = {}, out = [];
    for (var i = 0; i < list.length; i++) {
      var sel = list[i];
      if (!sel || !sel.length) continue;
      var key = sel.slice().sort(function (a, b) { return a - b; }).join(',');
      if (seen[key]) continue;
      seen[key] = 1;
      out.push(sel);
    }
    return out;
  }

  // 同门跟牌候选：从最低到最高，覆盖对子/三条/四条及同型链
  function buildCandidates(S, n, need, ctx) {
    var out = [];
    var buckets = pairBuckets(S, ctx, false);
    out.push(buildFromSuit(S, n, need, ctx, false));
    out.push(buildFromSuit(S, n, need, ctx, true));
    for (var i = 0; i < buckets.length; i++) {
      var b = buckets[i];
      var maxTake = Math.min(4, b.cards.length);
      for (var take = 1; take <= maxTake; take++) {
        var head = b.cards.slice(0, take);
        var others = S.slice();
        for (var k = 0; k < head.length; k++) {
          var pos = others.indexOf(head[k]);
          if (pos >= 0) others.splice(pos, 1);
        }
        var restN = n - head.length;
        var restNeed = Math.max(0, need - (take >= 2 ? 1 : 0));
        var rest = buildFromSuit(others, restN, restNeed, ctx, false);
        if (rest.length === restN) out.push(head.concat(rest));
      }
    }
    return dedupeCandidates(out);
  }

  // 同门不足时的候选：整门 + 毙牌/垫牌搭配
  function fillCandidates(hand, lead, ctx) {
    var n = lead.cards.length, lg = lead.group;
    var S = hand.filter(function (c) { return groupOf(ctx, c) === lg; });
    var rest = removeCards(hand, S);
    var fillN = n - S.length;
    var out = [];
    if (fillN <= 0) return [S];

    function push(fill) {
      if (fill && fill.length === fillN) out.push(S.concat(fill));
    }

    // 完全缺门才能用主牌毙
    var trumps = rest.filter(function (c) { return groupOf(ctx, c) === 4; });
    if (S.length === 0 && trumps.length >= n) {
      var need = Math.min(pairCount(lead.units), pairCount(decompose(trumps, ctx)));
      out = out.concat(buildCandidates(trumps, n, need, ctx));
      out.push(buildFollowPlan(trumps, lead, ctx, false));
      out.push(buildFollowPlan(trumps, lead, ctx, true));
      push(trumps.slice().sort(function (a, b) { return orderOf(ctx, a) - orderOf(ctx, b); }).slice(0, n));
      // 缺门只能垫主牌时，优先垫最便宜的散主：
      // 对子/三条是后面单独赢墩、抢出牌权的本钱，不能为了跟一手零分牌就拆掉
      var tu = decompose(trumps, ctx);
      var looseT = [];
      for (var ti = 0; ti < tu.length; ti++) {
        if (tu[ti].cards.length === 1) looseT.push(tu[ti].cards[0]);
      }
      looseT.sort(function (a, b) { return cardValue(ctx, a) - cardValue(ctx, b); });
      if (looseT.length >= n) push(looseT.slice(0, n));
    }

    // 垫牌：同一门里挑最低的非分牌，便于做出缺门
    var groups = {};
    for (var i = 0; i < rest.length; i++) {
      var c = rest[i];
      if (groupOf(ctx, c) === 4) continue;
      var g = suitOf(c);
      (groups[g] = groups[g] || []).push(c);
    }
    for (var gk in groups) {
      if (!groups.hasOwnProperty(gk)) continue;
      var arr = groups[gk].slice().sort(function (a, b) {
        var pa = pointOf(a) ? 1 : 0, pb = pointOf(b) ? 1 : 0;
        return pa - pb || orderOf(ctx, a) - orderOf(ctx, b);
      });
      if (arr.length >= fillN) push(arr.slice(0, fillN));
    }

    // 优先垫散牌：既不成对、也不成拖拉机的单张，尽量把对子/拖拉机留到后面
    var nonTrump = rest.filter(function (c) { return groupOf(ctx, c) !== 4; });
    var loose = [];
    var lu = decompose(nonTrump, ctx);
    for (var ui = 0; ui < lu.length; ui++) {
      if (lu[ui].cards.length === 1) loose.push(lu[ui].cards[0]);
    }
    loose.sort(function (a, b) {
      var pa = pointOf(a) ? 1 : 0, pb = pointOf(b) ? 1 : 0;
      return pa - pb || orderOf(ctx, a) - orderOf(ctx, b);
    });
    if (loose.length >= fillN) push(loose.slice(0, fillN));

    var trash = nonTrump.slice().sort(function (a, b) {
      var pa = pointOf(a) ? 1 : 0, pb = pointOf(b) ? 1 : 0;
      return pa - pb || orderOf(ctx, a) - orderOf(ctx, b);
    });
    if (trash.length >= fillN) push(trash.slice(0, fillN));

    // 队友已经赢下这一墩时，可以把分牌垫给队友
    var pointy = rest.slice().sort(function (a, b) {
      return pointOf(b) - pointOf(a) || orderOf(ctx, a) - orderOf(ctx, b);
    });
    if (pointy.length >= fillN) push(pointy.slice(0, fillN));

    if (trash.length < fillN) {
      var all = rest.slice().sort(function (a, b) { return orderOf(ctx, a) - orderOf(ctx, b); });
      push(all.slice(0, fillN));
    }
    return dedupeCandidates(out);
  }

  // ---------------------------------------------------------------- 首出
  function aiLead(game, seat) {
    var ctx = game.ctx, hand = game.hands[seat];
    var units = decompose(hand, ctx);
    var myTrumps = countTrumps(hand, ctx);
    var oppTrumps = opponentTrumps(game, seat);
    // 末盘把整手牌一次甩出，等于最后一墩
    var canFinish = hand.length <= 8 && hand.length > 0;
    var best = null, bestScore = -Infinity;

    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      var len = u.cards.length;
      var pts = 0;
      for (var j = 0; j < u.cards.length; j++) pts += pointOf(u.cards[j]);
      var score = 0;
      var boss = isBossUnit(game, seat, u);
      // 拖拉机/三条/四条这类多张结构：先出就逼对手按同结构跟，等于抢到出牌权
      var isChain = u.copies >= 2 && u.len >= 2;
      var isMulti = isChain || u.copies >= 3;

      if (u.group === 4) {
        // 主牌：手牌主牌多、缺主信息明确时才主动调主
        score -= 5;
        score += u.copies * 1.2 + u.len * 0.9 + u.start / 400;
        if (isMulti) score += 1.8 + (isChain ? 0.8 : 0) + (u.copies >= 4 ? 0.5 : 0);
        if (myTrumps >= 6 && u.copies >= 2) score += 2;
        if (myTrumps >= 10) score += 1.5;
        if (game.trickNo >= 6 || oppTrumps <= 2) score += 1.2;
        if (boss) score += isMulti ? 2.4 : 1.5;
        if (pts > 0) score -= 2;
        if (len === hand.length) score += 40;
      } else {
        // 副牌：长门、成对/三条/推土机优先，必大牌先兑现，避开对手缺门
        score += u.len * 1.5 + u.copies * 1.0 - u.start / 400;
        if (u.copies >= 3) score += 0.9;
        // 出牌权比单张大牌更值钱：三条/拖拉机先打出去，对手对子再大也压不住
        if (isMulti) score += 1.8 + (isChain ? 0.8 : 0) + (u.copies >= 4 ? 0.5 : 0);
        if (anyOpponentVoid(game, seat, u.group)) score -= 4;
        if (anyPartnerVoid(game, seat, u.group)) score += 1.2;
        if (boss) {
          score += 2.2 + (u.copies >= 2 ? 0.8 : 0);
          if (isMulti) score += 1.6;
          if (pts > 0) score += 3 + pts * 0.15;
        } else if (pts > 0 && len === 1) {
          score -= 3;
        }
        if (u.start >= 1400) score -= 1.5;
        if (len === 1 && game.trickNo < 4) score += 0.6;
        if (len === hand.length) score += 40;
      }

      if (score > bestScore) { bestScore = score; best = u; }
    }

    if (!best) return [hand[0]];

    // 最后一墩：能把分牌一起甩出就甩出，不行就出最大的一手
    if (canFinish && best.cards.length < hand.length) {
      var sameGroup = hand.filter(function (c) { return groupOf(ctx, c) === groupOf(ctx, hand[0]); });
      if (sameGroup.length === hand.length) {
        var leadTry = sameGroup.slice();
        if (validateLead(leadTry, ctx, game.opponentHands(seat)).ok) return leadTry;
      }
    }
    return best.cards.slice();
  }

  // 首出里最大的拖拉机长度（0 表示不是拖拉机）
  function leadTractorLen(lead) {
    var u = leadChainUnit(lead.units);
    return u && u.len >= 2 ? u.len : 0;
  }

  // 缺门用主牌跟副牌时的第一选择：最便宜的散主。
  // 对子/三条/拖拉机是后面单独赢墩、抢出牌权的本钱，不能为了跟一手就拆掉；
  // 散主不够时返回 null，交给通用逻辑处理。
  function looseTrumpPick(hand, n, ctx) {
    var trumps = [];
    for (var i = 0; i < hand.length; i++) {
      if (groupOf(ctx, hand[i]) === 4) trumps.push(hand[i]);
    }
    if (trumps.length < n) return null;
    var units = decompose(trumps, ctx);
    var singles = [];
    for (var u = 0; u < units.length; u++) {
      if (units[u].cards.length === 1) singles.push(units[u].cards[0]);
    }
    if (singles.length < n) return null;
    singles.sort(function (a, b) { return cardValue(ctx, a) - cardValue(ctx, b); });
    return singles.slice(0, n);
  }

  // 手牌里每张牌所在结构的大小：1=散牌，2=对子，>=3=三条/四条/链。
  // 缺门垫牌时用它把「散牌先走、对子三条留着」落到实处。
  function structSizes(hand, ctx) {
    var size = {};
    var units = decompose(hand, ctx);
    for (var i = 0; i < units.length; i++) {
      var cs = units[i].cards;
      for (var j = 0; j < cs.length; j++) size[cs[j]] = cs.length;
    }
    return size;
  }

  // 跟一手压不住的牌：先保证不送分，再选最小的散牌。
  // 同门够张必须先跟同门，不够张才用其它牌补；补牌时优先不拆对子/三条/拖拉机。
  function noPointFollow(hand, lead, ctx) {
    var n = lead.cards.length, lg = lead.group;
    var S = hand.filter(function (c) { return groupOf(ctx, c) === lg; });
    var rest = hand.filter(function (c) { return groupOf(ctx, c) !== lg; });
    var sizes = structSizes(hand, ctx);
    function structRank(c) { return sizes[c] > 1 ? 1 : 0; }
    function byPoint(a, b) {
      var pa = pointOf(a) ? 1 : 0, pb = pointOf(b) ? 1 : 0;
      return pa - pb || structRank(a) - structRank(b) || orderOf(ctx, a) - orderOf(ctx, b);
    }
    if (S.length >= n) return S.slice().sort(byPoint).slice(0, n);
    var need = n - S.length;
    var fill = rest.slice().sort(function (a, b) {
      var pa = pointOf(a) ? 1 : 0, pb = pointOf(b) ? 1 : 0;
      var ta = groupOf(ctx, a) === 4 ? 1 : 0, tb = groupOf(ctx, b) === 4 ? 1 : 0;
      return pa - pb || structRank(a) - structRank(b) || ta - tb || orderOf(ctx, a) - orderOf(ctx, b);
    });
    return S.concat(fill.slice(0, need));
  }

  // 队友这一墩稳赢时，把分牌尽量垫给队友：
  // 先垫分牌，同等分数下优先不拆对子/三条/拖拉机、再优先非主牌。
  function pointDumpFollow(hand, lead, ctx) {
    var n = lead.cards.length, lg = lead.group;
    var S = hand.filter(function (c) { return groupOf(ctx, c) === lg; });
    var rest = hand.filter(function (c) { return groupOf(ctx, c) !== lg; });
    var sizes = structSizes(hand, ctx);
    function rank(a, b) {
      var pa = pointOf(a), pb = pointOf(b);
      if (pa !== pb) return pb - pa;
      var sa = sizes[a] > 1 ? 1 : 0, sb = sizes[b] > 1 ? 1 : 0;
      if (sa !== sb) return sa - sb;
      var ta = groupOf(ctx, a) === 4 ? 1 : 0, tb = groupOf(ctx, b) === 4 ? 1 : 0;
      if (ta !== tb) return ta - tb;
      return orderOf(ctx, a) - orderOf(ctx, b);
    }
    if (S.length >= n) return S.slice().sort(rank).slice(0, n);
    var need = n - S.length;
    return S.concat(rest.slice().sort(rank).slice(0, need));
  }

  // ---------------------------------------------------------------- 跟牌
  function aiFollow(game, seat) {
    var ctx = game.ctx, hand = game.hands[seat], lead = game.lead;
    var n = lead.cards.length, lg = lead.group;
    var S = hand.filter(function (c) { return groupOf(ctx, c) === lg; });
    var leadPairs = pairCount(lead.units);
    var pts = currentTrickPoints(game);
    var winner = currentWinner(game);
    var partnerWinning = sameTeam(winner, partnerOf(seat));
    var lastToPlay = game.trick.length === 3;
    var isFinal = finalTrick(game, seat, n);
    var cands = [];

    if (S.length >= n) {
      var need = Math.min(leadPairs, pairCount(decompose(S, ctx)));
      cands = buildCandidates(S, n, need, ctx);
    } else {
      cands = fillCandidates(hand, lead, ctx);
    }
    cands.push(fallbackFollow(hand, lead, ctx, false));
    cands.push(fallbackFollow(hand, lead, ctx, true));

    cands = dedupeCandidates(cands.filter(function (sel) {
      return sel && sel.length === n && validateFollow(hand, sel, lead, ctx).ok;
    }));
    if (!cands.length) return fallbackFollow(hand, lead, ctx, false);

    var cheapest = null, cheapestCost = Infinity, cheapestBreak = false;
    var cheapestWin = null, cheapestWinCost = Infinity, cheapestWinBreak = false;
    var safeWin = null, safeWinCost = Infinity;
    var safeLose = null, safeLoseCost = Infinity;
    var bossWin = null, bossWinCost = Infinity;
    var structWin = null, structWinCost = Infinity;
    var ruffWins = [];
    // 按“我方赢下本墩的概率”折算的期望最好的一手
    var evWin = null, evWinVal = -Infinity, evWinPts = 0, evWinP = 0;
    var evLose = null, evLoseVal = -Infinity, evLosePts = 0;
    var canRuff = S.length === 0 && lg !== 4;
    // 缺门时手上还能垫的其它副牌张数；不够 n 张就不得不动用主牌
    var otherSuits = 0;
    for (var oi = 0; oi < hand.length; oi++) {
      var og = groupOf(ctx, hand[oi]);
      if (og !== 4 && og !== lg) otherSuits++;
    }
    var forcedTrump = canRuff && otherSuits < n;
    // 我方这一手落下后最终赢墩的最好概率，用于判断垫主牌时值不值得争
    var coverP = 0;

    for (var i = 0; i < cands.length; i++) {
      var sel = cands[i];
      var win = beatsCurrent(game, sel);
      var brk = breakPenalty(hand, sel, ctx);
      var cost = selectionValue(ctx, sel) + brk;
      var p = 0;
      for (var j = 0; j < sel.length; j++) p += pointOf(sel[j]);
      // 我方最终赢墩的概率，以及这一手（含分牌）的期望收益：
      // 打赢得分、打输送分，所以分牌价值按 2×胜率-1 折算
      var pWin = teamWinChance(game, seat, sel);
      if (pWin > coverP) coverP = pWin;
      var ev = (2 * pWin - 1) * (pts + p) - cost;

      if (win) {
        if (cost < cheapestWinCost) {
          cheapestWinCost = cost; cheapestWin = sel; cheapestWinBreak = brk > 0;
        }
        if (brk === 0 && cost < safeWinCost) { safeWinCost = cost; safeWin = sel; }
        // 这一手是否必大：同结构里已经没有更大的牌，后手也毙不掉
        if (brk === 0) {
          var wunits = decompose(sel, ctx);
          var allBoss = wunits.length > 0;
          var hasStruct = false;
          for (var bu = 0; bu < wunits.length; bu++) {
            if (!isBossUnit(game, seat, wunits[bu])) allBoss = false;
            if (wunits[bu].copies >= 2) hasStruct = true;
          }
          if (allBoss && cost < bossWinCost) { bossWinCost = cost; bossWin = sel; }
          if (hasStruct && cost < structWinCost) { structWinCost = cost; structWin = sel; }
        }
        if (canRuff && sel.every(function (c) { return groupOf(ctx, c) === 4; })) {
          ruffWins.push(sel);
        }
        if (ev > evWinVal) { evWinVal = ev; evWin = sel; evWinPts = p; evWinP = pWin; }
      } else {
        if (cost < cheapestCost) {
          cheapestCost = cost; cheapest = sel; cheapestBreak = brk > 0;
        }
        if (brk === 0 && cost < safeLoseCost) { safeLoseCost = cost; safeLose = sel; }
        if (ev > evLoseVal) { evLoseVal = ev; evLose = sel; evLosePts = p; }
      }
    }

    if (partnerWinning) {
      // 队友当前赢墩：赢面大就把分牌送过去，赢面小只跟最小的没用牌。
      // 用更大的同结构压过队友不损失团队收益（墩还是我方的），
      // 三条/四条这种罕见大牌尤其实在，能压就直接把分带走。
      var give = null, giveVal = 0;
      if (evWin && evWinPts > 0 && evWinVal > giveVal) { give = evWin; giveVal = evWinVal; }
      if (evLose && evLosePts > 0 && evLoseVal > giveVal) { give = evLose; giveVal = evLoseVal; }
      if (give) return give;
      if (cheapestBreak && safeLose) return safeLose;
      if (cheapest) return cheapest;
      return cheapestWin || cands[0];
    }

    // 对手首出拖拉机：先判断我们这一手有没有更大的拖拉机压得住。
    // 压不住就别往这墩里塞分（压得住时后面的逻辑自然会用更大的拖拉机赢下这墩）；
    // 队友在后面确定缺门、且没有被更后面的对手反毙时，可以把分牌垫给队友。
    if (leadTractorLen(lead) >= 2 && !sameTeam(game.leader, seat)) {
      var canBeatNow = false;
      for (var t0 = 0; t0 < cands.length; t0++) {
        if (beatsCurrent(game, cands[t0])) { canBeatNow = true; break; }
      }
      if (!canBeatNow) {
        var pr = partnerRuffInfo(game, seat, lg);
        if (pr.ruff && !pr.over) {
          var giveTrac = pointDumpFollow(hand, lead, ctx);
          if (giveTrac) return giveTrac;
        }
        // 缺门跟拖拉机时优先最便宜的散主，对子/三条/拖拉机留到后面赢墩
        if (forcedTrump) {
          var looseTrac = looseTrumpPick(hand, n, ctx);
          if (looseTrac) return looseTrac;
        }
        return noPointFollow(hand, lead, ctx);
      }
    }

    // 缺门毙牌：按墩面分数与后手反毙概率决定毙不毙、毙多大
    if (ruffWins.length) {
      var ruff = chooseRuff(game, seat, ruffWins, pts, isFinal, lastToPlay);
      if (ruff) return ruff;
      // 不值得毙时改跟无用牌，不再用贵主牌硬抢；
      // 缺门垫主时优先最便宜的散主，对子/拖拉机留着后面赢墩
      var looseR = forcedTrump ? looseTrumpPick(hand, n, ctx) : null;
      if (looseR) return looseR;
      var quiet = noPointFollow(hand, lead, ctx);
      if (quiet && quiet.length === n && validateFollow(hand, quiet, lead, ctx).ok) return quiet;
      if (cheapestBreak && safeLose) return safeLose;
      if (cheapest) return cheapest;
    }

    if (cheapestWin) {
      var budget = isFinal ? 1e9 :
        pts >= 20 ? 9.5 : pts >= 10 ? 6.5 : pts >= 5 ? 4.5 : 2.5;
      // 对子/拖拉机是后面抢分的本钱：只有大分墩、末位必赢或末墩才允许拆
      var allowBreak = isFinal || lastToPlay || pts >= 15;
      var mustTry = isFinal || pts >= 5 || lastToPlay;
      // 最后一墩的底牌加成远大于普通分数，尽力争
      if (mustTry) {
        // 我方赢面大时，同样能赢就顺手把分牌打出去（赢下这墩就落袋）
        if (evWin && evWinVal > 0 && evWinP >= 0.7) return evWin;
        if (safeWin && safeWinCost <= budget) return safeWin;
        if (!cheapestWinBreak && cheapestWinCost <= budget) return cheapestWin;
        if (cheapestWinBreak && allowBreak) return cheapestWin;
        if (isFinal) return cheapestWin;
      }
    }
    // 出牌权：有分或到了后期才值得花大牌抢；零分小墩先跟最小的牌
    var endgame = hand.length <= n + 4 || game.trickNo >= 8;
    if (bossWin && !canRuff && (pts >= 5 || endgame)) {
      var handPts = 0;
      for (var hp = 0; hp < hand.length; hp++) handPts += pointOf(hand[hp]);
      var ctrlBudget = isFinal ? 1e9 : endgame ? 9.0 : 4.2;
      if (handPts >= 10) ctrlBudget += 1.5; // 手里还有分牌可兑现，先手更值钱
      if (bossWinCost <= ctrlBudget) return bossWin;
    }
    // 后期手里的对子/拖拉机即使不是必大也主动争一争：牌不多了，先手比省牌更值钱
    if (endgame && !canRuff && structWin && structWinCost <= 6.0) return structWin;
    // 我方这一手落下后赢面够大：跟牌时顺带把分牌打出去，赢下就落袋
    if (!canRuff && evWin && evWinP >= 0.7 && evWinPts > 0 && evWinVal > 0) return evWin;
    // 赢不了这墩时优先保留对子/拖拉机，宁可垫一张散牌；
    // 有输墩风险时按胜率折算，胜率低就只出小的没用牌，不送分
    if (forcedTrump && coverP < 0.5) {
      // 缺门只能动用主牌、这墩又基本拿不到时，优先最便宜的散主，
      // 把对子/拖拉机留到后面赢墩
      var looseF = looseTrumpPick(hand, n, ctx);
      if (looseF) return looseF;
    }
    if (cheapestBreak && safeLose) return safeLose;
    if (evLose) return evLose;
    if (cheapest) return cheapest;

    // 只能赢过队友时，出代价最小的
    return cheapestWin || cands[0];
  }

  function aiChoose(game, seat) {
    var ctx = game.ctx, hand = game.hands[seat];
    var cards;
    if (game.lead) {
      cards = aiFollow(game, seat);
      if (!validateFollow(hand, cards, game.lead, ctx).ok) {
        cards = fallbackFollow(hand, game.lead, ctx, false);
      }
    } else {
      cards = aiLead(game, seat);
      if (!validateLead(cards, ctx, game.opponentHands(seat)).ok) {
        var sorted = hand.slice().sort(function (a, b) { return orderOf(ctx, a) - orderOf(ctx, b); });
        cards = [sorted[0]];
      }
    }
    return cards;
  }

  // 庄家扣底：整门清掉短门做缺门，优先埋非主、非分、低点、单张
  function autoBury(hand, ctx, n) {
    var pool = hand.slice();
    var picked = [];

    function takeCard(c) {
      var i = pool.indexOf(c);
      if (i >= 0 && picked.length < n) { pool.splice(i, 1); picked.push(c); }
    }
    function bucketSize(c) {
      var key = (isJoker(c) ? 'J' + rankOf(c) : 'S' + suitOf(c)) + '|' + orderOf(ctx, c);
      var cnt = 0;
      for (var i = 0; i < hand.length; i++) {
        var k = (isJoker(hand[i]) ? 'J' + rankOf(hand[i]) : 'S' + suitOf(hand[i])) + '|' + orderOf(ctx, hand[i]);
        if (k === key) cnt++;
      }
      return cnt;
    }

    // 1) 整门扣掉最短、控制力最弱的副牌花色，制造缺门
    var groups = {};
    for (var gi = 0; gi < hand.length; gi++) {
      var gc = hand[gi];
      if (groupOf(ctx, gc) === 4) continue;
      var gs = suitOf(gc);
      (groups[gs] = groups[gs] || []).push(gc);
    }
    function suitControl(arr) {
      var ctrl = 0;
      for (var ci = 0; ci < arr.length; ci++) {
        var o = orderOf(ctx, arr[ci]);
        if (o >= 140) ctrl += 2.5;
        else if (o >= 120) ctrl += 0.8;
      }
      var uu = decompose(arr, ctx);
      for (var ui = 0; ui < uu.length; ui++) {
        if (uu[ui].cards.length >= 2) ctrl += 1.2;
      }
      return ctrl;
    }
    var suits = Object.keys(groups).map(Number).sort(function (a, b) {
      return (groups[a].length + suitControl(groups[a]) * 0.6) -
             (groups[b].length + suitControl(groups[b]) * 0.6);
    });
    for (var si = 0; si < suits.length && picked.length < n; si++) {
      var arr = groups[suits[si]];
      if (arr.length > n - picked.length) continue;
      var pts = 0;
      for (var pi = 0; pi < arr.length; pi++) pts += pointOf(arr[pi]);
      if (pts > 0) continue; // 底牌不埋分牌
      // 短门里的控制牌（A/K/对子）留着更有用，不为了做缺门而埋掉
      if (arr.length <= 2 && suitControl(arr) >= 2) continue;
      for (var ai = 0; ai < arr.length; ai++) takeCard(arr[ai]);
    }

    // 2) 其余按“非主 > 非分 > 低点 > 不拆对子”排序补齐
    var rest = pool.slice().sort(function (a, b) {
      var ta = groupOf(ctx, a) === 4 ? 1 : 0, tb = groupOf(ctx, b) === 4 ? 1 : 0;
      var pa = pointOf(a) ? 1 : 0, pb = pointOf(b) ? 1 : 0;
      var ba = bucketSize(a) >= 2 ? 1 : 0, bb = bucketSize(b) >= 2 ? 1 : 0;
      return ta - tb || pa - pb || ba - bb || orderOf(ctx, a) - orderOf(ctx, b);
    });
    for (var ri = 0; ri < rest.length && picked.length < n; ri++) picked.push(rest[ri]);
    return picked;
  }

  // ---------------------------------------------------------------- 对局
  var SEAT_NAME = ['南（你）', '东', '北', '西'];
  var TEAM_NAME = ['南北', '东西'];

  function teamOf(seat) { return seat % 2; }

  function Game(opts) {
    opts = opts || {};
    this.decks = opts.decks || 4;
    this.rule = opts.rule || 1;
    this.allowNoTrump = opts.allowNoTrump !== false;
    this.humanSeat = opts.humanSeat || 0;
    this.rng = opts.rng || Math.random;
    // true 时发完牌停在亮主窗口，等界面调用 finishDealNow；自对弈/测试保持 false
    this.dealHold = !!opts.dealHold;
    this.teamLevels = [2, 2];
    // 首局庄家随机（与 0x417630 的随机发牌顺序一致）
    this.bankerTeam = this.rng() < 0.5 ? 0 : 1;
    this.bankerSeat = teamOf(this.humanSeat) === this.bankerTeam
      ? this.humanSeat
      : (this.bankerTeam === 0 ? 0 : 1);
    this.roundNo = 0;
    this.gameOver = false;
    this.phase = 'idle';
    this.hands = [[], [], [], []];
    this.log = [];
  }

  Game.prototype.teamOf = teamOf;

  Game.prototype.startRound = function () {
    this.roundNo++;
    this.level = this.teamLevels[this.bankerTeam];
    this.hands = [[], [], [], []];
    this.bottom = [];
    this.bottomBuried = [];
    this.trumpSuit = null;
    this.strength = 0;
    this.bidRank = 0;
    this.declarer = null;
    this.declareCards = [];
    this.phase = 'deal';
    this.turn = null;
    this.leader = null;
    this.trick = [];
    this.lead = null;
    this.trickNo = 0;
    this.defenderPoints = 0;
    this.lastTrick = null;
    this.roundResult = null;
    this.gameOver = false;
    this.log = [];
    this.ctx = null;
    this.voids = [{}, {}, {}, {}];
    this.trumpLeft = [0, 0, 0, 0];
    this.seen = {};
    this.dealDone = false;

    var deck = shuffle(makeDeck(this.decks), this.rng);
    this.deckQueue = deck;
    this.dealPos = 0;
    this.perPlayer = (this.decks * 54 - bottomSize(this.decks)) / 4;
    this.bottomN = bottomSize(this.decks);
    return this;
  };

  // 发一轮牌（每人 k 张），返回本轮发出的牌
  // dealHold 为 true 时，发完最后一张先停在“亮主窗口”，由界面调用 finishDealNow 收尾
  Game.prototype.dealStep = function (k) {
    if (this.phase !== 'deal' || this.dealDone) return null;
    k = k || 4;
    var dealt = [];
    for (var s = 0; s < 4; s++) {
      var want = Math.min(k, this.perPlayer - this.hands[s].length);
      for (var i = 0; i < want; i++) {
        if (this.dealPos >= this.deckQueue.length) break;
        var c = this.deckQueue[this.dealPos++];
        this.hands[s].push(c);
        dealt.push({ seat: s, card: c });
      }
    }
    var done = this.hands[0].length === this.perPlayer &&
               this.hands[1].length === this.perPlayer &&
               this.hands[2].length === this.perPlayer &&
               this.hands[3].length === this.perPlayer;
    if (done) {
      this.dealDone = true;
      if (!this.dealHold) this.finishDeal();
    }
    return { dealt: dealt, done: done };
  };

  // 发牌结束后收尾（扣底阶段）：界面在亮主窗口结束时调用
  Game.prototype.finishDealNow = function () {
    if (this.phase === 'deal' && this.dealDone) this.finishDeal();
    return this;
  };

  Game.prototype.finishDeal = function () {
    this.bottom = this.deckQueue.slice(this.dealPos);
    // 首局没有上局结果：最后亮主的人坐庄（庄家拿底、先出）
    if (this.roundNo === 1 && this.declarer != null) {
      this.bankerTeam = teamOf(this.declarer);
      this.bankerSeat = this.declarer;
    }
    this.level = this.teamLevels[this.bankerTeam];
    if (this.trumpSuit === null) {
      // 无人亮主：先从底牌找庄家级牌定主，否则取牌堆中第一张普通牌的花色
      var suit = -1, i, c;
      for (i = 0; i < this.bottom.length; i++) {
        c = this.bottom[i];
        if (!isJoker(c) && rankOf(c) === this.level) { suit = suitOf(c); break; }
      }
      if (suit < 0) {
        for (i = this.dealPos; i < this.deckQueue.length; i++) {
          c = this.deckQueue[i];
          if (!isJoker(c)) { suit = suitOf(c); break; }
        }
      }
      if (suit < 0) {
        this.trumpSuit = 4;
        this.log.push('无人亮主，本局无主');
      } else {
        this.trumpSuit = suit;
        this.log.push('无人亮主，翻底定主：' + SUIT_NAME[suit]);
      }
    }
    this.ctx = makeContext(this.trumpSuit, this.level, this.bankerTeam);
    // 庄家拿底
    this.hands[this.bankerSeat] = this.hands[this.bankerSeat].concat(this.bottom);
    this.phase = 'bury';
    return this;
  };

  Game.prototype.declare = function (seat, suit) {
    var opt = this.declareOption(seat, suit);
    if (!opt.ok) return opt;
    this.trumpSuit = suit;
    this.strength = opt.count;
    this.bidRank = opt.rank;
    this.declarer = seat;
    // 记录亮主用的牌（级牌或王），界面据此在出牌区展示
    var hand = this.hands[seat], used = [];
    if (suit === 4) {
      // 只记录成对的那一种王（大王优先），混搭的王不参与亮主
      var bigs = [], smalls = [];
      for (var i = 0; i < hand.length; i++) {
        if (hand[i] === JOKER_BIG) bigs.push(hand[i]);
        else if (hand[i] === JOKER_SMALL) smalls.push(hand[i]);
      }
      used = bigs.length >= 2 ? bigs : smalls;
    } else {
      for (var i = 0; i < hand.length; i++) {
        var c = hand[i];
        if (!isJoker(c) && suitOf(c) === suit && rankOf(c) === this.level) {
          used.push(c);
        }
      }
    }
    this.declareCards = used;
    this.log.push(SEAT_NAME[seat] + ' 亮主：' + (suit === 4 ? '无主' : SUIT_NAME[suit]) +
                  '（' + opt.count + ' 张' + (suit === 4 ? '王' : '级牌') + '）');
    return { ok: true };
  };

  /**
   * 亮主/反主资格与权重（参考三副牌竞技规则）：
   *   先比张数；同张数时 王牌 > 级牌，且 大王 > 小王。
   *   权重 = 张数 × 10 + 牌型层级（级牌 0 / 小王 1 / 大王 2）。
   */
  Game.prototype.declareOption = function (seat, suit) {
    if (this.phase !== 'deal') return { ok: false, count: 0, rank: 0, msg: '现在不能亮主' };
    var hand = this.hands[seat];
    var count = 0, tier = 0;
    if (suit === 4) {
      if (!this.allowNoTrump) return { ok: false, count: 0, rank: 0, msg: '本局未启用无主' };
      var small = 0, big = 0;
      for (var j = 0; j < hand.length; j++) {
        if (hand[j] === JOKER_SMALL) small++;
        else if (hand[j] === JOKER_BIG) big++;
      }
      // 无主必须用两张相同的王：大王+大王 或 小王+小王，大小王混搭不成对
      var same = Math.max(small, big);
      if (same < 2) return { ok: false, count: same, rank: 0, msg: '无主要两张相同的王（两张大/两张小王）' };
      count = same;
      tier = big >= 2 ? 2 : 1;
    } else {
      count = hand.filter(function (c) {
        return !isJoker(c) && suitOf(c) === suit && rankOf(c) === this.level;
      }, this).length;
      if (count === 0) return { ok: false, count: 0, rank: 0, msg: '手里没有这门花色的级牌' };
      tier = 0;
    }
    var rank = count * 10 + tier;
    if (rank <= (this.bidRank || 0)) {
      return { ok: false, count: count, rank: rank, msg: '需要更大的牌型才能反主' };
    }
    return { ok: true, count: count, rank: rank, msg: '' };
  };

  // 电脑在发牌过程中尝试亮主/反主
  Game.prototype.aiMaybeDeclare = function (seat) {
    if (this.phase !== 'deal') return;
    var pick = aiDeclare(this, seat);
    if (pick) this.declare(seat, pick.suit);
  };

  Game.prototype.bury = function (seat, cards) {
    if (this.phase !== 'bury') return { ok: false, msg: '现在不能扣底' };
    if (seat !== this.bankerSeat) return { ok: false, msg: '只有庄家能扣底' };
    if (cards.length !== this.bottomN) {
      return { ok: false, msg: '必须扣 ' + this.bottomN + ' 张底牌' };
    }
    if (!containsAll(this.hands[seat], cards)) {
      return { ok: false, msg: '扣底的牌不在手里' };
    }
    this.hands[seat] = removeCards(this.hands[seat], cards);
    this.bottomBuried = cards.slice();
    this.bottomPoints = cards.reduce(function (s, c) { return s + pointOf(c); }, 0);
    var ctx = this.ctx;
    this.voids = [{}, {}, {}, {}];
    this.trumpLeft = this.hands.map(function (h) { return countTrumps(h, ctx); });
    this.phase = 'play';
    this.turn = this.bankerSeat;
    this.leader = this.bankerSeat;
    this.trick = [];
    this.lead = null;
    return { ok: true };
  };

  Game.prototype.opponentHands = function (seat) {
    var out = [];
    for (var s = 0; s < 4; s++) if (s !== seat) out.push(this.hands[s]);
    return out;
  };

  Game.prototype.play = function (seat, cards) {
    if (this.phase !== 'play') return { ok: false, msg: '现在不能出牌' };
    if (seat !== this.turn) return { ok: false, msg: '还没轮到这一家' };
    if (!cards || !cards.length) return { ok: false, msg: '请选择要出的牌' };
    var hand = this.hands[seat];
    if (!containsAll(hand, cards)) return { ok: false, msg: '选择的牌不在手里' };

    if (!this.lead) {
      var v = validateLead(cards, this.ctx, this.opponentHands(seat));
      if (!v.ok) return v;
      this.lead = v.lead;
      this.leader = seat;
    } else {
      var f = validateFollow(hand, cards, this.lead, this.ctx);
      if (!f.ok) return f;
    }

    this.hands[seat] = removeCards(hand, cards);
    this.trick.push({ seat: seat, cards: cards.slice() });

    // 记录主牌消耗与缺门信息，供电脑决策使用
    this.trumpLeft[seat] -= countTrumps(cards, this.ctx);
    for (var si = 0; si < cards.length; si++) {
      this.seen[cards[si]] = (this.seen[cards[si]] || 0) + 1;
    }
    if (this.lead) {
      var followed = 0;
      for (var i = 0; i < cards.length; i++) {
        if (groupOf(this.ctx, cards[i]) === this.lead.group) followed++;
      }
      if (followed === 0) this.voids[seat][this.lead.group] = true;
    }

    if (this.trick.length === 4) return this.resolveTrick();
    this.turn = (seat + 1) % 4;
    return { ok: true, next: this.turn };
  };

  Game.prototype.resolveTrick = function () {
    var winner = trickWinner(this.trick, this.lead, this.ctx);
    var pts = 0;
    this.trick.forEach(function (p) {
      p.cards.forEach(function (c) { pts += pointOf(c); });
    });
    var defTeam = 1 - this.bankerTeam;
    if (teamOf(winner) === defTeam) this.defenderPoints += pts;

    var leadCount = this.lead.cards.length;
    this.lastTrick = {
      plays: this.trick.slice(),
      winner: winner,
      points: pts
    };
    this.trickNo++;

    var empty = this.hands.every(function (h) { return h.length === 0; });
    this.trick = [];
    this.lead = null;
    this.turn = winner;
    this.leader = winner;

    if (empty) return this.endRound(winner, leadCount, pts);
    return { ok: true, trickEnd: true, winner: winner, points: pts, next: winner };
  };

  Game.prototype.endRound = function (lastWinner, leadCount) {
    var bonus = 0;
    if (teamOf(lastWinner) !== this.bankerTeam) {
      // 与 0x4076a0 一致：底分 × 副牌数 × 末墩张数
      bonus = (this.bottomPoints || 0) * this.decks * leadCount;
      this.defenderPoints += bonus;
    }
    var result = settle(this.teamLevels[0], this.teamLevels[1], this.bankerTeam,
                        this.defenderPoints, this.decks, this.rule);
    this.teamLevels = result.levels;
    this.roundResult = result;
    this.phase = 'roundEnd';
    this.gameOver = result.reset;
    this.lastTrickBonus = bonus;
    return { ok: true, trickEnd: true, roundEnd: true, result: result, bonus: bonus };
  };

  Game.prototype.nextRound = function () {
    if (this.gameOver) return false;
    this.bankerTeam = this.roundResult.winnerTeam;
    // 让人类玩家所在队伍坐庄时由人类扣底
    this.bankerSeat = teamOf(this.humanSeat) === this.bankerTeam
      ? this.humanSeat
      : (this.bankerTeam === 0 ? 0 : 1);
    this.startRound();
    return true;
  };

  // ---------------------------------------------------------------- 导出
  return {
    SUIT_LABEL: SUIT_LABEL,
    SUIT_NAME: SUIT_NAME,
    RANK_LABEL: RANK_LABEL,
    SEAT_NAME: SEAT_NAME,
    TEAM_NAME: TEAM_NAME,
    JOKER_SMALL: JOKER_SMALL,
    JOKER_BIG: JOKER_BIG,
    suitOf: suitOf,
    rankOf: rankOf,
    isJoker: isJoker,
    isRed: isRed,
    pointOf: pointOf,
    cardName: cardName,
    cardLabel: cardLabel,
    makeDeck: makeDeck,
    bottomSize: bottomSize,
    shuffle: shuffle,
    mulberry32: mulberry32,
    makeContext: makeContext,
    isTrump: isTrump,
    groupOf: groupOf,
    orderOf: orderOf,
    decompose: decompose,
    pairCount: pairCount,
    validateLead: validateLead,
    validateFollow: validateFollow,
    trickWinner: trickWinner,
    settle: settle,
    aiChoose: aiChoose,
    aiDeclare: aiDeclare,
    isBossUnit: isBossUnit,
    autoBury: autoBury,
    teamOf: teamOf,
    Game: Game
  };
});
