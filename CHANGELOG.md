# Changelog

## 0.4.0 - 2026-08-05

- Add opt-in stateful emulation for Google Workspace, Google Cloud Platform,
  Notion, Jira, and GitHub, including seed data for read-first workflows.
- Add verified service effects for BigQuery, Cloud Storage, Gmail, Vertex AI,
  Notion database pages, Jira issues, and GitHub issues and comments.
- Execute five reviewed, hash-pinned public multi-service workflows as part of
  the release quality gate.
- Add published-workflow compatibility for legacy Set values, Time Saved,
  connected Vertex language-model subnodes, and common expression helpers.
- Retain a detailed real-service simulation report and explicit fidelity
  boundaries for deterministic mocks versus stateful emulation.

## 0.3.0 - 2026-08-02

- Add a safe structural simulation gate for a fixed corpus of 100 public n8n
  workflow templates.
- Add broader graph, Merge, transformation, and expression compatibility found
  through community workflow execution.
- Replace downloaded Code and expression execution in the default community
  corpus gate with deterministic neutralization and mocks.

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
