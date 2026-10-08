import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoInviteUrl } from '../src/lib/demo-invite.ts';

test('production invitations use the configured HTTPS site rather than an internal request host', () => {
  const url = new URL(
    demoInviteUrl(
      new URL('http://127.0.0.1:4321/demo/admin'),
      'room',
      'token',
      'https://rally.acme.com',
    ),
  );
  assert.equal(url.origin, 'https://rally.acme.com');
  assert.equal(url.pathname, '/demo');
  assert.equal(url.searchParams.get('room'), 'room');
  assert.equal(url.searchParams.get('invite'), 'token');
});

test('localhost invitations preserve HTTP and the selected port without a production hostname', () => {
  for (const origin of ['http://localhost:4321', 'http://127.0.0.1:4340']) {
    const url = new URL(
      demoInviteUrl(new URL(`${origin}/demo/admin?unrelated=1`), 'room', 'token', ''),
    );
    assert.equal(url.origin, origin);
    assert.equal(url.pathname, '/demo');
    assert.equal(url.searchParams.has('unrelated'), false);
    assert.equal(url.searchParams.get('invite'), 'token');
  }
});
