import { describe, expect, it } from 'vitest';
import { parseArgs, validateArgs } from '../src/index.ts';
import type { Field } from '../src/index.ts';

const fields: Field[] = [
  { name: 'accountId', type: 'id', required: true, description: '', positional: true },
  { name: 'platform', type: 'enum', required: false, description: '', values: ['youtube', 'tiktok'] },
  { name: 'limit', type: 'number', required: false, description: '' },
  { name: 'force', type: 'boolean', required: false, description: '' },
  { name: 'note', type: 'string', required: false, description: '' },
];

const invalid = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof Error
      ? { name: error.name, message: error.message, code: (error as { code?: string }).code }
      : null;
  }
  return null;
};

describe('validateArgs', () => {
  it('returns the validated args', () => {
    expect(validateArgs(fields, { accountId: 'acct_1', limit: 3, force: false })).toEqual({
      accountId: 'acct_1',
      limit: 3,
      force: false,
    });
  });

  it.each([
    [{}, "field 'accountId' is required"],
    [{ accountId: 'a b' }, "field 'accountId' must be an id"],
    [{ accountId: 'a', platform: 'vimeo' }, "field 'platform' must be one of: youtube, tiktok"],
    [{ accountId: 'a', limit: '3' }, "field 'limit' must be a number"],
    [{ accountId: 'a', limit: Infinity }, "field 'limit' must be a number"],
    [{ accountId: 'a', force: 'yes' }, "field 'force' must be true or false"],
    [{ accountId: 'a', note: 5 }, "field 'note' must be a string"],
    [{ accountId: 'a', surprise: 1 }, "unknown field 'surprise'"],
    [{ accountId: null }, "field 'accountId' must be an id"],
  ])('rejects %j naming the field', (args, message) => {
    const error = invalid(() => validateArgs(fields, args));
    expect(error?.code).toBe('invalid_argument');
    expect(error?.message).toContain(message);
  });

  it('never repeats a rejected value', () => {
    const error = invalid(() => validateArgs(fields, { accountId: 'a', limit: 'alex@example.com' }));
    expect(error?.message).not.toContain('alex');
  });
});

describe('parseArgs', () => {
  it('fills positional fields, options and boolean flags', () => {
    expect(parseArgs({ fields }, ['acct_1', '--platform', 'youtube', '--limit', '5', '--force'])).toEqual({
      accountId: 'acct_1',
      platform: 'youtube',
      limit: 5,
      force: true,
    });
  });

  it('accepts --name=value and --flag=false', () => {
    expect(parseArgs({ fields }, ['--accountId=a', '--force=false', '--note=two words'])).toEqual({
      accountId: 'a',
      force: false,
      note: 'two words',
    });
  });

  it('skips positional fields already given as options', () => {
    const two: Field[] = [
      { name: 'a', type: 'string', required: true, description: '', positional: true },
      { name: 'b', type: 'string', required: true, description: '', positional: true },
    ];
    expect(parseArgs({ fields: two }, ['--a', 'x', 'y'])).toEqual({ a: 'x', b: 'y' });
  });

  it('reads --json and lets options override it', () => {
    expect(parseArgs({ fields }, ['--json', '{"accountId":"a","limit":2}', '--limit', '9'])).toEqual({
      accountId: 'a',
      limit: 9,
    });
  });

  it('takes everything after -- as positional, and a negative number as a value', () => {
    expect(parseArgs({ fields }, ['--limit', '-1', '--', '--odd-id'])).toEqual({ accountId: '--odd-id', limit: -1 });
  });

  it.each([
    [['a', '--nope', '1'], 'unknown option --nope'],
    [['a', '--limit'], 'option --limit needs a value'],
    [['a', '--limit', 'abc'], "field 'limit' must be a number"],
    [['a', '--limit', ''], "field 'limit' must be a number"],
    [['a', '--force=maybe'], "field 'force' must be true or false"],
    [['a', '--limit', '1', '--limit', '2'], 'given twice'],
    [['a', 'b'], 'at most 1 positional'],
    [['a', '--json', '{nope'], '--json must be valid JSON'],
    [['--json', '[1]'], '--json must be an object'],
    [[], "field 'accountId' is required"],
    [['a', '--platform', 'vimeo'], 'one of: youtube, tiktok'],
  ])('rejects %j', (argv, message) => {
    const error = invalid(() => parseArgs({ fields }, argv));
    expect(error?.code).toBe('invalid_argument');
    expect(error?.message).toContain(message);
  });
});
