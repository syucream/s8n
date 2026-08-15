# Changelog

## Unreleased

- Model HTTP Request pagination: mock `{ pages: [...] }` drives a simulated page
  loop, `completeExpression` and per-request updates evaluate against
  `$response`, and single-page mocks are annotated with fidelity notes.
- Add string assertions (`matches`, `notMatches`, `occurrences`) and
  golden-file snapshots (`s8n rehearse --update-snapshots`) to scenario cases.
- Run parent-child approval flows in one scenario: `resume` directives resolve
  waiting nodes, `subExecutionInputs` asserts child entry payloads, and
  unresolved waits report a `waiting` status.
- Model `executeOnce` (one run with the first item) and add a machine-readable
  `mocked-output` fidelity note for mock-served nodes.
- Reproduce real BigQuery read typing in the emulator: booleans, numerics, and
  dates come back as strings unless `returnAsNumbers` is set.
- Add `--repeat N` variance over mock `$variants`, and a new `s8n eval` command
  scoring real execution data against expectation fixtures (precision/recall).
- Normalize LLM outputs into a single `llmOutputs` section when drafting
  scenarios from execution logs.
- Validate HTTP Request mock shapes against full-response configuration and
  expose opt-in sanitized request evidence for local write-path assertions.
- Match `alwaysOutputData` when an empty input reaches external-I/O nodes without
  requesting a mock for an operation that would not run.

## 0.6.0 - 2026-08-09

- Load workflow JSON or YAML, with opt-in traversal-safe Code asset includes.
- Execute explicitly mapped synchronous sub-workflows with scoped mocks and
  nested execution evidence.
- Add optional Scenario Manifest sidecars with deterministic assertions,
  per-case evidence, and union executed-node coverage.
- Generate review-required synthetic-shape scenario drafts from n8n-shaped
  execution logs without retaining source scalar values.
- Add a reusable agent rehearsal skill, public examples, and behavior/privacy
  mutation checks to the release quality gate.

## 0.5.0 - 2026-08-06

- Add fixture-driven AI Agent and Chain contract emulation across connected
  language models, tools, memory, and output parsers.
- Validate Structured Output Parser results against JSON Schema and example
  output contracts.
- Keep AI effects privacy-safe by exposing only coarse content metadata and
  aggregate connection counts.
- Add a privacy-safe workflow corpus audit that ranks official node types while
  aggregating custom node types into a single category.
- Add a generic runnable AI workflow example and privacy regression coverage.

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
