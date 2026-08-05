# Real-service workflow simulation report

Date: 2026-08-03

## Outcome

Five currently published n8n workflows were executed from their real graph and
parameter definitions. All five workflows succeeded and all 21 scenario
assertions passed. Service mutations were handled by s8n's stateful emulators
and verified by reading the resulting local state.

| Template | Simulated outcome | Verified effects |
| --- | --- | --- |
| [1049: ISS to BigQuery](https://n8n.io/workflows/1049) | A deterministic ISS response was normalized and inserted as a BigQuery row. | latitude `35.6812`, longitude `139.7671`, name `iss`, and timestamp persisted |
| [5889: Notion to GitHub](https://n8n.io/workflows/5889) | Seeded feature rows took both active and completed branches. | GitHub issue created, Notion status and issue URL updated, completion email sent |
| [7502: AI image and GCS](https://n8n.io/workflows/7502) | A bucket was created and a deterministic generated-image result flowed through object creation and deletion. | bucket read-back, object read-back, and confirmed deletion |
| [11728: Jira to GitHub Copilot](https://n8n.io/workflows/11728) | An approved seeded Jira bug became a GitHub issue and Copilot assignment comment. | GitHub issue/comment, Jira backlink comment, and `copilot_assigned` label |
| [15245: Gmail and Vertex AI](https://n8n.io/workflows/15245) | Two seeded emails were classified into priority 1 and 2 paths. | five Vertex invocations, Gmail label/read mutations, reply draft, and daily summary email |

Run the same gate with:

```bash
bun run quality:real-services
```

## Improvements driven by the real workflows

The first executions exposed compatibility gaps that smaller contract tests did
not reveal. The implementation now supports:

- seed data for read-first service workflows through `--emulator-seed`;
- published-node default operations for BigQuery, GitHub, and Gmail;
- Google Cloud Storage bucket and object lifecycle operations;
- Gmail get/list, label mutation, read-state mutation, send, and draft paths;
- Notion database pages, users, blocks, and typed property updates;
- Jira comments and updates that preserve existing issue fields;
- GitHub URL-style owners and verified issue comments;
- Vertex AI language-model subnodes connected to Agent, Chain, and Information
  Extractor nodes;
- legacy Set typed values, `String.parseJson()`, Luxon `format()`, and trailing
  expression semicolons found in published workflows;
- the metadata-only Time Saved node as a main-data pass-through.

## Fidelity boundary

This proves meaningful workflow control flow, expression resolution, resolved
service requests, state mutations, and downstream use of returned values. It
does not contact user accounts or claim transport-level parity.

External HTTP/Port responses, generated image bytes, and model completions are
deterministic mocks. Authentication, permissions, rate limits, pagination,
webhook delivery, arbitrary BigQuery SQL, AI quality, and provider-specific
error payloads remain outside this gate. Those require live credentials or a
dedicated protocol emulator.

Downloaded definitions are accepted only when their reviewed SHA-256 hashes
match. The gate rejects Code nodes and statically rejects dangerous expression
identifiers, properties, syntax, and non-whitelisted calls before evaluation.
