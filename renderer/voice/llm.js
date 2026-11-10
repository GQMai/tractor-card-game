/* 远端大模型客户端（OpenAI 兼容 chat/completions 流式接口）。
 *
 * 兼容 DeepSeek（https://api.deepseek.com）、火山方舟（https://ark.cn-beijing.volces.com/api/v3）
 * 等任意 OpenAI 风格服务，baseUrl 配到 /v1 或 /api/v3 都能自动补 /chat/completions。
 *
 * 只处理「文本进、文本流出」，不含对话记忆（记忆在 memory.js）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VoiceLlm = factory();
})(this, function () {
  'use strict';

  function endpoint(baseUrl) {
    var base = String(baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
    if (/\/chat\/completions$/.test(base)) return base;
    return base + '/chat/completions';
  }

  /* cfg: { baseUrl, apiKey, model, temperature, maxTokens, timeoutMs }
   * opts: { system, messages, onDelta(text), onDone(fullText), onError(err) }
   * 返回 { abort() }
   */
  function createLlm(cfg) {
    var https = require('https');
    var http = require('http');
    var url = new URL(endpoint(cfg.baseUrl));
    var lib = url.protocol === 'http:' ? http : https;

    return {
      chat: function (opts) {
        var body = JSON.stringify({
          model: cfg.model || 'deepseek-chat',
          messages: [{ role: 'system', content: opts.system || '' }].concat(opts.messages || []),
          stream: true,
          temperature: cfg.temperature === undefined ? 0.8 : cfg.temperature,
          max_tokens: cfg.maxTokens || 200
        });

        var aborted = false;
        var full = '';
        var req = null;

        var promise = new Promise(function (resolve, reject) {
          req = lib.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'http:' ? 80 : 443),
            path: url.pathname + (url.search || ''),
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer ' + (cfg.apiKey || ''),
              Accept: 'text/event-stream',
              'Content-Length': Buffer.byteLength(body)
            },
            timeout: cfg.timeoutMs || 30000
          }, function (res) {
            if (res.statusCode !== 200) {
              var errBody = '';
              res.setEncoding('utf8');
              res.on('data', function (d) { errBody += d; });
              res.on('end', function () {
                reject(new Error('LLM HTTP ' + res.statusCode + ': ' + errBody.slice(0, 300)));
              });
              return;
            }
            res.setEncoding('utf8');
            var buf = '';
            res.on('data', function (chunk) {
              buf += chunk;
              var lines = buf.split('\n');
              buf = lines.pop();
              for (var i = 0; i < lines.length; i++) {
                var line = lines[i].trim();
                if (!line || line.indexOf('data:') !== 0) continue;
                var data = line.slice(5).trim();
                if (data === '[DONE]') continue;
                var msg;
                try { msg = JSON.parse(data); } catch (e) { continue; }
                var delta = msg.choices && msg.choices[0] && msg.choices[0].delta;
                var text = delta && delta.content;
                if (text) {
                  full += text;
                  if (opts.onDelta) opts.onDelta(text);
                }
              }
            });
            res.on('end', function () {
              if (aborted) return reject(new Error('aborted'));
              var cleaned = full.trim();
              if (opts.onDone) opts.onDone(cleaned);
              resolve(cleaned);
            });
            res.on('error', function (err) { reject(err); });
          });

          req.on('timeout', function () { req.destroy(new Error('LLM 超时')); });
          req.on('error', function (err) {
            if (aborted) return reject(new Error('aborted'));
            if (opts.onError) opts.onError(err);
            reject(err);
          });
          req.end(body);
        });

        return {
          promise: promise,
          get text() { return full; },
          abort: function () {
            aborted = true;
            try { req && req.destroy(); } catch (e) { /* 忽略 */ }
          }
        };
      }
    };
  }

  return { createLlm: createLlm, endpoint: endpoint };
});
