# Changelog

## 0.2.0 - 2026-08-01

- Add opt-in, stateful, single-process Slack emulation for message posting,
  thread replies, message updates, and user lookup by email.
- Add machine-readable verified side effects with resolved requests, responses,
  and state observations.
- Accept legacy published n8n templates without node IDs, with string credential
  names, and with `$node["Node Name"].json` expressions.
- Add a Vercel Labs `emulate` parity gate and a live official n8n community
  template gate.
- Add a complete release gate that checks policy, formatting, types, tests, the
  standalone binary, stateful integration behavior, and community compatibility.
