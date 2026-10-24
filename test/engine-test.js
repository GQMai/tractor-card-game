/* 规则内核自检 + AI 全自动对局压力测试 */
'use strict';
const E = require('../renderer/engine.js');
const assert = require('assert');

let checks = 0;
function ok(cond, msg) {
  if (!cond) throw new Error('断言失败: ' + msg);
  checks++;
}

// 1. 编码
for (let id = 0; id < 54; id++) {
  ok(E.suitOf(id) >= 0 && E.suitOf(id) <= 4, 'suit range');
}
ok(E.suitOf(52) === 4 && E.suitOf(53) === 4, '王的花色行');
ok(E.pointOf(3) === 5 && E.pointOf(8) === 10 && E.pointOf(11) === 10, '5/10/K 分值');
ok(E.cardName(53) === '大王' && E.cardName(0) === '♦2', '牌名');

// 2. 发牌
[1, 2, 3, 4].forEach(function (decks) {
  const d = E.makeDeck(decks);
  ok(d.length === decks * 54, decks + ' 副牌张数');
  ok(E.bottomSize(decks) === (decks % 2 === 0 ? 8 : 6), decks + ' 副底牌数');
  const g = new E.Game({ decks: decks, rng: E.mulberry32(11) }).startRound();
  while (g.phase === 'deal') g.dealStep(4);
  ok(g.bottom.length === E.bottomSize(decks), '底牌数量');
  const total = g.hands.reduce((s, h) => s + h.length, 0);
  ok(total === decks * 54, '发牌总数');
});

// 3. 主牌顺序
{
  const ctx = E.makeContext(2, 5, 0);
  const seq = [53, 52, 29, 12, 11, 0].map(c => E.orderOf(ctx, c));
  for (let i = 1; i < seq.length; i++) ok(seq[i - 1] > seq[i], '主牌顺序 ' + seq);
  ok(E.isTrump(ctx, 29), '红桃5是主');
  ok(!E.isTrump(ctx, 2), '方块4不是主（5 是级牌，四门 5 均为主）');
}

// 4. 牌型分解
{
  const ctx = E.makeContext(2, 9, 0); // 主牌红桃，级牌 9
  const c5 = 0 * 13 + 3, c6 = 0 * 13 + 4;
  const u = E.decompose([c5, c5, c6, c6], ctx);
  ok(u.length === 1 && u[0].len === 2 && u[0].copies === 2, '♦5♦5♦6♦6 是连对');

  const ctx2 = E.makeContext(2, 5, 0);
  const pair = E.decompose([29, 29], ctx2);
  ok(pair.length === 1 && pair[0].copies === 2, '红桃5对子');
  // 不同花色的级牌不能组成对子
  const mixedLevel = E.decompose([3, 29], ctx2);
  ok(mixedLevel.length === 2, '跨花色级牌不算对子');
}

// 5. 跟牌校验
{
  const ctx = E.makeContext(2, 9, 0);
  const c5 = 3, c6 = 4, c7 = 5;
  const lead = E.validateLead([c6], ctx).lead;
  ok(E.validateFollow([c5, c6], [c5], lead, ctx).ok, '跟同门单张');
  ok(!E.validateFollow([c5, c6], [c5, c6], lead, ctx).ok, '张数不符应拒绝');

  const leadPair = E.validateLead([c6, c6], ctx).lead;
  ok(!E.validateFollow([c5, c7, c7], [c5, c7], leadPair, ctx).ok, '有对子必须跟对子');
  ok(E.validateFollow([c5, c7, c7], [c7, c7], leadPair, ctx).ok, '跟出对子');

  // 同门不足：必须先出完该门
  const spadeLead = E.validateLead([0 * 13 + 2], ctx).lead; // ♦4
  ok(!E.validateFollow([c5, 40], [40], spadeLead, ctx).ok, '有该门必须跟该门');
}

// 5b. 必须结构相同才能压
{
  const ctx = E.makeContext(2, 9, 0); // 主牌红桃，级牌 9
  const leadPair = E.validateLead([2, 2], ctx).lead; // ♦4♦4
  let w = E.trickWinner([
    { seat: 0, cards: [2, 2] },
    { seat: 1, cards: [4, 5] } // ♦6 ♦7 两张单牌
  ], leadPair, ctx);
  ok(w === 0, '两张单牌压不住对子');

  const leadTractor = E.validateLead([2, 2, 3, 3], ctx).lead; // ♦4♦4♦5♦5
  w = E.trickWinner([
    { seat: 0, cards: [2, 2, 3, 3] },
    { seat: 1, cards: [4, 4, 6, 6] } // ♦6♦6 + ♦8♦8，不相邻
  ], leadTractor, ctx);
  ok(w === 0, '两组不相邻对子压不住拖拉机');

  w = E.trickWinner([
    { seat: 0, cards: [2, 2, 3, 3] },
    { seat: 1, cards: [4, 4, 5, 5] } // ♦6♦6♦7♦7，更大拖拉机
  ], leadTractor, ctx);
  ok(w === 1, '更大的拖拉机可以压');

  const hand = [4, 4, 5, 5, 8, 8]; // ♦6♦6♦7♦7 + ♦10♦10
  ok(!E.validateFollow(hand, [4, 4, 8, 8], leadTractor, ctx).ok, '有拖拉机不能拆成两个对子');
  ok(E.validateFollow(hand, [4, 4, 5, 5], leadTractor, ctx).ok, '跟出同长度拖拉机');
}

// 5c. 甩牌只能根据“可能存在的牌”判断，不暴露具体手牌
{
  const ctx = E.makeContext(2, 9, 0); // 主牌红桃
  ok(!E.validateLead([2, 2, 3], ctx, [[4, 4]]).ok, '甩牌被更大的同型牌压住应不成立');
  ok(!E.validateLead([2, 2, 3], ctx, [[26]]).ok, '副牌甩牌可能被主牌毙掉应不成立');
  ok(E.validateLead([2, 2, 3], ctx, [[1]]).ok, '没有更大的同型牌和主牌时可以甩牌');
  // 还有该门花色（哪怕张数不够跟满）的人必须先跟该门，不能用主牌毙
  ok(E.validateLead([2, 2, 3], ctx, [[1, 26], [0, 40], [1, 41]]).ok,
     '对手还有该门牌（张数不足）时甩牌成立');
  // 真正缺门且有主牌，单张组件会被毙，甩牌不成立
  ok(!E.validateLead([2, 2, 3], ctx, [[26], [0, 40], [1, 41]]).ok,
     '真正缺门且有主牌时甩牌不成立');
}

// 5d. 无人亮主时翻底定主
{
  const g = new E.Game({ decks: 2, rng: E.mulberry32(9) }).startRound();
  while (g.phase === 'deal') g.dealStep(4);
  ok(g.trumpSuit !== null && g.trumpSuit >= 0 && g.trumpSuit <= 4, '无人亮主也应确定主牌');
  ok(g.trumpSuit === 4 || g.log.some(function (s) { return s.indexOf('翻底定主') >= 0; }),
     '翻底定主记录');
}

// 5e. 底牌加分 = 底分 × 副数 × 末墩张数
{
  const g = new E.Game({ decks: 2, rule: 2, rng: E.mulberry32(3) });
  g.bankerTeam = 0;
  g.teamLevels = [2, 2];
  g.bottomPoints = 10;
  g.defenderPoints = 0;
  const r = g.endRound(1, 3);
  ok(r.bonus === 60, '底牌加分应为 10×2×3=60，实际 ' + r.bonus);
}

// 5f. 三条 / 四条 / 推土机
{
  const ctx = E.makeContext(2, 9, 0); // 主红桃，级牌 9
  const D4 = 2, D5 = 3, D6 = 4, D7 = 5;
  const triple4 = [D4, D4, D4], triple5 = [D5, D5, D5];
  const quad4 = [D4, D4, D4, D4];

  let u = E.decompose(triple4, ctx);
  ok(u.length === 1 && u[0].copies === 3 && u[0].len === 1, '三条分解');
  u = E.decompose([D4, D4, D4, D5, D5, D5], ctx);
  ok(u.length === 1 && u[0].copies === 3 && u[0].len === 2, '推土机分解');
  u = E.decompose(quad4, ctx);
  ok(u.length === 1 && u[0].copies === 4 && u[0].len === 1, '四条分解');
  u = E.decompose([D4, D4, D4, D4, D5, D5, D5, D5], ctx);
  ok(u.length === 1 && u[0].copies === 4 && u[0].len === 2, '连四条分解');

  const leadTriple = E.validateLead(triple4, ctx).lead;
  ok(!!leadTriple, '三条可以首出');
  ok(!E.validateFollow([D4, D4, D4, D6], [D4, D4, D6], leadTriple, ctx).ok, '有三条必须跟三条');
  ok(E.validateFollow([D4, D4, D4, D6], [D4, D4, D4], leadTriple, ctx).ok, '跟出三条');
  ok(E.validateFollow([D4, D4, D6, D7], [D4, D4, D6], leadTriple, ctx).ok, '无三条时对子+单张');
  ok(!E.validateFollow([D4, D4, D6, D7], [D4, D6, D7], leadTriple, ctx).ok, '无三条时不能只出三个单张');

  // 推土机必须整段跟出，没有同长链时要跟出所有三条
  const leadTitanic = E.validateLead([D4, D4, D4, D5, D5, D5], ctx).lead;
  const titanicHand = [D4, D4, D4, D6, D6, D6];
  ok(E.validateFollow(titanicHand, titanicHand.slice(), leadTitanic, ctx).ok, '无同长链时跟出两条三条');
  ok(!E.validateFollow([D4, D4, D4, D6, D6, D6, D7], [D4, D4, D4, D6, D6, D7], leadTitanic, ctx).ok,
     '有三条不能拆成三条+对子+单张');
  // 有同长推土机时必须整段跟出
  const titanicHand2 = [D5, D5, D5, D6, D6, D6, D7];
  ok(E.validateFollow(titanicHand2, [D5, D5, D5, D6, D6, D6], leadTitanic, ctx).ok, '跟出同长推土机');
  ok(!E.validateFollow(titanicHand2, [D5, D5, D5, D6, D6], leadTitanic, ctx).ok, '张数不符应拒绝');

  // 四条
  const leadQuad = E.validateLead(quad4, ctx).lead;
  ok(!E.validateFollow([D4, D4, D4, D4, D6], [D4, D4, D4, D6], leadQuad, ctx).ok, '有四条必须跟四条');
  ok(E.validateFollow([D4, D4, D4, D4, D6], [D4, D4, D4, D4], leadQuad, ctx).ok, '跟出四条');

  // 比大小：只有同结构才能压
  let w = E.trickWinner([
    { seat: 0, cards: triple4.slice() },
    { seat: 1, cards: triple5.slice() }
  ], leadTriple, ctx);
  ok(w === 1, '更大的三条可以压');
  w = E.trickWinner([
    { seat: 0, cards: triple4.slice() },
    { seat: 1, cards: [D5, D6, D7] }
  ], leadTriple, ctx);
  ok(w === 0, '三个单张压不住三条');

  w = E.trickWinner([
    { seat: 0, cards: quad4.slice() },
    { seat: 1, cards: [D5, D5, D6, D6] }
  ], leadQuad, ctx);
  ok(w === 0, '两对压不住四条');
  w = E.trickWinner([
    { seat: 0, cards: quad4.slice() },
    { seat: 1, cards: [D5, D5, D5, D5] }
  ], leadQuad, ctx);
  ok(w === 1, '更大的四条可以压');

  w = E.trickWinner([
    { seat: 0, cards: [D4, D4, D4, D5, D5, D5] },
    { seat: 1, cards: [D5, D5, D5, D6, D6, D6] }
  ], leadTitanic, ctx);
  ok(w === 1, '更大的推土机可以压');
  w = E.trickWinner([
    { seat: 0, cards: [D4, D4, D4, D5, D5, D5] },
    { seat: 1, cards: [D6, D6, D6, D7, D7, D7].slice() }
  ], leadTitanic, ctx);
  ok(w === 1, '更大的同长推土机可以压');

  // 毙牌：毙三条必须用主牌三条，三张不同主牌只能垫牌
  const H4 = 28, H6 = 30, H7 = 31; // ♥4 ♥6 ♥7
  w = E.trickWinner([
    { seat: 0, cards: triple4.slice() },
    { seat: 1, cards: [H4, H6, H7] }
  ], leadTriple, ctx);
  ok(w === 0, '三张不同主牌不能毙三条');
  w = E.trickWinner([
    { seat: 0, cards: triple4.slice() },
    { seat: 1, cards: [H4, H4, H4] }
  ], leadTriple, ctx);
  ok(w === 1, '主牌三条可以毙三条');

  // 甩牌：三条组件也会被更大的三条压住
  ok(!E.validateLead([D4, D4, D4, D6], ctx, [[D5, D5, D5]]).ok, '甩三条被更大的三条压住应不成立');
  ok(E.validateLead([D4, D4, D4, D6], ctx, [[D5, D5]]).ok, '对子压不住三条，甩牌成立');
}

// 5g. AI 会跟三条/四条/推土机
{
  const ctx = E.makeContext(2, 9, 0);
  const D4 = 2, D5 = 3, D6 = 4, D7 = 5;
  const filler = [[20, 21], [30, 40], [50, 51]];
  const leadTriple = E.validateLead([D4, D4, D4], ctx).lead;
  let g = scaffold([[D4, D4, D4], [D4, D4, D4, D6], filler[0], filler[1]], ctx,
                   { trick: [{ seat: 0, cards: [D4, D4, D4] }], lead: leadTriple, leader: 0, turn: 1 });
  let pick = E.aiChoose(g, 1);
  ok(E.validateFollow(g.hands[1], pick, leadTriple, ctx).ok, 'AI 跟三条合法');
  ok(E.decompose(pick, ctx).some(u => u.copies >= 3), 'AI 有对子以上时会用三条跟');

  const leadQuad = E.validateLead([D4, D4, D4, D4], ctx).lead;
  g = scaffold([[D4, D4, D4, D4], [D5, D5, D6, D6], filler[0], filler[1]], ctx,
               { trick: [{ seat: 0, cards: [D4, D4, D4, D4] }], lead: leadQuad, leader: 0, turn: 1 });
  pick = E.aiChoose(g, 1);
  ok(pick.length === 4 && E.validateFollow(g.hands[1], pick, leadQuad, ctx).ok, 'AI 跟四条张数与合法性');
}


// 5h. 发牌结束后的亮主窗口（对应旧程序发牌结束后仍可点叫牌按钮）
{
  const g = new E.Game({ decks: 1, dealHold: true, rng: E.mulberry32(21) });
  g.startRound();
  g.finishDealNow();
  ok(g.phase === 'deal', '未发完牌时不能提前结束发牌');
  while (!g.dealDone) g.dealStep(1);
  ok(g.phase === 'deal' && g.dealDone, '发完牌停在亮主窗口');
  const per = g.perPlayer;
  ok(g.hands.every(h => h.length === per), '亮主窗口内四家手牌已满');

  g.level = 9;
  g.hands[0] = [7]; // ♦9
  const r = g.declare(0, 0);
  ok(r.ok && g.trumpSuit === 0, '亮主窗口内仍可亮主');
  g.finishDealNow();
  ok(g.phase === 'bury', '窗口结束后进入扣底');
  ok(g.bottom.length === E.bottomSize(1), '底牌张数');
  ok(g.ctx && g.ctx.trumpSuit === 0, '以窗口内亮主的花色作主');
  ok(g.dealStep(1) === null, '结束后不能再发牌');
}

// 5i. 首局最后亮主的人坐庄：庄家拿底并先出牌
{
  const g = new E.Game({ decks: 1, dealHold: true, rng: E.mulberry32(31) });
  g.bankerTeam = 1; // 首局初始庄家先落在东西
  g.bankerSeat = 1;
  g.startRound();
  while (!g.dealDone) g.dealStep(1);
  g.level = 9;
  g.hands[2] = [7, 7]; // ♦9 x2
  ok(g.declare(2, 0).ok, '北家亮方块主');
  g.finishDealNow();
  ok(g.bankerSeat === 2 && g.bankerTeam === 0, '首局最后亮主的人坐庄');
  ok(g.bottom.every(c => g.hands[2].indexOf(c) >= 0), '庄家拿底牌');
  ok(g.bury(2, g.hands[2].slice(0, g.bottomN)).ok, '亮主庄家扣底');
  ok(g.leader === 2 && g.turn === 2, '庄家先出牌');
}


// 6. 升级结算（与 0x4076a0 一致）
{
  const t1 = { 0: [3, 0], 39: [2, 0], 40: [1, 0], 79: [1, 0], 80: [0, 1], 100: [1, 1] };
  for (const n in t1) {
    const r = E.settle(2, 2, 0, Number(n), 2, 1);
    ok(r.delta === t1[n][0] && r.winnerTeam === t1[n][1], '规则一 N=' + n);
  }
  let r = E.settle(2, 2, 0, 0, 2, 2);
  ok(r.delta === 5 && r.winnerTeam === 0, '规则二 N=0');
  r = E.settle(2, 2, 0, 100, 2, 2);
  ok(r.delta === 1 && r.winnerTeam === 1, '规则二 N=100');
}

// 7. 亮主
{
  const g = new E.Game({ decks: 2, rng: E.mulberry32(5) }).startRound();
  g.hands[0] = [29, 29, 52, 53]; // 红桃5 x2 + 双王
  g.level = 5;
  ok(g.declare(0, 2).ok, '两张红桃5可亮主');
  ok(g.trumpSuit === 2 && g.strength === 2, '亮主结果');
  ok(g.declareCards.length === 2 && g.declareCards.every(c => c === 29),
     '亮主记录用的牌（供出牌区展示）');
  ok(!g.declare(1, 2).ok, '张数不足不能反主');
  // 王牌无主
  const g2 = new E.Game({ decks: 2, rng: E.mulberry32(5) }).startRound();
  g2.hands[2] = [52, 53];
  ok(g2.declare(2, 4).ok, '双王可亮无主');
}

// 7a. 亮主/反主层级：张数优先，同张数王牌 > 级牌，大王 > 小王
{
  const g = new E.Game({ decks: 3, rng: E.mulberry32(7) }).startRound();
  g.level = 5;
  g.hands[0] = [29, 29, 29]; // 三张 ♥5
  ok(g.declare(0, 2).ok, '三张级牌可亮主');
  ok(g.bidRank === 30 && g.strength === 3, '三张级牌权重 30');

  g.hands[1] = [53, 53]; // 两张大王
  ok(!g.declare(1, 4).ok, '两张王反不过三张级牌');

  g.hands[1] = [53, 53, 53]; // 三张大王
  ok(g.declare(1, 4).ok, '三张王可反三张级牌');
  ok(g.bidRank === 32 && g.trumpSuit === 4, '三张大王权重 32');
  ok(g.declarer === 1 && g.declareCards.length === 3 && g.declareCards.every(c => c === 53),
     '反主后展示新的亮主牌');

  const p = new E.Game({ decks: 3, rng: E.mulberry32(8) }).startRound();
  p.level = 5;
  p.hands[0] = [29, 29]; // 一对 ♥5
  ok(p.declare(0, 2).ok, '一对级牌亮主');
  p.hands[1] = [53, 53]; // 一对大王
  ok(p.declare(1, 4).ok, '同张数王牌可反级牌');
  ok(p.bidRank === 22, '大王对权重 22');

  const q = new E.Game({ decks: 3, rng: E.mulberry32(9) }).startRound();
  q.level = 5;
  q.hands[0] = [29, 29];
  ok(q.declare(0, 2).ok, '一对级牌亮主');
  q.hands[1] = [29, 29]; // 同张数、同类型
  ok(!q.declare(1, 2).ok, '同张数同级牌不能反主');
}

// 7a2. AI 亮主：按手牌强度选花色，并会等待时机
{
  const g = new E.Game({ decks: 3, rng: E.mulberry32(4) }).startRound();
  g.level = 5;
  g.perPlayer = 39;
  g.trumpSuit = null;
  g.bidRank = 0;
  // 红桃极强：三张 ♥5 + 大量红桃 + 双王
  g.hands[1] = [29, 29, 29, 26, 27, 28, 30, 31, 32, 33, 34, 35, 36, 37, 52, 53, 0, 13];
  const pick = E.aiDeclare(g, 1);
  ok(pick && pick.suit === 2, 'AI 会选择红桃亮主，实际 ' + (pick && pick.suit));

  const early = new E.Game({ decks: 3, rng: E.mulberry32(6) }).startRound();
  early.level = 5;
  early.perPlayer = 39;
  early.trumpSuit = null;
  early.bidRank = 0;
  early.hands[2] = [29, 26, 13, 0]; // 只有一张级牌，且牌很少
  ok(E.aiDeclare(early, 2) === null, '发牌早期不急着用单张亮主');
}

// 7b. AI 策略与队友配合（只验证决策，不改变规则校验）
function scaffold(hands, ctx, opts) {
  opts = opts || {};
  const g = new E.Game({ decks: 1, rng: E.mulberry32(1) });
  g.ctx = ctx;
  g.trumpSuit = ctx.trumpSuit;
  g.level = ctx.topLevel;
  g.phase = 'play';
  g.hands = hands;
  g.trumpLeft = hands.map(h => h.filter(c => E.groupOf(ctx, c) === 4).length);
  g.voids = [{}, {}, {}, {}];
  g.seen = {};
  g.trick = opts.trick || [];
  g.lead = opts.lead || null;
  g.leader = opts.leader != null ? opts.leader : 0;
  g.turn = opts.turn != null ? opts.turn : 0;
  g.trickNo = opts.trickNo || 1;
  g.defenderPoints = 0;
  return g;
}

{
  const ctx = E.makeContext(2, 9, 0); // 主牌红桃，级牌 9；座位 0 的队友是 2
  const DK = 11, DA = 12, D4 = 2, D5 = 3, D7 = 5, D10 = 8;
  const filler = [[20, 21], [30, 40], [50, 51]];

  // 队友 ♦K 领跑，AI 有 ♦A 和 ♦4 时不应压队友
  const leadK = E.validateLead([DK], ctx).lead;
  let g = scaffold([[DA, D4], filler[0], filler[1], filler[2]], ctx,
                   { trick: [{ seat: 2, cards: [DK] }], lead: leadK, leader: 2 });
  let pick = E.aiChoose(g, 0);
  ok(pick.length === 1 && pick[0] === D4, '队友赢时不出大牌压队友');
  ok(E.validateFollow(g.hands[0], pick, leadK, ctx).ok, '队友配合选牌仍合法');

  // 末位且队友赢：把分牌贴给队友（♦10 而不是 ♦5）
  const lead5 = E.validateLead([D5], ctx).lead;
  g = scaffold([[D10, D5, D7], filler[0], filler[1], filler[2]], ctx,
               { trick: [{ seat: 1, cards: [D5] }, { seat: 2, cards: [DK] }, { seat: 3, cards: [D4] }],
                 lead: lead5, leader: 1 });
  pick = E.aiChoose(g, 0);
  ok(pick.length === 1 && pick[0] === D10, '末位队友赢时贴分');
  ok(E.validateFollow(g.hands[0], pick, lead5, ctx).ok, '贴分选牌仍合法');

  // 对手赢且有分：用最小代价抢（♦A 压 ♦K）
  g = scaffold([[DA, D4, D10], filler[0], filler[1], filler[2]], ctx,
               { trick: [{ seat: 3, cards: [DK] }], lead: leadK, leader: 3 });
  pick = E.aiChoose(g, 0);
  ok(pick.length === 1 && pick[0] === DA, '对手赢且有分时抢墩');
  ok(E.validateFollow(g.hands[0], pick, leadK, ctx).ok, '抢墩选牌仍合法');

  // 队友首出必大的 ♦A：AI 非末位也应把分牌跑给队友
  const leadA = E.validateLead([DA], ctx).lead;
  g = scaffold([filler[0], filler[1], [D10, D5, D4], filler[0]], ctx,
               { trick: [{ seat: 0, cards: [DA] }], lead: leadA, leader: 0, turn: 2 });
  pick = E.aiChoose(g, 2);
  ok(pick.length === 1 && pick[0] === D10, '队友必大时非末位也跑分，实际 ' + pick.map(E.cardName));
  ok(E.validateFollow(g.hands[2], pick, leadA, ctx).ok, '跑分选牌仍合法');

  // 对手已缺方块且有主牌能毙：队友的 ♦A 并不保险，不能白送分
  g = scaffold([filler[0], filler[1], [D10, D5, D4], filler[0]], ctx,
               { trick: [{ seat: 0, cards: [DA] }], lead: leadA, leader: 0, turn: 2 });
  g.voids[3][0] = true;
  g.trumpLeft[3] = 3;
  pick = E.aiChoose(g, 2);
  ok(pick.length === 1 && pick[0] === D4, '对手能毙时不出分牌，实际 ' + pick.map(E.cardName));
  ok(E.validateFollow(g.hands[2], pick, leadA, ctx).ok, '保守跟牌仍合法');

  // 队友首出必大的对子：AI 用同门对子跟足并贴分
  const leadPairA = E.validateLead([DA, DA], ctx).lead;
  g = scaffold([filler[0], filler[1], [D10, D10, D4], filler[0]], ctx,
               { trick: [{ seat: 0, cards: [DA, DA] }], lead: leadPairA, leader: 0, turn: 2 });
  g.decks = 2;
  pick = E.aiChoose(g, 2);
  ok(pick.length === 2 && pick.every(c => c === D10), '队友必大对子时贴分对子，实际 ' + pick.map(E.cardName));
  ok(E.validateFollow(g.hands[2], pick, leadPairA, ctx).ok, '对子贴分仍合法');

  // 缺门垫牌：队友必大时把别门的分牌垫给队友
  const S10 = 3 * 13 + 8, C4 = 1 * 13 + 2;
  const g5 = scaffold([filler[0], filler[1], [S10, C4], filler[0]], ctx,
                      { trick: [{ seat: 0, cards: [DA] }], lead: leadA, leader: 0, turn: 2 });
  pick = E.aiChoose(g5, 2);
  ok(pick.length === 1 && pick[0] === S10, '缺门时垫分牌给必大的队友，实际 ' + pick.map(E.cardName));
  ok(E.validateFollow(g5.hands[2], pick, leadA, ctx).ok, '垫分牌仍合法');
}

// 7b2. 毙牌决策：按墩面分与后手反毙概率决定是否毙、毙多大
{
  const ctx = E.makeContext(2, 9, 0); // 主牌红桃，级牌 9
  const DA = 12, DK = 11, D10 = 8;
  const leadA = E.validateLead([DA], ctx).lead;

  // 末位毙牌零风险：墩面 10 分应直接毙，且用最小主牌
  const last = scaffold([[DA], [DK], [D10], [26, 27, 28, 39, 40, 41]], ctx,
                        { trick: [{ seat: 0, cards: [DA] }, { seat: 1, cards: [DK] }, { seat: 2, cards: [D10] }],
                          lead: leadA, leader: 0, turn: 3 });
  let pick = E.aiChoose(last, 3);
  ok(pick.length === 1 && E.groupOf(ctx, pick[0]) === 4 && pick[0] === 26,
     '末位缺门有分时用最小主牌毙，实际 ' + pick.map(E.cardName));

  // 后手两家都能反毙、墩面无分：放弃毙牌改垫牌
  const risky = scaffold([[DA], [26, 39, 40], [41, 42], [43, 44]], ctx,
                         { trick: [{ seat: 0, cards: [DA] }], lead: leadA, leader: 0, turn: 1 });
  risky.voids[2][0] = true; risky.voids[3][0] = true;
  risky.trumpLeft[2] = 4; risky.trumpLeft[3] = 4;
  pick = E.aiChoose(risky, 1);
  ok(pick.length === 1 && E.groupOf(ctx, pick[0]) !== 4, '后手反毙风险高且无分时不毙，实际 ' + pick.map(E.cardName));

  // 墩面有分且后手反毙风险高：改用更大的主牌，用大王保赢
  const big = scaffold([[D10], [26, 38, 53, 39], [39, 40], [41, 42]], ctx,
                       { trick: [{ seat: 0, cards: [D10] }], lead: E.validateLead([D10], ctx).lead, leader: 0, turn: 1 });
  big.voids[2][0] = true; big.voids[3][0] = true;
  big.trumpLeft[2] = 5; big.trumpLeft[3] = 5;
  pick = E.aiChoose(big, 1);
  ok(pick.length === 1 && pick[0] === 53, '反毙风险高时用大王毙，实际 ' + pick.map(E.cardName));
}

// 7b5. 后手是否还持有该花色，决定毙牌力度：没人能反毙就用便宜主牌抢分
{
  const ctx = E.makeContext(2, 9, 0); // 红桃主，级牌 9
  const D10 = 8;                    // ♦10，墩面 10 分
  const lead10 = E.validateLead([D10], ctx).lead;

  // 后两家手里还有 ♦，不会毙：AI 用最小主牌 ♥2 拿下 10 分墩
  let g = scaffold([[0, 1], [26, 27, 38, 13, 14], [2, 3], [4, 5]], ctx,
                   { trick: [{ seat: 0, cards: [D10] }], lead: lead10, leader: 0, turn: 1 });
  let pick = E.aiChoose(g, 1);
  ok(pick.length === 1 && pick[0] === 26, '后手还有该花色时用最小主牌毙分牌，实际 ' + pick.map(E.cardName));

  // 只有队友缺门：队友不会反毙，仍用最小主牌
  g = scaffold([[0, 1], [26, 27, 38, 13, 14], [2, 3], [39, 40]], ctx,
               { trick: [{ seat: 0, cards: [D10] }], lead: lead10, leader: 0, turn: 1 });
  g.voids[3][0] = true; g.trumpLeft[3] = 5;
  pick = E.aiChoose(g, 1);
  ok(pick.length === 1 && pick[0] === 26, '只有队友缺门时不必上大牌，实际 ' + pick.map(E.cardName));

  // 对手确定缺门且有主牌反毙：用大王确保拿下有分的墩
  g = scaffold([[0, 1], [26, 27, 38, 53], [13, 14], [39, 40]], ctx,
               { trick: [{ seat: 0, cards: [D10] }], lead: lead10, leader: 0, turn: 1 });
  g.voids[2][0] = true; g.trumpLeft[2] = 4;
  pick = E.aiChoose(g, 1);
  ok(pick.length === 1 && pick[0] === 53, '对手确定缺门时用大王抢分，实际 ' + pick.map(E.cardName));

  // 对手缺门但已经没有主牌：反毙不了，回到最小主牌
  g = scaffold([[0, 1], [26, 27, 38, 13, 14], [15, 16], [39, 40]], ctx,
               { trick: [{ seat: 0, cards: [D10] }], lead: lead10, leader: 0, turn: 1 });
  g.voids[2][0] = true; g.trumpLeft[2] = 0;
  pick = E.aiChoose(g, 1);
  ok(pick.length === 1 && pick[0] === 26, '对手没主牌时用最小主牌毙，实际 ' + pick.map(E.cardName));
}

// 7b6. 出牌权：后期手里有必大的对子，即使墩面无分也主动抢下这一手
{
  const ctx = E.makeContext(2, 9, 0); // 红桃主，级牌 9
  const DK = 11, DA = 12, D2 = 0, D6 = 4, D7 = 5;
  const leadPair = E.validateLead([DK, DK], ctx).lead;

  // 手里对 A 必大：不贪便宜跟对 2，直接抢出牌权
  let g = scaffold([[DK, DK], [DA, DA, D2, D2, D7, D7], [4, 4], [6, 6]], ctx,
                   { trick: [{ seat: 0, cards: [DK, DK] }], lead: leadPair, leader: 0, turn: 1 });
  g.decks = 2;
  let pick = E.aiChoose(g, 1);
  ok(pick.length === 2 && pick.every(c => c === DA),
     '后期用必大对子抢出牌权，实际 ' + pick.map(E.cardName));

  // 队友已经必大：不抢队友的牌，跟最小的一对
  g = scaffold([[DK, DK], [D2, D2], [DA, DA, D6, D6], [D7, D7]], ctx,
               { trick: [{ seat: 0, cards: [DK, DK] }, { seat: 1, cards: [D2, D2] }],
                 lead: leadPair, leader: 0, turn: 2 });
  g.decks = 2;
  pick = E.aiChoose(g, 2);
  ok(pick.length === 2 && pick.every(c => c === D6),
     '队友必大时不抢队友的牌，实际 ' + pick.map(E.cardName));

  // 后期对子不是必大（外面还有对 K）也主动争：先手比省牌重要
  g = scaffold([[9, 9], [10, 10, 2, 2, 0, 0], [DK, DK], [D7, D7]], ctx,
               { trick: [{ seat: 0, cards: [9, 9] }],
                 lead: E.validateLead([9, 9], ctx).lead, leader: 0, turn: 1 });
  g.decks = 2;
  pick = E.aiChoose(g, 1);
  ok(pick.length === 2 && pick.every(c => c === 10),
     '后期对子主动争出牌权，实际 ' + pick.map(E.cardName));
}

// 7b7. 毙牌的战略价值：救回队友垫的分、掐掉对手的先手
{
  const ctx = E.makeContext(2, 9, 0); // 红桃主，级牌 9
  const DA = 12, D10 = 8, D2 = 0;
  const leadA = E.validateLead([DA], ctx).lead;

  // 队友先出 ♦10，被对手 ♦A 压住：AI 缺门，宁可花 ♥9 也要把这 10 分拿回来
  let g = scaffold([[D10], [DA], [33, 13, 14, 15], [26]], ctx,
                   { trick: [{ seat: 0, cards: [D10] }, { seat: 1, cards: [DA] }],
                     lead: leadA, leader: 0, turn: 2 });
  g.voids[3][0] = true; g.trumpLeft[3] = 1;
  let pick = E.aiChoose(g, 2);
  ok(pick.length === 1 && pick[0] === 33, '救回队友垫的分，实际 ' + pick.map(E.cardName));

  // 零分墩：对手正拿着这墩，AI 后期用小主牌抢回先手，阻止对手连续跑分
  g = scaffold([[D2], [DA], [38, 13, 14, 15], [26]], ctx,
               { trick: [{ seat: 0, cards: [D2] }, { seat: 1, cards: [DA] }],
                 lead: leadA, leader: 0, turn: 2 });
  g.voids[3][0] = true; g.trumpLeft[3] = 1;
  pick = E.aiChoose(g, 2);
  ok(pick.length === 1 && E.groupOf(ctx, pick[0]) === 4,
     '零分墩也用小主牌抢回先手，实际 ' + pick.map(E.cardName));
}

// 7b8. 三条跟牌：零分小墩先跟小的，有分才用大三条抢
{
  const ctx = E.makeContext(2, 9, 0); // 红桃主，级牌 9
  const D2 = 0, D3 = 1, D10 = 8, DA = 12;
  const lead3 = E.validateLead([D3, D3, D3], ctx).lead;
  const lead10 = E.validateLead([D10, D10, D10], ctx).lead;

  // 零分墩、手牌还多：手里同时有小三条和大三条，跟小的
  let g = scaffold([[D3, D3, D3], [D2, D2, D2, DA, DA, DA, 20, 21, 22, 23],
                   [4, 4, 4], [5, 5, 5]], ctx,
                   { trick: [{ seat: 0, cards: [D3, D3, D3] }], lead: lead3, leader: 0, turn: 1 });
  let pick = E.aiChoose(g, 1);
  ok(pick.every(c => c === D2), '三条零分墩跟小三条，实际 ' + pick.map(E.cardName));

  // 30 分墩：用大三条把分抢下来
  g = scaffold([[D10, D10, D10], [D2, D2, D2, DA, DA, DA, 20, 21, 22, 23],
               [4, 4, 4], [5, 5, 5]], ctx,
               { trick: [{ seat: 0, cards: [D10, D10, D10] }], lead: lead10, leader: 0, turn: 1 });
  pick = E.aiChoose(g, 1);
  ok(pick.every(c => c === DA), '三条有分墩用大三条抢分，实际 ' + pick.map(E.cardName));

  // 缺门、零分墩：不用主牌三条去毙，留着主牌
  g = scaffold([[D3, D3, D3], [26, 26, 26, 40, 41, 42, 43], [4, 4, 4], [5, 5, 5]], ctx,
               { trick: [{ seat: 0, cards: [D3, D3, D3] }], lead: lead3, leader: 0, turn: 1 });
  pick = E.aiChoose(g, 1);
  ok(pick.some(c => E.groupOf(ctx, c) !== 4), '三条零分墩不拿主牌三条毙，实际 ' + pick.map(E.cardName));
}

// 7b9. 跟牌按“我方赢下本墩的概率”决定出多少分
{
  const ctx = E.makeContext(2, 9, 0); // 红桃主，级牌 9
  const DA = 12, DK = 11, D10 = 8, D5 = 3, D4 = 2, D3 = 1, D2 = 0;
  const filler = [20, 21, 22, 23, 24];

  // 赢面为 0（对手 ♦A 赢、自己是末位）：只垫最小的没用牌，不送分
  let g = scaffold([[DA, ...filler], [D2, ...filler], [D3, ...filler],
                    [D10, D5, D4, ...filler]], ctx,
                   { trick: [{ seat: 0, cards: [DA] }, { seat: 2, cards: [D3] }],
                     lead: E.validateLead([DA], ctx).lead, leader: 0, turn: 3 });
  let pick = E.aiChoose(g, 3);
  ok(pick.length === 1 && pick[0] === D4, '赢面为 0 时跟最小的没用牌，实际 ' + pick.map(E.cardName));

  // 队友 ♦K 已经稳赢（两张 A 都出完）：把 ♦10 送过去
  g = scaffold([[DK, ...filler], [D3, ...filler],
                [D10, D5, D4, D2, ...filler], [D4, ...filler]], ctx,
               { trick: [{ seat: 0, cards: [DK] }, { seat: 1, cards: [D3] }],
                 lead: E.validateLead([DK], ctx).lead, leader: 0, turn: 2 });
  g.seen[DA] = 2;
  pick = E.aiChoose(g, 2);
  ok(pick.length === 1 && pick[0] === D10, '队友赢面大时送大分，实际 ' + pick.map(E.cardName));

  // 自己 ♦A 稳赢、墩面还有 5 分：同样能赢就顺手把 ♦10 打出去
  g = scaffold([[D5, ...filler], [D2, ...filler], [D3, ...filler],
                [DA, D10, D4, ...filler]], ctx,
               { trick: [{ seat: 0, cards: [D5] }, { seat: 1, cards: [D2] }, { seat: 2, cards: [D3] }],
                 lead: E.validateLead([D5], ctx).lead, leader: 0, turn: 3 });
  g.decks = 2;
  g.seen[DA] = 1;
  pick = E.aiChoose(g, 3);
  ok(pick.length === 1 && pick[0] === D10, '自己赢面大时顺带甩分，实际 ' + pick.map(E.cardName));
}

// 7b3. 主牌大小：大王 > 小王 > 主级牌 > 副级牌 > A > K ...
{
  const ctx = E.makeContext(2, 9, 0); // 红桃主，级牌 9
  const BIG = 53, SMALL = 52;
  const H9 = 33;                 // ♥9 主级牌
  const D9 = 7, C9 = 20, S9 = 46; // ♦9 ♣9 ♠9 副级牌
  const HA = 38, HK = 37;        // ♥A ♥K
  ok(E.orderOf(ctx, BIG) > E.orderOf(ctx, SMALL), '大王 > 小王');
  ok(E.orderOf(ctx, SMALL) > E.orderOf(ctx, H9), '小王 > 主级牌');
  ok(E.orderOf(ctx, H9) > E.orderOf(ctx, D9), '主级牌 > 副级牌');
  ok(E.orderOf(ctx, D9) === E.orderOf(ctx, S9), '副级牌同级');
  ok(E.orderOf(ctx, D9) > E.orderOf(ctx, HA), '副级牌 > 主花色 A');
  ok(E.orderOf(ctx, HA) > E.orderOf(ctx, HK), 'A > K');

  // 无主：所有级牌都算副级，彼此同级
  const nt = E.makeContext(4, 9, 0);
  ok(E.orderOf(nt, H9) === E.orderOf(nt, S9), '无主时级牌同级');
  ok(E.orderOf(nt, S9) > E.orderOf(nt, E.suitOf(S9) * 13 + 12), '无主时级牌 > 该门 A');

  // 两家都缺方块，用级牌毙：主级牌应压过副级牌
  const leadA = E.validateLead([12], ctx).lead;
  const trick = [{ seat: 0, cards: [12] }, { seat: 1, cards: [C9] }, { seat: 2, cards: [H9] }, { seat: 3, cards: [S9] }];
  ok(E.trickWinner(trick, leadA, ctx) === 2, '主级牌毙牌大于副级牌');
}

// 7b4. 跟牌尽量不拆对子：多副牌同一 id 也要能识别结构
{
  const ctx = E.makeContext(2, 9, 0); // 红桃主，级牌 9
  const S3 = 40, S5 = 42, S10 = 47, SJ = 48, SK = 50, SA = 51;
  const filler = [[20, 21], [22, 23], [24, 25]];

  // 墩面 10 分：有 ♠3 散牌可垫，不应拆 ♠J 对子
  let g = scaffold([[SJ, SJ, S3, 1, 15], filler[0], filler[1], filler[2]], ctx,
                   { trick: [{ seat: 3, cards: [S10] }], lead: E.validateLead([S10], ctx).lead, leader: 3 });
  g.decks = 2;
  let pick = E.aiChoose(g, 0);
  ok(pick.length === 1 && pick[0] === S3, '10 分墩不拆对子去赢，实际 ' + pick.map(E.cardName));

  // 墩面 15 分（K + 5）：允许拆 ♠A 对子抢分
  g = scaffold([filler[0], [21, 22], [SA, SA, S3, 1, 15], filler[2]], ctx,
               { trick: [{ seat: 3, cards: [SK] }, { seat: 1, cards: [S5] }],
                 lead: E.validateLead([SK], ctx).lead, leader: 3, turn: 2 });
  g.decks = 2;
  pick = E.aiChoose(g, 2);
  ok(pick.length === 1 && pick[0] === SA, '15 分墩允许拆对子抢分，实际 ' + pick.map(E.cardName));

  // 同门只有对子可跟：被迫拆开也必须合法
  g = scaffold([[SJ, SJ, 1, 15], filler[0], filler[1], filler[2]], ctx,
               { trick: [{ seat: 3, cards: [S10] }], lead: E.validateLead([S10], ctx).lead, leader: 3 });
  g.decks = 2;
  pick = E.aiChoose(g, 0);
  ok(pick.length === 1 && pick[0] === SJ, '无可替代时允许拆对子，实际 ' + pick.map(E.cardName));
  ok(E.validateFollow(g.hands[0], pick, g.lead, ctx).ok, '拆对子跟牌仍合法');
}

// 7c. 对局信息跟踪：缺门记录与主牌消耗
{
  const ctx = E.makeContext(2, 9, 0);
  const g = scaffold([[12], [13], [0], [1]], ctx, { turn: 0 });
  ok(g.play(0, [12]).ok, '首家出 ♦A');
  ok(g.play(1, [13]).ok, '东家无方块垫牌');
  ok(g.voids[1][0] === true, '无方块应记录为方块缺门');
  ok(g.voids[2][0] !== true, '未出牌的座位不应标记缺门');
  ok(g.trumpLeft[1] === 0 && g.trumpLeft[0] === 0, '主牌消耗统计');
}

// 7d. 扣底：优先做缺门，不埋主牌和分牌
{
  const ctx = E.makeContext(2, 7, 0); // 主牌红桃，级牌 7
  const hand = [
    0, 1,        // ♦2 ♦3（最短副牌门）
    18, 19,      // ♣7 ♣8
    42,          // ♠5（带分）
    31,          // ♥7（主牌级牌）
    51, 23       // ♠A ♣Q
  ];
  const picked = E.autoBury(hand, ctx, 4);
  ok(picked.length === 4, '扣底张数');
  ok(picked.every(c => E.groupOf(ctx, c) !== 4), '扣底不埋主牌');
  ok(picked.every(c => E.pointOf(c) === 0), '扣底不埋分牌');
  ok(picked.includes(0) && picked.includes(1), '扣底优先整门做缺门');
  ok(picked.every(c => hand.indexOf(c) >= 0), '扣底牌来自手牌');
}

// 7e. 出牌 AI：能识别“必大牌”并优先兑现分牌
{
  const ctx = E.makeContext(2, 9, 0);
  const filler = [[20, 21], [40, 41], [48, 49]];
  // 方块整门都在手上，♦10 已经是外面最大的分牌
  const g = scaffold([[8, 9, 10, 11, 12, 2, 20], filler[0], filler[1], filler[2]], ctx);
  const unitA = E.decompose([12], ctx)[0];
  const unitK = E.decompose([11], ctx)[0];
  ok(E.isBossUnit(g, 0, unitA), '♦A 在剩余牌中必大');
  const g2 = scaffold([[12], [11], filler[0], filler[1]], ctx);
  ok(!E.isBossUnit(g2, 1, unitK), '外面还有 ♦A 时 ♦K 不算必大');

  const pick = E.aiChoose(g, 0);
  ok(pick.length === 1 && pick[0] === 8, 'AI 优先兑现必大的 ♦10 分牌');
  ok(E.validateLead(pick, ctx, g.opponentHands(0)).ok, '必大牌首出仍合法');
}

// 7e2. 首出优先用三条/拖拉机抢出牌权：对手对子再大也压不住同结构
{
  const ctx = E.makeContext(2, 9, 0);
  const S3 = 40, SA = 51;
  const filler = [[20, 21], [22, 23], [24, 25]];

  // 三条 ♠3 与 ♠A 对子同门（3 副牌，外面还有更大的三条）：先打三条
  let g = scaffold([[S3, S3, S3, SA, SA, 20, 0], filler[0], filler[1], filler[2]], ctx);
  g.decks = 3;
  let pick = E.aiChoose(g, 0);
  ok(pick.length === 3 && pick.every(c => c === S3),
     '三条优先于对 A 首出抢出牌权，实际 ' + pick.map(E.cardName));

  // 拖拉机同理（2 副牌，外面还有更大的拖拉机）：四张连对先出
  const D4 = 2, D5 = 3, DA = 12, C2 = 13;
  g = scaffold([[D4, D4, D5, D5, DA, DA, C2], filler[0], filler[1], filler[2]], ctx);
  g.decks = 2;
  pick = E.aiChoose(g, 0);
  ok(pick.length === 4 && pick.every(c => c === D4 || c === D5),
     '拖拉机优先于对 A 首出抢出牌权，实际 ' + pick.map(E.cardName));
}

// 7f. AI 反主：对手亮主后，用更强花色反主
{
  const ctx = E.makeContext(2, 5, 0);
  const g = new E.Game({ decks: 3, rng: E.mulberry32(12) }).startRound();
  g.level = 5;
  g.perPlayer = 39;
  g.phase = 'deal';
  g.trumpSuit = 2;       // 对手已亮红桃对子
  g.bidRank = 20;
  g.declarer = 3;        // 对手
  g.hands[0] = [42, 42, 42, 39, 40, 41, 43, 44, 45, 46, 47, 48, 49, 50, 51, 26, 0];
  const pick = E.aiDeclare(g, 0);
  ok(pick && pick.suit === 3, 'AI 会用三张黑桃级牌反主，实际 ' + (pick && pick.suit));
}

// 8. AI 全自动对局（覆盖 2/3/4 副、两套升级规则）
function playOneRound(decks, rule, seed) {
  const g = new E.Game({ decks: decks, rule: rule, rng: E.mulberry32(seed) });
  g.startRound();
  let guard = 0;
  while (g.phase === 'deal') {
    g.dealStep(4);
    for (let s = 0; s < 4; s++) g.aiMaybeDeclare(s);
    if (++guard > 200) throw new Error('发牌死循环');
  }
  if (g.phase === 'bury') {
    const cards = E.autoBury(g.hands[g.bankerSeat], g.ctx, g.bottomN);
    const r = g.bury(g.bankerSeat, cards);
    ok(r.ok, '庄家扣底: ' + r.msg);
  }
  guard = 0;
  while (g.phase === 'play') {
    const seat = g.turn;
    const before = g.hands.reduce((s, h) => s + h.length, 0);
    const cards = E.aiChoose(g, seat);
    const r = g.play(seat, cards);
    if (!r.ok) {
      throw new Error('AI 非法出牌 seat=' + seat + ' cards=' + cards.map(E.cardName).join(',') +
        ' lead=' + (g.lead ? g.lead.cards.map(E.cardName).join(',') : '-') + ' msg=' + r.msg);
    }
    const after = g.hands.reduce((s, h) => s + h.length, 0);
    ok(after < before, '手牌总数应减少');
    if (++guard > 2000) throw new Error('出牌死循环');
  }
  ok(g.phase === 'roundEnd', '一局应正常结束');
  ok(g.roundResult && g.roundResult.delta >= 0, '结算结果');
  return g;
}

let rounds = 0;
for (const decks of [1, 2, 3, 4]) {
  for (const rule of [1, 2]) {
    for (let seed = 1; seed <= 20; seed++) {
      playOneRound(decks, rule, seed * 97 + decks * 13 + rule);
      rounds++;
    }
  }
}

console.log('engine self-test passed: ' + checks + ' assertions, ' + rounds + ' simulated rounds');
