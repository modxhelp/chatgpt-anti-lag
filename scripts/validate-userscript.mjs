import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const file = new URL('../chatgpt-anti-lag.user.js', import.meta.url);
const source = await readFile(file, 'utf8');
const headerMatch = source.match(/\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/);
assert(headerMatch, 'Userscript metadata block is missing');

const header = headerMatch[1];
const metadata = new Map();
for (const line of header.split(/\r?\n/)) {
  const match = line.match(/^\/\/\s+(@\S+)(?:\s+(.*))?$/);
  if (!match) continue;
  const [, key, value = ''] = match;
  const values = metadata.get(key) ?? [];
  values.push(value.trim());
  metadata.set(key, values);
}

const one = (key) => {
  const values = metadata.get(key) ?? [];
  assert.equal(values.length, 1, `${key} must occur exactly once`);
  return values[0];
};

assert.equal(one('@name'), 'ChatGPT Anti-Lag Archive');
assert.equal(one('@namespace'), 'https://chatgpt.com/');
assert.match(one('@version'), /^\d+\.\d+\.\d+$/);
assert.equal(one('@license'), 'MIT');
assert.equal(one('@updateURL'), 'https://raw.githubusercontent.com/modxhelp/chatgpt-anti-lag/main/chatgpt-anti-lag.user.js');
assert.equal(one('@downloadURL'), 'https://raw.githubusercontent.com/modxhelp/chatgpt-anti-lag/main/chatgpt-anti-lag.user.js');
assert((metadata.get('@match') ?? []).includes('https://chatgpt.com/*'));
assert((metadata.get('@match') ?? []).includes('https://chat.openai.com/*'));
assert.equal((metadata.get('@require') ?? []).length, 0, 'External @require dependencies are not allowed');
assert.equal((metadata.get('@connect') ?? []).length, 0, 'Network @connect permissions are not allowed');
assert.equal((metadata.get('@noframes') ?? []).length, 1, '@noframes is required');

const forbiddenPatterns = [
  [/\beval\s*\(/, 'eval()'],
  [/\bnew\s+Function\s*\(/, 'new Function()'],
  [/\bGM_xmlhttpRequest\b/, 'GM_xmlhttpRequest'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bfetch\s*\(/, 'fetch()'],
];
for (const [pattern, label] of forbiddenPatterns) {
  assert(!pattern.test(source), `${label} is not allowed in this local-only userscript`);
}

for (const marker of [
  "dbName: 'cgAntiLagArchiveDB'",
  "chatsStore: 'chats'",
  "messagesStore: 'messages'",
  'BroadcastChannel',
  'navigator.locks',
  'transaction',
  'sanitizeElementTree',
]) {
  assert(source.includes(marker), `Expected implementation marker is missing: ${marker}`);
}

console.log('Userscript metadata and static safety checks passed.');
