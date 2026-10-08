import { test } from 'node:test';
import assert from 'node:assert/strict';
import { productionHostname } from '../src/lib/production-hostname.ts';

test('local builds need no production hostname; production containers require one', () => {
  assert.equal(productionHostname(undefined), undefined);
  assert.equal(productionHostname(''), undefined);
  assert.throws(() => productionHostname(undefined, true), /required/);
  assert.throws(() => productionHostname('', true), /required/);
  assert.equal(productionHostname('COMPETITION.acme.io', true), 'competition.acme.io');
});

test('production hostname rejects malformed inputs and reserved placeholders', () => {
  for (const hostname of [
    'competition.example.com',
    'example.net',
    'a.example.org',
    'app.invalid',
    'app.test',
    'app.localhost',
    'app.example',
    '127.0.0.1',
    'https://acme.io',
    'acme.io:443',
    'acme.io/path',
    'acme.io\n',
    '-acme.io',
    `${'x'.repeat(64)}.io`,
    'acme.io.',
  ])
    assert.throws(() => productionHostname(hostname, true), /PRODUCTION_HOSTNAME/);
});
