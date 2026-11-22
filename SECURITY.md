# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately, not in a public issue or pull request. Use GitHub's private vulnerability
reporting: <https://github.com/ideaSquared/agent-idea/security/advisories/new>.

Include what you found, how to reproduce it, and which part of the repo it affects (the Worker, the `idea` CLI, or
the `@ideasquared/log` and `@ideasquared/ops` packages). Do not include real tokens or personal data.

## What to expect

- We acknowledge a report within 3 working days.
- We confirm whether we can reproduce it and share a plan within 10 working days.
- We fix confirmed issues as fast as their severity warrants, and credit the reporter in the advisory if they wish.

Only the latest commit on `main` is supported; it is what runs in production.
