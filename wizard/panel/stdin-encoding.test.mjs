// stdin-encoding.test.mjs — every secret-carrying verb decodes EXACTLY ONCE.
//
// The bug this pins (found 2026-08-09): telegram-verify's command piped stdin
// through `base64 -d` while telegram-link.mjs ALSO base64-decodes its stdin. Two
// decodes means every real pasted token turned to garbage and failed shape
// validation — while the tests stayed green, because they call the script
// directly and so only ever saw one decode. The contract now: comms scripts own
// their decoding, verbs pass base64 through untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEMBER_VERBS } from './panel-server.mjs';

const SELF_DECODING = {
  'telegram-verify': { token_b64: 'QUJD' },
  'mcp-add-custom': { def_b64: 'QUJD' },
  'mcp-token-set': { payload_b64: 'QUJD' },
  'mcp-add-google': { payload_b64: 'QUJD' },
  'mcp-token-set-google': { payload_b64: 'QUJD' },
};

test('verbs for self-decoding scripts never pre-decode the stdin', () => {
  for (const [verb, args] of Object.entries(SELF_DECODING)) {
    const spec = MEMBER_VERBS[verb].build(args);
    assert.ok(spec.stdin, `${verb} carries stdin`);
    assert.doesNotMatch(spec.command, /base64\s+-d/,
      `${verb}: piping through base64 -d makes the script's own decode a double decode`);
    assert.match(spec.stdin, /^[A-Za-z0-9+/=]+\n$/, `${verb}: stdin is the untouched base64`);
  }
});

test('every mcp verb still survives a box that predates its script', () => {
  for (const v of ['mcp-status', 'mcp-add', 'mcp-remove', 'mcp-add-custom',
    'mcp-token-set', 'mcp-token-forget', 'mcp-add-google', 'mcp-token-set-google']) {
    const cmd = MEMBER_VERBS[v].build({ key: 'notion', def_b64: 'QUJD', payload_b64: 'QUJD' }).command;
    assert.match(cmd, /box-too-old/, `${v} must degrade in words, not a stack trace`);
  }
});

test('a hostile service name is refused before it reaches a shell word', () => {
  for (const key of ['a;rm -rf /', '../etc', 'UPPER', 'x', '$(whoami)']) {
    assert.throws(() => MEMBER_VERBS['mcp-token-forget'].build({ key }), /service name/i, JSON.stringify(key));
  }
});
