import type { Args, Command, Field } from './contract.ts';
export declare function validateArgs(fields: readonly Field[], args: Record<string, unknown>): Args;
export declare function parseArgs(command: Pick<Command, 'fields'>, argv: readonly string[]): Args;
