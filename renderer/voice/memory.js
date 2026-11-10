/* 本地聊天记忆：按月 JSONL 落盘，提供最近对话与长期事实卡。
 * 存储层可替换（Node 文件 / 浏览器 localStorage / IPC），记忆逻辑不变。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VoiceMemory = factory();
})(this, function () {
  'use strict';

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function monthTag(ts) {
    var d = new Date(ts || Date.now());
    return d.getFullYear() + '-' + pad(d.getMonth() + 1);
  }

  // Node 端文件存储：按月分文件，一行一条记录
  function createFileStore(dir, fs, path) {
    fs = fs || require('fs');
    path = path || require('path');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 已存在 */ }

    return {
      append: function (rec) {
        var file = path.join(dir, 'chat-' + monthTag(rec.ts) + '.jsonl');
        fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
      },
      readAll: function () {
        var out = [];
        fs.readdirSync(dir).filter(function (f) { return /^chat-\d{4}-\d{2}\.jsonl$/.test(f); })
          .sort()
          .forEach(function (f) {
            var lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
            for (var i = 0; i < lines.length; i++) {
              if (!lines[i].trim()) continue;
              try { out.push(JSON.parse(lines[i])); } catch (e) { /* 跳过坏行 */ }
            }
          });
        return out;
      },
      clear: function () {
        fs.readdirSync(dir).forEach(function (f) {
          if (/^chat-\d{4}-\d{2}\.jsonl$/.test(f)) fs.unlinkSync(path.join(dir, f));
        });
      }
    };
  }

  function createMemory(store, opt) {
    opt = opt || {};
    var facts = opt.facts || {};   // { key: value } 长期事实卡
    var maxRecent = opt.maxRecent || 12;

    return {
      record: function (role, text) {
        if (!text) return null;
        var rec = { ts: Date.now(), session: opt.sessionId || null, role: role, text: text };
        store.append(rec);
        return rec;
      },
      recent: function (n) {
        var all = store.readAll();
        return all.slice(Math.max(0, all.length - (n || maxRecent)));
      },
      facts: function () { return facts; },
      setFact: function (k, v) { facts[k] = v; },
      clear: function () { store.clear(); }
    };
  }

  // 组装注入给大模型的上下文：人设 + 长期事实 + 最近若干轮
  function buildPrompt(opt) {
    var lines = [];
    lines.push('【角色】' + (opt.persona || '你是一位耐心的粤语陪聊伙伴。'));
    var fk = Object.keys(opt.facts || {});
    if (fk.length) {
      lines.push('【已知信息】');
      fk.forEach(function (k) { lines.push('- ' + k + '：' + opt.facts[k]); });
    }
    var recent = opt.recent || [];
    if (recent.length) {
      lines.push('【最近对话】');
      recent.forEach(function (r) {
        lines.push((r.role === 'user' ? '老人：' : '你：') + r.text);
      });
    }
    lines.push('【要求】粤语口语回答，一次只说一到两句，语速放慢；不确定时先确认再回答。');
    return lines.join('\n');
  }

  return {
    createFileStore: createFileStore,
    createMemory: createMemory,
    buildPrompt: buildPrompt,
    monthTag: monthTag
  };
});
