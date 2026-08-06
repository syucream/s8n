# Repository guide for AI coding agents

This file is the vendor-neutral source of truth for AI agents working in this
repository. It applies to the entire repository.

## Project contract

s8n is an independent, local simulator for n8n workflow JSON. It is a CLI and
external-agent harness, not an AI runtime and not a complete n8n replacement.
It must not use workflow credentials or perform real external I/O.

Never copy source code, private workflow exports, production logs, credentials,
or real customer data from another repository into this one. Public n8n source
and workflow templates may be inspected to understand behavior, but new
fixtures must be original, minimal, and synthetic. Node identifiers such as
`n8n-nodes-base.httpRequest` are file-format compatibility strings.

All repository-facing text must be English, including documentation, source
comments, CLI help and errors, schemas, fixtures, and test names. The automated
check covers tracked paths and text; do not bypass or weaken it.

## Tooling and commands

Use Bun 1.3.4, as pinned in `package.json`.

```bash
bun install --frozen-lockfile
bun run check
bun run build
bun run quality
```

- Use `bun run <script>` instead of npm, pnpm, or Yarn commands.
- Use `bun test` for tests and `bun run lint:fix` for safe formatting fixes.
- `bun run check` runs public-content and English policies, Biome, TypeScript,
  and unit tests.
- `bun run quality` is the release gate. It also builds the standalone binary
  and runs emulator and reviewed public-workflow scenarios.
- Run the narrowest relevant test or quality gate while iterating, then run the
  proportional final gate before reporting completion.

Some release gates use the network and execute only hash-pinned or structurally
neutralized public workflows. Do not weaken those trust boundaries to make a
test pass.

## Architecture boundaries

- `src/engine/` owns graph scheduling and execution.
- `src/nodes/builtin/` contains local compute and control-flow semantics.
- `src/nodes/builtin/generic-fallback.ts` handles otherwise unmodeled executable
  nodes through caller mocks and optional integration emulation.
- `src/integrations/` owns in-process, stateful service contracts.
- `src/mock/` owns mock lookup, normalization, and shape hints.
- `src/format/` owns the stable machine-readable output formats.
- `src/schema/` owns workflow and item validation.

App-specific integration nodes such as Slack, Notion, or BigQuery should remain
on the generic fallback. Add a dedicated built-in executor only for genuine
local compute/control-flow behavior, or for the generic HTTP Request and Webhook
I/O primitives. Optional stateful service behavior belongs in the integration
runner; without `--emulate`, the same node must continue to request mocks.

Before changing a node parameter contract, verify exact field names and defaults
against upstream n8n source. Do not infer them from labels or from one workflow.
Update `docs/node-support.md` when support tiers change and
`docs/service-emulation.md` when emulator coverage or fidelity changes.

## Engine invariants

- A node fires after every required input slot receives a delivery. Multiple
  sources connected to one slot are alternatives, not cumulative requirements.
- A node receiving zero total items is skipped unless `alwaysOutputData` is set.
- One trigger runs per execution; `--start-node` resolves multiple candidates.
- `$now` and `$today` are Luxon `DateTime` values, not ISO strings.
- `pinData` overrides built-in execution, integration emulation, and mock lookup.
- Unknown executable node types request generic mocks instead of hard-failing.

Preserve the stable stdout contract: every CLI invocation emits exactly one JSON
envelope with `ok`, `command`, and either `data`, `issues`, or `error`. Diagnostic
text must not corrupt stdout.

## Tests and change hygiene

- Add normal and failure-path tests for behavior changes.
- Prefer observable workflow outcomes over isolated implementation assertions.
- For emulated mutations, verify the request, response, and independent state
  read-back before setting `verified: true`.
- Keep unrelated user changes out of patches and commits.
- Do not add generated binaries, local environment files, editor state, or
  downloaded private/public workflow dumps to Git.
- Treat workflow expressions and Code nodes as untrusted executable code. Run
  only reviewed fixtures locally.
- Never push directly to `main`. Create a focused branch, validate it, push the
  branch, and open a pull request. If additional fixes are needed, update the
  same branch and keep the PR checks green.

For release-affecting work, follow `CONTRIBUTING.md` and run `bun run quality`
from a clean checkout. Version tags must match `package.json` exactly.
