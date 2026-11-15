import { describe, expect, it } from 'vitest';
import { CommandSchema, ErrorResponseSchema, InvokeRequestSchema, OPS_CONTRACT_VERSION } from '../src/index.ts';

const command = {
  id: 'accounts.resync',
  group: 'accounts',
  name: 'resync',
  summary: 'Resync an account',
  kind: 'write',
  fields: [{ name: 'accountId', type: 'id', required: true, description: 'The account', positional: true }],
  dryRun: true,
};

describe('contract v1', () => {
  it('is version 1', () => {
    expect(OPS_CONTRACT_VERSION).toBe(1);
  });

  it('accepts a well-formed command', () => {
    expect(CommandSchema.safeParse(command).success).toBe(true);
  });

  it.each([
    ['an id that is not group.name', { ...command, id: 'accounts.other' }],
    ['an uppercase group', { ...command, group: 'Accounts', id: 'Accounts.resync' }],
    ['an enum without values', { ...command, fields: [{ name: 'p', type: 'enum', required: true, description: '' }] }],
    ['a field called json', { ...command, fields: [{ name: 'json', type: 'string', required: true, description: '' }] }],
    [
      'duplicate field names',
      {
        ...command,
        fields: [
          { name: 'a', type: 'string', required: true, description: '' },
          { name: 'a', type: 'string', required: true, description: '' },
        ],
      },
    ],
  ])('rejects %s', (_, bad) => {
    expect(CommandSchema.safeParse(bad).success).toBe(false);
  });

  it('requires a mode on invoke and a known error code', () => {
    expect(InvokeRequestSchema.safeParse({ command: 'a.b', args: {} }).success).toBe(false);
    expect(ErrorResponseSchema.safeParse({ error: { code: 'teapot', message: 'x' } }).success).toBe(false);
  });
});
