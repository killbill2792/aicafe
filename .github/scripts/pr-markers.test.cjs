'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseRepoMarker, parseChatUrl, validateRepo } = require('./pr-markers.cjs');

test('matching repository and task pass', () => {
  assert.deepEqual(parseRepoMarker('note\n<!-- repo: killbill2792/studio task: SAFETY-1 -->'), {
    repo: 'killbill2792/studio', task: 'SAFETY-1', ambiguous: false
  });
  assert.equal(validateRepo('<!-- repo: killbill2792/studio task: 42 -->', 'killbill2792/studio').status, 'success');
});
test('mismatch fails with both repository names', () => {
  assert.deepEqual(validateRepo('<!-- repo: killbill2792/aicafe task: 42 -->', 'killbill2792/studio'), {
    status: 'failure', message: 'This PR says it belongs to killbill2792/aicafe but is in killbill2792/studio'
  });
});
test('missing or incomplete marker only warns', () => {
  for (const body of ['', 'ordinary Dependabot PR', '<!-- repo: owner/repo -->']) {
    assert.equal(validateRepo(body, 'owner/repo').status, 'warning');
  }
});
test('conflicting markers fail rather than accepting the first one', () => {
  assert.equal(validateRepo('<!-- repo: a/b task: 1 -->\n<!-- repo: c/d task: 2 -->', 'a/b').status, 'failure');
});
test('extracts optional real chat URL and rejects unrelated URLs', () => {
  assert.equal(parseChatUrl('<!-- aicafe-chat-url https://chatgpt.com/c/abc-123 -->'), 'https://chatgpt.com/c/abc-123');
  assert.equal(parseChatUrl('<!-- aicafe-chat-url https://chatgpt.com/g/project/c/abc -->'), 'https://chatgpt.com/g/project/c/abc');
  assert.equal(parseChatUrl('<!-- aicafe-chat-url https://evil.example/x -->'), null);
});
