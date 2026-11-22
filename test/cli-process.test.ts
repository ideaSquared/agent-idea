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

  it('exits non-zero and writes the reason to stderr, not stdout, for an unknown option', () => {
    const result = idea('logs', 'pairflix', '--bogus');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--bogus');
    expect(result.stdout).toBe('');
  });

  it('exits non-zero for an unknown command', () => {
    const result = idea('nonsense', 'pairflix');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown command 'nonsense'");
    expect(result.stdout).toBe('');
  });

  it('prints no colour codes', () => {
    // eslint-disable-next-line no-control-regex -- ESC is what starts an ANSI code
    expect(idea('--help').stdout).not.toMatch(/\x1b\[/);
  });
});
