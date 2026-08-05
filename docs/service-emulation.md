# Stateful service emulation

s8n provides an in-process, stateful contract emulator for the integration
families that most often determine whether a workflow behaves correctly after
deployment. Enable one or more comma-separated families, or all of them:

```bash
s8n run workflow.json --emulate gws,gcp,notion,jira,github
s8n run workflow.json --emulate all
s8n run workflow.json --emulate notion --emulator-seed seed.json
```

Read-first workflows can seed emulator stores with a JSON document such as:

```json
{
  "stores": {
    "notion.databasePages": [
      { "id": "feature-1", "name": "Offline mode" }
    ]
  }
}
```

The emulator never uses workflow credentials or opens a network connection.
An unsupported operation still follows the normal `--mocks` path. This keeps
the emulator honest: it does not claim fidelity for behavior it does not model.

## Coverage

| Family | Node types recognized | Stateful surfaces |
| --- | --- | --- |
| `slack` | Slack | messages, thread replies, updates, user lookup |
| `gws` | Google Drive, Sheets, Gmail, Calendar, Docs | files, rows, sent messages, events, documents |
| `gcp` | BigQuery, Google Cloud Storage, Vertex/Gemini node types | table rows and queries, objects, deterministic model invocation records |
| `notion` | Notion | pages and databases; create, update, get, list/search |
| `jira` | Jira | issues and comments; create, update, get, list/search |
| `github` | GitHub | issues and other selected resources; create/update, get/list |

The most reliable scenarios are mutation followed by a read in the same
workflow. IDs returned from one node can be passed to later nodes with normal
n8n expressions. Each emulated call emits an `effects[]` entry containing:

- the fully resolved request;
- the response returned to the workflow;
- an independent read-back observation from emulator state;
- `verified: true` only after that observation succeeds.

This is designed as compact evidence for an external AI agent. The agent can
submit the complete command envelope without interpreting logs or accessing a
separate inspector.

## Existing emulator compatibility and ROI

The standalone path stays in-process so the compiled s8n binary remains the
only runtime requirement. The release gate additionally checks representative
GitHub and Google Workspace contracts against the Vercel Labs `emulate`
package. That package has broad, high-fidelity GitHub APIs and Google Gmail,
Calendar, and Drive APIs, so it is used as an independent oracle instead of
duplicating a server dependency in the normal CLI path. Slack uses the same
oracle strategy.

Notion, Jira, BigQuery, Cloud Storage, and Vertex AI use the compact s8n model.
No compatible TypeScript emulator with enough breadth is required at runtime.
The model intentionally focuses on workflow-visible resource lifecycle and
does not reproduce authentication, rate limiting, permissions, pagination,
webhooks, arbitrary BigQuery SQL, or real model semantics. Use explicit mocks
for those cases until a dedicated emulator contract is added.

## Quality contract

`bun run quality:services` runs create-to-read workflows for GWS, GCP, Notion,
Jira, and GitHub. It requires exact read-back equality, rejects missing
resources, verifies that a mutated `verified` flag fails the gate, and checks
GitHub and Gmail state against Vercel Labs `emulate`. `bun run quality` includes
this gate.

`bun run quality:real-services` adds an end-to-end gate using five reviewed,
hash-pinned public workflows. It covers BigQuery, Notion, GitHub, Gmail, GCS,
Jira, and Vertex AI across real graph structures and published parameter
shapes. The retained scenario report documents exact boundaries between
stateful emulation and deterministic mocks.
