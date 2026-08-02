# Three Public Workflow Simulation Report

Date: 2026-08-02

## Purpose

This report examines three workflows selected at random from the fixed
100-template community corpus. It records what s8n actually simulated, which
nodes were reached, what output could be inspected, and what the result does
not prove.

The sampled template IDs were `16209`, `14808`, and `13269`. They were selected
with `Array#sample`-equivalent random selection from the corpus ID list, before
their definitions or simulation results were inspected.

## Safety and execution method

Each current workflow definition was fetched from the public n8n template API
and validated. The simulation used one deterministic synthetic input item and
a fixed clock (`2026-08-02T00:00:00.000Z`). When a workflow exposed multiple
start nodes, s8n tried each candidate safely and retained the run that reached
the most nodes.

Downloaded workflow code is untrusted. The corpus runner therefore did not
evaluate downloaded expressions or Code-node JavaScript. Code nodes, LLMs, and
remote services were supplied deterministic representative mocks. Builtin
nodes such as triggers, Set, If, Filter, Merge, Remove Duplicates, and Split In
Batches used s8n's local implementation.

The command used to retain the detailed evidence was:

```bash
bun run scripts/community-corpus-quality-gate.ts --details=16209,14808,13269
```

## Raw execution evidence

The primary artifact is now the node-level execution log, rather than this
report's prose. It can be reproduced with:

```bash
bun run scripts/community-corpus-quality-gate.ts \
  --details=16209,14808,13269 \
  --truncate-data=1 \
  --execution-log-only
```

The result uses the n8n-style
`execution.data.resultData.runData[<node name>][]` shape. Every reached node
records its actual output slots under `data.main`, its actual upstream source,
execution order, duration, and status. `metadata.s8nSimulationMode` makes the
boundary between local builtin behavior and a safe mock explicit.

The following excerpts are copied from the rerun. Large representative input
objects are omitted only inside this report; the command above prints them.

### Template 13269: branch output and provenance

```json
"is Telegram?": [{
  "executionIndex": 2,
  "executionStatus": "success",
  "source": [{
    "previousNode": "Google Stitch Agent",
    "previousNodeOutput": 0,
    "previousNodeRun": 0
  }],
  "data": { "main": [[{
    "json": { "output": "Here is the answer you requested." }
  }], []] },
  "metadata": {
    "s8nTraceStatus": "success",
    "originalOutputItemCounts": [1, 0],
    "s8nSimulationMode": "builtin"
  }
}]
```

This is the actual two-output result of the If node: one item on output 0 and
none on output 1. The next run entry names `is Telegram?` output 0 as the
source, and the final `Send a text message` entry contains the mocked Telegram
response with `ok: true` and `result.message_id: 1`.

### Template 14808: fan-in and selected branch

```json
"Combine AI + Chart Data": [{
  "executionIndex": 9,
  "executionStatus": "success",
  "source": [
    { "previousNode": "Generate Chart", "previousNodeOutput": 0 },
    { "previousNode": "Parse AI Output", "previousNodeOutput": 0 }
  ],
  "data": { "main": [[{ "json": { "id": "sample-1" } }]] },
  "metadata": {
    "originalOutputItemCounts": [2],
    "dataTruncated": true,
    "s8nSimulationMode": "builtin"
  }
}],
"Check Performance Gap": [{
  "executionIndex": 11,
  "executionStatus": "success",
  "data": { "main": [[], [{ "json": { "id": "sample-1" } }]] },
  "metadata": { "originalOutputItemCounts": [0, 1] }
}]
```

The Merge really received both upstream runs and produced two items. The
display retains one because `--truncate-data=1`, while the original count and
truncation flag preserve that fact. The If result then selected only output 1;
the normal email is logged as skipped and the alert email runs.

### Template 16209: exact stop point

```json
"Filter 4 Stars or Less": [{
  "executionIndex": 4,
  "executionStatus": "success",
  "source": [{
    "previousNode": "Remove Duplicate Reviews",
    "previousNodeOutput": 0,
    "previousNodeRun": 0
  }],
  "data": { "main": [[]] },
  "metadata": {
    "originalOutputItemCounts": [0],
    "s8nSimulationMode": "builtin"
  }
}],
"Process Each Review": [{
  "executionIndex": 5,
  "executionStatus": "skipped",
  "source": [{
    "previousNode": "Filter 4 Stars or Less",
    "previousNodeOutput": 0,
    "previousNodeRun": 0
  }],
  "metadata": { "s8nTraceStatus": "skipped_no_data" }
}]
```

This exposes the precise reason downstream outreach did not run: Filter
emitted an empty main output, so the following Split In Batches node was
skipped. It is not inferred from graph reachability or described after the
fact; it is present in the per-node execution record.

The same output is available for any local workflow through:

```bash
s8n run workflow.json --mocks mocks.json --execution-log --truncate-data 10
```

## Results at a glance

| Template | Total nodes | Reached visits | Builtin | Safe mocks | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| 13269: Google Stitch design agent | 25 | 5 | 1 | 4 | Completed a chat-to-Telegram response path |
| 14808: Gold vs equity report | 22 | 15 | 4 | 11 | Completed the main report path and selected the alert branch |
| 16209: Shopify review outreach | 36 | 6 | 4 | 2 | Stopped naturally after Filter emitted zero items |

All three engine runs returned `success` with no execution errors. This status
means every reached branch completed cleanly. It does not mean every node in
the workflow ran or that mocked remote services produced real business data.

## Sample 1: Google Stitch design agent via Telegram

Source: <https://n8n.io/workflows/13269>

Workflow name: `MCP Google Stitch Agent via Telegram`

### Simulated path

1. `When chat message received` accepted the synthetic chat input.
2. `Google Stitch Agent` returned a representative mocked agent answer.
3. Builtin `If` node `is Telegram?` routed one item to its true output and zero
   items to its false output.
4. `From MD to HTML` returned representative generated text.
5. `Send a text message` returned a representative Telegram Bot API result.

### Inspectable result

The agent output contained `Here is the answer you requested.`. The following
LLM step emitted `Example generated text`, and the Telegram node returned one
output item based on the tailored Telegram mock shape. The trace proves that
s8n can follow this selected chat-response branch, preserve one item through
the If outputs, and reach the final Telegram operation.

### Limit

No Google Stitch MCP call, Gemini inference, Markdown conversion, or Telegram
network request occurred. The workflow's Telegram-triggered alternate path was
not active in this run.

## Sample 2: Gold versus equity performance report

Source: <https://n8n.io/workflows/14808>

Workflow name: `Gold vs Equity Performance Comparison Tracker`

### Simulated path

1. Builtin `Run Report` manual trigger emitted one item.
2. Builtin `Set Analysis Parameters` emitted one configured item.
3. Mocked Google Sheets nodes returned one gold item and one equity item.
4. The market merge, performance calculation, chart generation, AI analysis,
   and AI parsing Code/LLM nodes each emitted representative data.
5. Builtin `Combine AI + Chart Data` received one item on both inputs and
   emitted two appended items.
6. The final report Code node reduced that stream to one representative item.
7. Builtin `Check Performance Gap` routed zero items to the normal-report
   output and one item to the alert output.
8. `Send Report Email` was correctly marked `skipped_no_data`.
9. Mocked `Send Alert Email` and `Store Report History` each emitted one item.

### Inspectable result

This was the deepest of the three samples: 15 node visits completed without an
error. The trace exposed the two-input Merge counts (`[1, 1]`), its two-item
output, the If branch counts (`[0, 1]`), the skipped normal email, the selected
alert email, and the final Google Sheets history-write result.

### Limit

The gold/equity return calculation, QuickChart URL, AI recommendation, HTML
report, Gmail delivery, and Sheets persistence were mocked. The run validates
orchestration and branch behavior, not financial correctness or delivery.

## Sample 3: Shopify review outreach drafts

Source: <https://n8n.io/workflows/16209>

Workflow name: `Review Scraping & AI Outreach Workflow`

### Simulated path

1. Builtin `Trigger Daily` schedule trigger emitted one item.
2. `Set Target App URLs` used a safe Code mock and emitted one item.
3. `Scrape Shopify Reviews` used a generic Apify mock and emitted one item.
4. Builtin `Remove Duplicate Reviews` retained the one unique item.
5. Builtin `Filter 4 Stars or Less` emitted zero items because the generic
   Apify sample did not contain the expected `reviewer` and `rating` values.
6. `Process Each Review` was correctly marked `skipped_no_data`; no downstream
   outreach nodes ran.

### Inspectable result

The output before Filter contained one representative review-like item. The
Filter output contained zero items, making the exact point where the synthetic
scenario stopped visible. The run demonstrates that s8n does not manufacture
downstream activity when a branch has no data.

### Limit

This sample did not exercise the Google Sheets existence check, Slack alerts,
Serper HTTP request, Hunter lookup, LLM draft generation, or Gmail draft. A
second scenario with a tailored Apify response containing `id`, `reviewer`,
`rating`, `review`, `date`, and `appReviewUrl` is required to cover that half of
the workflow.

## Assessment

The three samples show three materially different outcomes:

- s8n can trace a short AI/chat integration path to its final mocked I/O.
- s8n can execute a longer fan-out/fan-in workflow and expose Merge and branch
  item counts, including a correctly skipped notification branch.
- s8n can explain why a workflow stopped early when representative mock data
  is insufficient, without falsely running downstream nodes.

The strongest current value is structural debugging: start-node selection,
reachable-path inspection, item counts, branch decisions, and identification of
the exact remote response shape needed for a deeper rerun. The sampled output
is not yet evidence of business-semantic correctness for Code-heavy or
integration-heavy templates.
