import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const VERSION = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;

// Runs the real entry point, so exit codes and the stdout/stderr split are what a user sees.
function idea(...args: string[]) {
  const result = spawnSync(process.execPath, ['src/cli/cli.ts', ...args], {
    encoding: 'utf8',
    env: { ...process.env, GH_TOKEN: 'not-a-real-token', NO_COLOR: '1' },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('idea command line', () => {
  it('prints the package version with --version and exits 0', () => {
    const result = idea('--version');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(VERSION);
  });

  it('prints usage to stdout with --help and -h and exits 0', () => {
    for (const flag of ['--help', '-h']) {
      const result = idea(flag);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('idea logs <project>');
    }
  });
});
