/**
 * Human/AI-facing documentation for each builtin node type's parameter
 * shape. For the node types listed here, the field names/nesting below are
 * verified against real n8n's actual node source (not guessed) - see each
 * builtin executor's module docstring for the corresponding node source
 * file. Any node type NOT listed here still runs: s8n treats it as
 * unmodeled external IO and mocks its output (see the "unmodeled node
 * types" entry at the end).
 */
export interface NodeTypeDoc {
  type: string;
  summary: string;
  parametersShape: Record<string, string>;
  requiresMock: boolean;
  mockKeyConvention?: string;
}

export const NODE_TYPE_DOCS: NodeTypeDoc[] = [
  {
    type: "n8n-nodes-base.manualTrigger",
    summary:
      "Manual execution entry point. Emits the items supplied through --input, or one empty item by default.",
    parametersShape: {},
    requiresMock: false,
  },
  {
    type: "n8n-nodes-base.scheduleTrigger",
    summary:
      "Scheduled execution entry point. Does not wait; emits --input as one simulated trigger event.",
    parametersShape: {},
    requiresMock: false,
  },
  {
    type: "n8n-nodes-base.webhook",
    summary:
      "Webhook entry point. Uses --input when provided; otherwise looks for a mock keyed by node name and requests mock data if none exists.",
    parametersShape: {},
    requiresMock: true,
    mockKeyConvention: "<nodeName>",
  },
  {
    type: "n8n-nodes-base.httpRequest",
    summary:
      "Mocked HTTP request. Performs no network I/O and looks up responses by node name, with an optional #<index> suffix for multiple items.",
    parametersShape: {
      method: "string (GET/POST/...); uses the upstream n8n field name",
      url: "string; supports = expressions and uses the upstream n8n field name",
    },
    requiresMock: true,
    mockKeyConvention: "<nodeName> or <nodeName>#<itemIndex>",
  },
  {
    type: "n8n-nodes-base.set",
    summary:
      "Sets or overwrites fields by evaluating the upstream n8n v2/v3 assignments.assignments[] shape. Emits only assigned fields by default; includeOtherFields=true preserves existing fields.",
    parametersShape: {
      "assignments.assignments[]":
        "{ id, name: string, value: any (supports = expressions), type? }; matches the upstream n8n shape",
      "fields[]":
        "s8n shorthand used when assignments is absent; each entry is { name, value }",
      mode: '"manual" (default) | "raw"',
      jsonOutput:
        "JSON object string used when mode=raw; supports resolved expressions",
      includeOtherFields:
        "boolean, default false; true preserves existing fields",
    },
    requiresMock: false,
  },
  {
    type: "n8n-nodes-base.if",
    summary:
      "Conditional branch with output[0] for true and output[1] for false, matching n8n. Supports the n8n Filter component shape or s8n's single condition expression.",
    parametersShape: {
      condition: "s8n shorthand: one boolean expression",
      "conditions.conditions[]":
        "n8n shape: [{ id, leftValue, rightValue, operator: { operation } }]; supports equals, notEquals, contains, regex, gt, exists, empty, and related operations",
      "conditions.combinator": '"and" | "or"; default "and"',
    },
    requiresMock: false,
  },
  {
    type: "n8n-nodes-base.filter",
    summary:
      "Keeps matching items on one output, equivalent to the true branch of If. Uses the same condition shape as If.",
    parametersShape: {
      "conditions.conditions[]": "same shape as If",
      "conditions.combinator": '"and" | "or"',
    },
    requiresMock: false,
  },
  {
    type: "n8n-nodes-base.switch",
    summary:
      "Multi-way branch. rules.values[] order determines output indexes and the first match wins. options.fallbackOutput controls unmatched items: none discards, extra adds an output, and a number selects an existing output.",
    parametersShape: {
      "rules.values[]":
        "{ conditions: n8n Filter shape, outputKey?, renameOutput? }; array order determines output index",
      "options.fallbackOutput":
        "'none' | 'extra' | number; located under options as in n8n",
    },
    requiresMock: false,
  },
  {
    type: "n8n-nodes-base.merge",
    summary:
      "Combines multiple input slots. append concatenates items. combine supports an inner join through combineByFields or positional merging through combineByPosition. combineBySql and chooseBranch are unsupported.",
    parametersShape: {
      mode: '"append" | "combine"',
      combineBy: '"combineByFields" (default) | "combineByPosition"',
      "mergeByFields.values[]":
        "{ field1: string, field2: string }; combineByFields supports two inputs",
    },
    requiresMock: false,
  },
  {
    type: "n8n-nodes-base.code",
    summary:
      "Runs arbitrary JavaScript as local computation. Network and file I/O are not injected. Languages other than javaScript, including Python, fail.",
    parametersShape: {
      jsCode:
        "string function body; returns the result and uses the upstream n8n field name",
      mode: '"runOnceForAllItems" (default, scope: items[]) | "runOnceForEachItem" (scope: item, $json)',
      language: '"javaScript" (default and only supported value)',
    },
    requiresMock: false,
  },
  {
    type: "n8n-nodes-base.noOp",
    summary: "Passes input through unchanged.",
    parametersShape: {},
    requiresMock: false,
  },
  {
    type: "n8n-nodes-base.wait",
    summary:
      "Passes input through without actually waiting; delay settings are recorded only.",
    parametersShape: {},
    requiresMock: false,
  },
  {
    type: "n8n-nodes-base.executeWorkflowTrigger",
    summary:
      "Entry point for a called sub-workflow. In standalone simulation it behaves like Manual Trigger and emits --input unchanged.",
    parametersShape: {},
    requiresMock: false,
  },
  {
    type: "n8n-nodes-base.respondToWebhook",
    summary:
      "Represents a webhook response. It does not construct a real HTTP response and passes items through unchanged, matching n8n's downstream data behavior.",
    parametersShape: {},
    requiresMock: false,
  },
  {
    type: "n8n-nodes-base.aggregate",
    summary:
      "Aggregates multiple items into one. aggregateIndividualFields collects selected values into arrays; aggregateAllItemData stores every item's JSON under destinationFieldName.",
    parametersShape: {
      aggregate:
        '"aggregateIndividualFields" (default) | "aggregateAllItemData"',
      "fieldsToAggregate.fieldToAggregate[]":
        "{ fieldToAggregate: string, renameField?: boolean, outputFieldName?: string }",
      destinationFieldName: 'string, default "data" for aggregateAllItemData',
      include: '"allFields" (default) | "specifiedFields" | "allFieldsExcept"',
      "options.keepMissing":
        "boolean, default false; false skips missing and null values and removes nulls from arrays",
    },
    requiresMock: false,
  },
  {
    type: "n8n-nodes-base.limit",
    summary:
      "Limits the number of items and can keep items from either the beginning or end.",
    parametersShape: {
      maxItems: "number, default 1",
      keep: '"firstItems" (default) | "lastItems"',
    },
    requiresMock: false,
  },
  {
    type: "n8n-nodes-base.sort",
    summary:
      "Sorts items. Supports simple multi-field, case-insensitive sorting and random shuffling. code custom comparators are unsupported.",
    parametersShape: {
      type: '"simple" (default) | "random" | "code" (unsupported)',
      "sortFieldsUi.sortField[]":
        '{ fieldName: string, order: "ascending"|"descending" }',
      "options.disableDotNotation": "boolean, default false",
    },
    requiresMock: false,
  },
  {
    type: "n8n-nodes-base.splitOut",
    summary:
      "Expands an array field into multiple items. Multiple split fields and selectedOtherFields are simplified to the first field with allOtherFields behavior.",
    parametersShape: {
      fieldToSplitOut:
        "string; supports dot notation and uses the first comma-separated field",
      include:
        '"noOtherFields" (default) | "allOtherFields" | "selectedOtherFields"',
      "options.destinationFieldName":
        "string; preserves the source field name when omitted",
    },
    requiresMock: false,
  },
  {
    type: "n8n-nodes-base.splitInBatches",
    summary:
      "Implements Loop Over Items by running the loop body once per batch and following its back-edge until all input items are processed. The done output receives the original input list. Nested loops and pairedItem tracking across iterations remain simplified.",
    parametersShape: {
      batchSize: "number, default 1; supports = expressions",
    },
    requiresMock: false,
  },
  {
    type: "n8n-nodes-base.dateTime",
    summary:
      "Luxon-based date operations. Selects one of seven operations and writes the result to the top-level outputFieldName, with operation-specific defaults.",
    parametersShape: {
      operation:
        '"formatDate" | "addToDate" | "subtractFromDate" | "getCurrentDate" | "extractDate" | "roundDate" | "getTimeBetweenDates"',
      date: "string used by date and format operations",
      magnitude: "string source date for add and subtract operations",
      timeUnit:
        '"years"|"quarters"|"months"|"weeks"|"days"|"hours"|"minutes"|"seconds"|"milliseconds"',
      duration: "number added or subtracted",
      outputFieldName: "top-level string field; defaults vary by operation",
    },
    requiresMock: false,
  },
  {
    type: "n8n-nodes-base.removeDuplicates",
    summary:
      "Removes duplicates in the current batch for removeDuplicateInputItems. Operations requiring cross-run history pass through because s8n does not persist execution state.",
    parametersShape: {
      operation:
        '"removeDuplicateInputItems" (default) | "removeItemsSeenInPreviousExecutions" (simplified) | "clearDeduplicationHistory" (simplified)',
      compare: '"allFields" (default) | "allFieldsExcept" | "selectedFields"',
      fieldsToExclude: "comma-separated string",
      fieldsToCompare: "comma-separated string",
    },
    requiresMock: false,
  },
  {
    type: "n8n-nodes-base.summarize",
    summary:
      "SQL GROUP BY-style aggregation. Groups by comma-separated fieldsToSplitBy, or treats all items as one group when omitted. Output keys always use an aggregation prefix plus the source field, such as concatenated_name.",
    parametersShape: {
      "fieldsToSummarize.values[]":
        '{ aggregation: "append"|"average"|"concatenate"|"count"|"countUnique"|"max"|"min"|"sum", field, includeEmpty?, separateBy?, customSeparator? }',
      fieldsToSplitBy: "string containing comma-separated grouping keys",
      "values[].separateBy":
        'literal separator (",", "/", "\\n", "", or " ") or "other" to use customSeparator',
      outputKey:
        '"<prefix>_<field>"; prefixes: append="appended", average="average", concatenate="concatenated", count="count", countUnique="unique_count", max="max", min="min", sum="sum"',
    },
    requiresMock: false,
  },
  {
    type: "n8n-nodes-base.stopAndError",
    summary:
      "Always throws an error and stops execution unless continueOnFail or a continuing onError mode handles it.",
    parametersShape: {
      errorType: '"errorMessage" (default) | "errorObject"',
      errorMessage: "string",
      errorObject: "JSON string",
    },
    requiresMock: false,
  },
  {
    type: "n8n-nodes-base.itemLists",
    summary:
      "Legacy multi-purpose node superseded by Split Out, Aggregate, Sort, Limit, and Remove Duplicates. It has no dedicated executor and is mocked; use the replacement nodes in new workflows.",
    parametersShape: {},
    requiresMock: true,
    mockKeyConvention: "<nodeName>",
  },
  {
    type: "(all unmodeled node types)",
    summary:
      "All other node types, including third-party integrations, are treated as unmodeled external I/O and mocked using the HTTP Request convention. An unmodeled start node emits --input without requesting a mock when input is provided.",
    parametersShape: {},
    requiresMock: true,
    mockKeyConvention: "<nodeName> or <nodeName>#<itemIndex>",
  },
  {
    type: "n8n-nodes-base.stickyNote",
    summary:
      "Canvas annotation node. It is excluded from execution and skipped without requesting a mock.",
    parametersShape: {},
    requiresMock: false,
  },
];

export function findNodeTypeDoc(type: string): NodeTypeDoc | undefined {
  return NODE_TYPE_DOCS.find((doc) => doc.type === type);
}
