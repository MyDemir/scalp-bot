'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
assert.doesNotThrow(() => new vm.Script(source), 'server.js must parse before dashboard security checks');
const helper = source.match(/function escapeHtml\(str\) \{[\s\S]*?\n    \}/);
assert(helper, 'dashboard must define an HTML escaping helper');

const escapeHtml = vm.runInNewContext('(' + helper[0] + ')');
const payload = `"><img src=x onerror='alert(1)'>&`;
assert.strictEqual(
  escapeHtml(payload),
  '&quot;&gt;&lt;img src=x onerror=&#39;alert(1)&#39;&gt;&amp;',
  'HTML text and attribute metacharacters must be escaped'
);

for (const token of [
  'escapeHtml(b.name)',
  'escapeHtml(b.telegram ||',
  'escapeHtml(b.lastSignal ||',
  'escapeHtml(k)',
  'escapeHtml(v)',
  'escapeHtml(l.tag)',
  'escapeHtml(t.symbol)',
  'escapeHtml(t.name)',
  'escapeHtml(label)',
  'tgHtml(r.text',
  'escapeHtml(shown)',
]) {
  assert(source.includes(token), `dashboard must escape untrusted field: ${token}`);
}
const tgHelper = source.match(/function tgHtml\(str\) \{[\s\S]*?\n    \}/);
assert(tgHelper, 'dashboard must define a Telegram-HTML sanitizer');
// Kaynak sunucu tarafı şablon dizgesinde: tarayıcıya giden hâli için \\ → \ çevrilir.
const tgHtml = vm.runInNewContext(helper[0] + ';(' + tgHelper[0].replace(/\\\\/g, '\\') + ')');
assert.strictEqual(tgHtml('<b>RSI</b> <img src=x onerror=alert(1)> <a href="javascript:x">l</a>'), '<b>RSI</b> &lt;img src=x onerror=alert(1)&gt; l', 'only b/i/u/code/pre survive');
assert(!source.includes('deleteBot('), 'read-only dashboard must not offer bot deletion');
console.log('PASS: dashboard HTML escaping (bots, logs, cards, touches, read-only settings)');
