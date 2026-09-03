import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildApiUrl,
  csvCell,
  evaluatePlayerApiPayload,
  normalizeHost,
  parsePlaylistText,
} from '../lib/playlist.ts';

void test('parses common host, user, and password formats', () => {
  const results = parsePlaylistText(`
    https://one.example:8443 | alice | secret
    HOST: https://two.example
    USER: bob
    PASS: example-pass
  `);

  assert.equal(results.length, 2);
  assert.deepEqual(
    results.map(({ host, user, pass }) => ({ host, user, pass })),
    [
      { host: 'https://one.example:8443', user: 'alice', pass: 'secret' },
      { host: 'https://two.example', user: 'bob', pass: 'example-pass' },
    ],
  );
});

void test('parses and decodes an M3U URL without retaining its path', () => {
  const [result] = parsePlaylistText(
    'https://media.example/get.php?username=alice%40example.com&password=a%2Bb&type=m3u_plus',
  );

  assert.equal(result.host, 'https://media.example');
  assert.equal(result.user, 'alice@example.com');
  assert.equal(result.pass, 'a+b');
});

void test('rejects localhost, private networks, and executable URL schemes', () => {
  assert.equal(normalizeHost('http://127.0.0.1:8080'), null);
  assert.equal(normalizeHost('https://192.168.1.20'), null);
  assert.equal(normalizeHost('http://[::ffff:7f00:1]'), null);
  assert.equal(normalizeHost('http://[feb0::1]'), null);
  assert.equal(normalizeHost('https://service.local'), null);
  assert.equal(normalizeHost('javascript:alert(1)'), null);
});

void test('interprets active player API responses without exposing raw data', () => {
  assert.deepEqual(
    evaluatePlayerApiPayload(
      {
        user_info: {
          auth: 1,
          status: 'Active',
          active_cons: '2',
          max_connections: '4',
          exp_date: '2000000000',
        },
        server_info: { sensitive: 'not returned' },
      },
      1,
    ),
    {
      status: 'working',
      active: 2,
      max: 4,
      expiry: 2_000_000_000_000,
    },
  );
});

void test('encodes credentials before constructing API URLs', () => {
  const [candidate] = parsePlaylistText(
    'https://media.example | alice | </script><script>alert(1)</script>',
  );
  const url = buildApiUrl(candidate);

  assert.equal(url.includes('<script>'), false);
  assert.equal(new URL(url).searchParams.get('username'), 'alice');
});

void test('neutralizes spreadsheet formulas in CSV cells', () => {
  assert.equal(
    csvCell('=HYPERLINK("https://example.com")'),
    '"\'=HYPERLINK(""https://example.com"")"',
  );
  assert.equal(csvCell('safe value'), '"safe value"');
});
