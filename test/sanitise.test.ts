import { describe, expect, it } from 'vitest';
import { sanitiseEvent, scrubText } from '../src/sanitise.ts';

const KEY = 'test-pseudonym-key';

// Each line holds personal data or a secret. None of the listed values may survive scrubbing.
const PII_CORPUS: ReadonlyArray<{ line: string; leaks: string[] }> = [
  { line: 'login failed for alex.jenkins+test@example.co.uk', leaks: ['alex.jenkins', 'example.co.uk'] },
  { line: 'request from 203.0.113.42 blocked', leaks: ['203.0.113.42'] },
  { line: 'client 2001:db8:85a3::8a2e:370:7334 connected', leaks: ['2001:db8:85a3::8a2e:370:7334'] },
  { line: 'call back on 07700 900123 or +44 20 7946 0958', leaks: ['07700 900123', '20 7946 0958'] },
  { line: 'deliver to SW1A 1AA please', leaks: ['SW1A 1AA'] },
  { line: 'card 4111 1111 1111 1111 declined', leaks: ['4111 1111 1111 1111'] },
  { line: 'Authorization: Bearer abc.def-ghi_123', leaks: ['abc.def-ghi_123'] },
  { line: 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl rejected', leaks: ['eyJhbGciOiJIUzI1NiJ9'] },
  { line: 'using key sk-ant-api03-abcdefghijklmnop', leaks: ['abcdefghijklmnop'] },
  { line: 'gh token ghp_abcdefghijklmnopqrstuvwxyz0123456789', leaks: ['ghp_abcdefghijklmnop'] },
  { line: 'config password=hunter2 api_key: "s3cr3t"', leaks: ['hunter2', 's3cr3t'] },
  { line: 'fetch https://api.example.com/v1/pets?owner=alex&token=xyz failed', leaks: ['owner=alex', 'xyz'] },
  { line: 'db postgres://admin:pa55word@db.internal:5432/app', leaks: ['admin', 'pa55word'] },
  { line: 'player 76561198012345678 kicked', leaks: ['76561198012345678'] },
  { line: 'discord user 1568708022765883533 linked', leaks: ['1568708022765883533'] },
  { line: 'user 3f2b8c1e-9d4a-4b7e-8f1a-2c3d4e5f6a7b not found', leaks: ['3f2b8c1e-9d4a-4b7e-8f1a-2c3d4e5f6a7b'] },
  { line: 'session=abc123def456 expired', leaks: ['abc123def456'] },
  { line: 'AWS key AKIAIOSFODNN7EXAMPLE in env', leaks: ['AKIAIOSFODNN7EXAMPLE'] },
  { line: 'GET https://api.creatrgrid.com/api/v1/creators/paragonjenko', leaks: ['paragonjenko'] },
  { line: 'GET /api/v1/creators/alex-jenkins 404', leaks: ['alex-jenkins'] },
  { line: 'redirect to https://gaminginit.com/player/alexj#stats', leaks: ['alexj', 'stats'] },
];

describe('scrubText', () => {
  it.each(PII_CORPUS)('removes personal data and secrets: $line', async ({ line, leaks }) => {
    const scrubbed = await scrubText(line, KEY);
    leaks.forEach((leak) => expect(scrubbed).not.toContain(leak));
  });

  it('keeps ordinary error text readable', async () => {
    expect(await scrubText('TypeError: cannot read properties of undefined at 12:30:45', KEY)).toBe(
      'TypeError: cannot read properties of undefined at 12:30:45',
    );
  });

  it('keeps the host and known route words of a URL', async () => {
    expect(await scrubText('GET https://api.creatrgrid.com/api/v1/creators/paragonjenko?x=1', KEY)).toBe(
      'GET https://api.creatrgrid.com/api/v1/creators/:param?[query]',
    );
  });

  it('gives the same UUID the same tag, so one user can be followed', async () => {
    const uuid = '3f2b8c1e-9d4a-4b7e-8f1a-2c3d4e5f6a7b';
    const first = await scrubText(`user ${uuid} logged in`, KEY);
    const second = await scrubText(`user ${uuid.toUpperCase()} logged out`, KEY);
    const tag = /id_[0-9a-f]{8}/.exec(first)?.[0];
    expect(tag).toBeDefined();
    expect(second).toContain(tag);
  });

  it('gives different tags under a different key', async () => {
    const uuid = '3f2b8c1e-9d4a-4b7e-8f1a-2c3d4e5f6a7b';
    expect(await scrubText(uuid, KEY)).not.toBe(await scrubText(uuid, 'another-key'));
  });

  it('tags prefixed and hex ids, keeping the prefix', async () => {
    const scrubbed = await scrubText('[sync] failed acct_f02ea3fd42cb404c831deb30675c241e and f02ea3fd42cb404c831deb30675c241e', KEY);
    expect(scrubbed).toMatch(/^\[sync\] failed acct_[0-9a-f]{8} and id_[0-9a-f]{8}$/);
  });

  it('tags Steam IDs rather than deleting them', async () => {
    expect(await scrubText('player 76561198012345678 kicked', KEY)).toMatch(/^player steam_[0-9a-f]{8} kicked$/);
  });
});

describe('sanitiseEvent', () => {
  const raw = {
    timestamp: 1763100000000,
    level: 'ERROR',
    service: 'gateway',
    route: 'https://api.example.com/v1/users/3f2b8c1e-9d4a-4b7e-8f1a-2c3d4e5f6a7b/pets/42?email=a@b.com',
    status: 500,
    durationMs: 123.6,
    errorType: 'TypeError',
    message: 'failed for alex@example.com from 203.0.113.42',
    stack: [
      'TypeError: boom',
      '    at handler (/home/alex/app/src/routes/pets.ts:42:13)',
      '    at https://x.example/worker.js?token=abc:7:1',
    ].join('\n'),
    // None of these may come back.
    headers: { cookie: 'session=abc' },
    body: { email: 'alex@example.com' },
    ip: '203.0.113.42',
    userAgent: 'Mozilla/5.0',
  };

  it('returns only allowlisted fields, sanitised', async () => {
    expect(await sanitiseEvent(raw, KEY)).toEqual({
      timestamp: '2025-11-14T06:00:00.000Z',
      level: 'error',
      service: 'gateway',
      route: '/v1/users/:param/pets/:param',
      status: 500,
      durationMs: 124,
      errorType: 'TypeError',
      message: 'failed for [email] from [ip]',
      stack: ['src/routes/pets.ts:42', 'worker.js:7'],
    });
  });

  it('never returns a value from the raw event that is not on the allowlist', async () => {
    const serialised = JSON.stringify(await sanitiseEvent(raw, KEY));
    ['alex', 'example.com', '203.0.113.42', 'Mozilla', 'session', 'token=abc', '3f2b8c1e'].forEach((leak) =>
      expect(serialised).not.toContain(leak),
    );
  });

  it('keeps route templates that are already templates', async () => {
    const event = await sanitiseEvent({ timestamp: 0, route: '/api/v1/pets/:petId/images/{imageId}' }, KEY);
    expect(event.route).toBe('/api/v1/pets/:petId/images/{imageId}');
  });

  it('turns path segments that are not known route words into :param, so slugs never leave', async () => {
    const event = await sanitiseEvent({ timestamp: 0, route: '/api/v1/creators/paragonjenko' }, KEY);
    expect(event.route).toBe('/api/v1/creators/:param');
  });

  it('replaces an unrecognised error type with Error', async () => {
    const event = await sanitiseEvent({ timestamp: 0, errorType: 'alex@example.com' }, KEY);
    expect(event.errorType).toBe('Error');
  });

  it('drops a service name that is not a plain slug', async () => {
    const event = await sanitiseEvent({ timestamp: 0, service: 'Alex Jenkins laptop' }, KEY);
    expect(event.service).toBeUndefined();
  });

  it('cuts long messages to 500 characters', async () => {
    const event = await sanitiseEvent({ timestamp: 0, message: 'x'.repeat(2000) }, KEY);
    expect(event.message).toHaveLength(500);
  });

  it('rejects an event without a valid timestamp', async () => {
    await expect(sanitiseEvent({ timestamp: 'not a date', message: 'hi' }, KEY)).rejects.toThrow();
    await expect(sanitiseEvent({ message: 'hi' }, KEY)).rejects.toThrow();
  });
});
