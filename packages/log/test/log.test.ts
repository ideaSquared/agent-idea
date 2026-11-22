import { describe, expect, it, vi } from 'vitest';
import { createLogger, memorySink } from '../src/index.ts';

const FIELDS = ['accountId', 'platform', 'count', 'requestId'] as const;

function setup(level?: 'debug' | 'info' | 'warn' | 'error') {
  const sink = memorySink();
  const log = createLogger({ service: 'creatorgrid-api', fields: FIELDS, level, sink });
  return { log, events: sink.events };
}

describe('createLogger', () => {
  it('logs the fixed message and declared fields', () => {
    const { log, events } = setup();
    log.info('sync processed', { platform: 'youtube', count: 3 });
    expect(events).toEqual([
      {
        timestamp: expect.any(String),
        level: 'info',
        service: 'creatorgrid-api',
        message: 'sync processed',
        meta: { platform: 'youtube', count: 3 },
      },
    ]);
  });

  it('drops undeclared fields and counts them', () => {
    const { log, events } = setup();
    // An undeclared field from untyped code is dropped at run time too.
    const fromJs = { platform: 'youtube', email: 'alex@example.com' } as Record<string, string>;
    log.info('sync processed', fromJs);
    expect(events[0]?.meta).toEqual({ platform: 'youtube' });
    expect(events[0]?.dropped).toBe(1);
    expect(JSON.stringify(events)).not.toContain('alex@example.com');
  });

  it('drops values that are not plain, so a whole object is never dumped', () => {
    const { log, events } = setup();
    const user = { id: 'u1', email: 'alex@example.com' };
    log.info('sync processed', { accountId: user as unknown as string });
    expect(events[0]?.meta).toBeUndefined();
    expect(events[0]?.dropped).toBe(1);
  });

  it('cuts long strings', () => {
    const { log, events } = setup();
    log.info('sync processed', { platform: 'x'.repeat(1000) });
    expect(events[0]?.meta?.platform).toHaveLength(200);
  });

  it('refuses to declare a field that holds personal data or a secret', () => {
    [
      'email',
      'userEmail',
      'phone',
      'name',
      'displayName',
      'address',
      'postcode',
      'ip',
      'password',
      'apiToken',
      'sessionId',
      'steamId',
    ].forEach((field) => expect(() => createLogger({ service: 's', fields: [field] })).toThrow(field));
  });

  it('allows the short list of harmless names the rule would otherwise catch', () => {
    expect(() => createLogger({ service: 's', fields: ['hostname', 'filename', 'pathname'] })).not.toThrow();
    expect(() => createLogger({ service: 's', fields: ['playerName'] })).toThrow('playerName');
  });

  it('allows ids and ordinary fields', () => {
    expect(() =>
      createLogger({ service: 's', fields: ['userId', 'accountId', 'platform', 'status', 'count'] }),
    ).not.toThrow();
  });

  it('records an error with its type, message and stack', () => {
    const { log, events } = setup();
    log.error('sync failed', { accountId: 'acct_1' }, new TypeError('boom'));
    expect(events[0]?.error).toMatchObject({
      type: 'TypeError',
      message: 'boom',
      stack: expect.stringContaining('TypeError'),
    });
  });

  it('records a thrown non-error as text', () => {
    const { log, events } = setup();
    log.error('sync failed', {}, 'timeout');
    expect(events[0]?.error).toEqual({ type: 'string', message: 'timeout' });
  });

  it('carries context from with() on every event, letting each call override it', () => {
    const { log, events } = setup();
    const request = log.with({ requestId: 'r1', platform: 'youtube' });
    request.info('sync started');
    request.info('sync processed', { platform: 'tiktok' });
    expect(events.map((event) => event.meta)).toEqual([
      { requestId: 'r1', platform: 'youtube' },
      { requestId: 'r1', platform: 'tiktok' },
    ]);
  });

  it('skips events below the level', () => {
    const { log, events } = setup('warn');
    log.debug('noise');
    log.info('noise');
    log.warn('kept');
    expect(events.map((event) => event.message)).toEqual(['kept']);
  });

  it('writes one JSON line to the console at the matching level by default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createLogger({ service: 's', fields: ['count'] }).warn('slow', { count: 2 });
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      level: 'warn',
      message: 'slow',
      meta: { count: 2 },
    });
    warn.mockRestore();
  });
});
