/* 生成网页版到 docs/（GitHub Pages 直接发布这个目录）
 *
 * 与 Electron 版共用同一套规则内核和界面，只去掉语音相关脚本、语音按钮与状态浮层：
 * 网页版跑在公网，语音要调豆包 ASR / LLM / Edge TTS，密钥和 WebSocket 都放不出去，
 * 也不适合把老人家的聊天记录发到远端。
 *
 * 用法：node tools/build-web.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'renderer');
const out = path.join(root, 'docs');

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

// 递归复制目录（不用 fs.cpSync：部分 Windows 环境下会直接崩掉）
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  fs.readdirSync(from, { withFileTypes: true }).forEach(function (e) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  });
}

// 1) 清空旧产物
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// 2) 脚本、样式、牌面资源
['styles.css', 'engine.js', 'game.js'].forEach(function (f) {
  copyFile(path.join(src, f), path.join(out, f));
});
copyDir(path.join(src, 'assets'), path.join(out, 'assets'));
copyDir(path.join(root, 'assets'), path.join(out, 'assets'));

// 3) 页面：去掉语音入口和语音脚本（兼容 CRLF）
let html = fs.readFileSync(path.join(src, 'index.html'), 'utf8');

const removed = [
  /[ \t]*<button[^>]*id="btnVoice"[^>]*>[^<]*<\/button>\r?\n/g,
  /[ \t]*<div id="voiceBar"[^>]*>\r?\n(?:[ \t]*<div[^>]*>[^<]*<\/div>\r?\n){2}[ \t]*<\/div>\r?\n(?:\r?\n)?/g,
  /[ \t]*<script src="voice-ui\.js"><\/script>\r?\n/g,
  /[ \t]*<script src="reminder\.js"><\/script>\r?\n/g
];
removed.forEach(function (re) {
  if (!re.test(html)) throw new Error('页面结构与预期不符，未匹配：' + re);
  html = html.replace(re, '');
});

// 移动端视口 + 站点图标
html = html.replace(
  '<meta charset="UTF-8">',
  '<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">'
);
html = html.replace(
  '<link rel="stylesheet" href="styles.css">',
  '<link rel="stylesheet" href="styles.css">\n<link rel="icon" href="assets/tractor.ico">'
);

fs.writeFileSync(path.join(out, 'index.html'), html);

// 4) 关掉 Jekyll，避免以 _ 开头的文件被忽略
fs.writeFileSync(path.join(out, '.nojekyll'), '');

const files = [];
(function walk(dir) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(p);
  });
})(out);
const size = files.reduce(function (s, f) { return s + fs.statSync(f).size; }, 0) / 1024;
console.log('网页版已生成：docs/（' + files.length + ' 个文件，' + size.toFixed(0) + ' KB）');
