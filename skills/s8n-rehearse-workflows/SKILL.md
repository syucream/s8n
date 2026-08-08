---
name: s8n-rehearse-workflows
description: Rehearse n8n workflow JSON or YAML safely with s8n. Use when an agent must discover mock requirements, create or refine optional Scenario Manifest cases, import a synthetic draft from an n8n execution log, increase meaningful branch coverage, add deterministic assertions, or decide whether a workflow is ready for a bounded production trial.
---

# Rehearse n8n workflows

Keep the workflow file canonical. Never require, embed, or auto-discover a
Scenario Manifest for a normal `s8n run`.

## Procedure

1. Read the repository's `AGENTS.md` and do not read credential or environment
   files. Run only trusted workflow definitions unless the process is
   OS-isolated.
2. Build s8n if needed, then run the workflow with synthetic `--input`,
   `--mocks`, explicit `--workflow-map`, and a fixed `--now` as applicable.
3. When a reviewed n8n execution log exists, generate a synthetic-shape draft:

   ```bash
   s8n scenario draft workflow.json execution.json
   ```

   Never copy raw execution values into a fixture. Treat every generated draft
   as review-required because value-dependent branches may diverge.
4. Keep the sidecar beside the workflow or in the private workflow repository.
   Validate and execute it explicitly:

   ```bash
   s8n scenario validate workflow.scenarios.yaml
   s8n rehearse workflow.json workflow.scenarios.yaml
   ```

5. Inspect assertion failures, pending mock keys, trace statuses, and uncovered
   nodes. Add the smallest synthetic case that reaches a new important path.
6. Require assertions for critical outputs and effects. s8n supplies an
   implicit `status=success` assertion when a case does not specify status.
7. Keep a case only when it increases union executed coverage, verifies a
   critical outcome, or proves an expected failure path.
8. Add a mutation or negative case proving that the gate can fail. Run the
   narrow rehearsal gate and then the repository's proportional final gate.

## Decision rules

- Agent proposes; s8n verifies. Never treat the agent's narrative judgment as
  the pass condition.
- Prefer multiple focused cases over one permissive mock-everything case.
- Do not count waiting mocks or skipped nodes as executed coverage.
- Require request, response, independent read-back, and `verified: true` for
  emulated mutations.
- Report mocking, emulation, and local execution separately. A successful mock
  does not prove a remote API contract.
- Keep private names, paths, identifiers, queries, payloads, and raw errors out
  of public reports and the s8n repository.
- Treat Code and expression evaluation as trusted-code execution. Host-global
  guards are not a hostile-code sandbox.

## Completion evidence

Record the exact command, case totals, assertion failures, per-case coverage,
union coverage, pending mocks, verified-effect counts, and fidelity boundary.
Do not claim production readiness solely from node coverage.
