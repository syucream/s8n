import { z } from "zod";
import { FAULT_KINDS } from "../faults.ts";
import { EMULATED_SERVICES } from "../integrations/types.ts";

const nonEmptyPathSchema = z.string().min(1);
const inlineItemSchema = z.record(z.string(), z.unknown());
const inlineInputSchema = z.union([
  inlineItemSchema,
  z.array(inlineItemSchema),
]);
const jsonPointerSchema = z.string().refine(
  (value) =>
    value === "" ||
    (value.startsWith("/") &&
      !value
        .split("/")
        .slice(1)
        .some((segment) => /~(?![01])/u.test(segment))),
  "Expected an RFC 6901 JSON Pointer",
);

const scenarioRunOverlayShape = {
  input: inlineInputSchema.optional(),
  mocks: z.record(z.string(), z.unknown()).optional(),
  inputFile: nonEmptyPathSchema.optional(),
  mocksFile: nonEmptyPathSchema.optional(),
  workflowMap: nonEmptyPathSchema.optional(),
  now: z.string().min(1).optional(),
  startNode: z.string().min(1).optional(),
  emulate: z.array(z.enum(EMULATED_SERVICES)).optional(),
  emulatorSeedFile: nonEmptyPathSchema.optional(),
  resolveCodeIncludes: z.boolean().optional(),
  codeMode: z.enum(["in-process", "vm", "os", "auto"]).optional(),
  codeTimeoutMs: z.number().int().positive().optional(),
  /**
   * Resume instructions for waiting nodes, keyed by node name. `"timeout"`
   * models expiry; an object is the payload delivered to the resumed node.
   */
  resume: z
    .record(
      z.string().min(1),
      z.union([z.record(z.string(), z.unknown()), z.literal("timeout")]),
    )
    .optional(),
};

function validateRunOverlay(
  overlay: ScenarioRunOverlay,
  context: z.RefinementCtx,
): void {
  if (overlay.input !== undefined && overlay.inputFile !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["inputFile"],
      message: "input and inputFile cannot both be set",
    });
  }
  if (overlay.mocks !== undefined && overlay.mocksFile !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["mocksFile"],
      message: "mocks and mocksFile cannot both be set",
    });
  }
  if (
    overlay.emulate !== undefined &&
    new Set(overlay.emulate).size !== overlay.emulate.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["emulate"],
      message: "emulate must not contain duplicate services",
    });
  }
}

export const scenarioRunOverlaySchema = z
  .object(scenarioRunOverlayShape)
  .strict()
  .superRefine(validateRunOverlay);

export type ScenarioRunOverlay = z.infer<typeof scenarioRunOverlaySchema>;

export const scenarioFaultSchema = z
  .object({
    node: z.string().min(1),
    kind: z.enum(FAULT_KINDS),
    statusCode: z.number().int().min(100).max(599).optional(),
    message: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((fault, context) => {
    if (fault.statusCode !== undefined && fault.kind !== "http-error") {
      context.addIssue({
        code: "custom",
        path: ["statusCode"],
        message: "statusCode is only valid for http-error faults",
      });
    }
  });

export type ScenarioFault = z.infer<typeof scenarioFaultSchema>;

const regexSchema = z
  .string()
  .min(1)
  .refine((pattern) => {
    try {
      new RegExp(pattern);
      return true;
    } catch {
      return false;
    }
  }, "Expected a valid regular expression");

/** Bounds substring occurrences inside a pointed-to string value. */
const occurrencesSchema = z
  .object({
    substring: z.string().min(1),
    atLeast: z.number().int().nonnegative().optional(),
    atMost: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((occurrences, context) => {
    if (occurrences.atLeast === undefined && occurrences.atMost === undefined) {
      context.addIssue({
        code: "custom",
        message: "Expected at least one of atLeast or atMost",
      });
    }
    if (
      occurrences.atLeast !== undefined &&
      occurrences.atMost !== undefined &&
      occurrences.atLeast > occurrences.atMost
    ) {
      context.addIssue({
        code: "custom",
        path: ["atMost"],
        message: "atMost must be greater than or equal to atLeast",
      });
    }
  });

/** String-checks applicable to any pointed-to value. */
const valueCheckShape = {
  exists: z.boolean().optional(),
  equals: z.unknown().optional(),
  /** Requires the pointed-to value to be a string matching this pattern. */
  matches: regexSchema.optional(),
  /** Requires the pointed-to value to be a string NOT matching this pattern. */
  notMatches: regexSchema.optional(),
  occurrences: occurrencesSchema.optional(),
} satisfies Record<string, z.ZodType>;

export const scenarioNodeOutputAssertionSchema = z
  .object({
    node: z.string().min(1),
    item: z.number().int().nonnegative().optional(),
    pointer: jsonPointerSchema.optional(),
    ...valueCheckShape,
  })
  .strict();
// Zod intentionally treats unknown as optional. The evaluator checks own
// property presence so equals: undefined differs from omitting equals.

export type ScenarioNodeOutputAssertion = z.infer<
  typeof scenarioNodeOutputAssertionSchema
>;

/** Checks the payload delivered to a called child workflow's entry trigger. */
export const scenarioSubExecutionInputAssertionSchema = z
  .object({
    /** The calling node name (the executeWorkflow node in the parent). */
    callNode: z.string().min(1),
    /** Which sub-workflow call from that node; defaults to 0. */
    index: z.number().int().nonnegative().optional(),
    item: z.number().int().nonnegative().optional(),
    pointer: jsonPointerSchema.optional(),
    ...valueCheckShape,
  })
  .strict();

export type ScenarioSubExecutionInputAssertion = z.infer<
  typeof scenarioSubExecutionInputAssertionSchema
>;

export const scenarioNodeRequestAssertionSchema = z
  .object({
    node: z.string().min(1),
    request: z.number().int().nonnegative().optional(),
    pointer: jsonPointerSchema.optional(),
    exists: z.boolean().optional(),
    equals: z.unknown().optional(),
  })
  .strict()
  .superRefine((assertion, context) => {
    if (assertion.exists === undefined && !Object.hasOwn(assertion, "equals")) {
      context.addIssue({
        code: "custom",
        message: "Expected exists or equals",
      });
    }
  });

export type ScenarioNodeRequestAssertion = z.infer<
  typeof scenarioNodeRequestAssertionSchema
>;

/** Identifies one directed main-connection edge in a workflow. */
export const scenarioEdgeAssertionSchema = z
  .object({
    sourceNode: z.string().min(1),
    sourceOutput: z.number().int().nonnegative(),
    destinationNode: z.string().min(1),
    destinationInput: z.number().int().nonnegative(),
  })
  .strict();

export type ScenarioEdgeAssertion = z.infer<typeof scenarioEdgeAssertionSchema>;

const itemCountBoundsShape = {
  exact: z.number().int().nonnegative().optional(),
  min: z.number().int().nonnegative().optional(),
  max: z.number().int().nonnegative().optional(),
};

function validateItemCountBounds(
  bounds: z.infer<z.ZodObject<typeof itemCountBoundsShape>>,
  context: z.RefinementCtx,
): void {
  if (
    bounds.exact === undefined &&
    bounds.min === undefined &&
    bounds.max === undefined
  ) {
    context.addIssue({
      code: "custom",
      message: "Expected at least one of exact, min, or max",
    });
  }
  if (
    bounds.min !== undefined &&
    bounds.max !== undefined &&
    bounds.min > bounds.max
  ) {
    context.addIssue({
      code: "custom",
      path: ["max"],
      message: "max must be greater than or equal to min",
    });
  }
  if (
    bounds.exact !== undefined &&
    ((bounds.min !== undefined && bounds.exact < bounds.min) ||
      (bounds.max !== undefined && bounds.exact > bounds.max))
  ) {
    context.addIssue({
      code: "custom",
      path: ["exact"],
      message: "exact must be within min and max bounds",
    });
  }
}

/** Checks the final flattened main-output item count for one node. */
export const scenarioNodeOutputCardinalityAssertionSchema = z
  .object({
    node: z.string().min(1),
    ...itemCountBoundsShape,
  })
  .strict()
  .superRefine(validateItemCountBounds);

export type ScenarioNodeOutputCardinalityAssertion = z.infer<
  typeof scenarioNodeOutputCardinalityAssertionSchema
>;

/** Checks origin identifiers retained for one final main-output item. */
export const scenarioNodeOutputLineageAssertionSchema = z
  .object({
    node: z.string().min(1),
    item: z.number().int().nonnegative().optional(),
    lineage: z.array(z.string().min(1)).optional(),
    lineageContains: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()
  .superRefine((assertion, context) => {
    if (
      assertion.lineage === undefined &&
      assertion.lineageContains === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Expected lineage or lineageContains",
      });
    }
  });

export type ScenarioNodeOutputLineageAssertion = z.infer<
  typeof scenarioNodeOutputLineageAssertionSchema
>;

export const scenarioAssertionsSchema = z
  .object({
    status: z
      .enum(["success", "error", "waiting", "needs_mock", "needs_start_node"])
      .optional(),
    minimumCoverage: z.number().min(0).max(1).optional(),
    minimumBranchCoverage: z.number().min(0).max(1).optional(),
    requiredNodes: z.array(z.string().min(1)).optional(),
    forbiddenNodes: z.array(z.string().min(1)).optional(),
    requiredEdges: z.array(scenarioEdgeAssertionSchema).optional(),
    forbiddenEdges: z.array(scenarioEdgeAssertionSchema).optional(),
    pendingMockCount: z.number().int().nonnegative().optional(),
    verifiedEffects: z.boolean().optional(),
    subExecutionCount: z.number().int().nonnegative().optional(),
    nodeOutputItemCounts: z
      .record(z.string().min(1), z.number().int().nonnegative())
      .optional(),
    nodeOutputCardinality: z
      .array(scenarioNodeOutputCardinalityAssertionSchema)
      .optional(),
    nodeOutputs: z.array(scenarioNodeOutputAssertionSchema).optional(),
    nodeRequests: z.array(scenarioNodeRequestAssertionSchema).optional(),
    nodeOutputLineage: z
      .array(scenarioNodeOutputLineageAssertionSchema)
      .optional(),
    subExecutionInputs: z
      .array(scenarioSubExecutionInputAssertionSchema)
      .optional(),
  })
  .strict();

export type ScenarioAssertions = z.infer<typeof scenarioAssertionsSchema>;

const scenarioCaseBaseSchema = z.object({
  name: z.string().min(1),
  faults: z.array(scenarioFaultSchema).optional(),
  assertions: scenarioAssertionsSchema.optional(),
  /**
   * Golden-file path (relative to this manifest) for the case's final
   * `nodeOutputs`. `s8n rehearse --update-snapshots` writes it; plain
   * rehearsals fail when the observed outputs diverge from it.
   */
  snapshot: nonEmptyPathSchema.optional(),
});

export const scenarioCaseSchema = scenarioCaseBaseSchema
  .extend(scenarioRunOverlayShape)
  .strict()
  .superRefine((scenario, context) => {
    validateRunOverlay(scenario, context);
    const targetedNodes = new Set<string>();
    scenario.faults?.forEach((fault, index) => {
      if (targetedNodes.has(fault.node)) {
        context.addIssue({
          code: "custom",
          path: ["faults", index, "node"],
          message: `Duplicate fault target: ${fault.node}`,
        });
      }
      targetedNodes.add(fault.node);
    });
  });

export type ScenarioCase = z.infer<typeof scenarioCaseSchema>;

export const scenarioGeneratedFromSchema = z
  .object({
    kind: z.literal("n8n-execution-log"),
    dataMode: z.literal("synthetic-shape"),
    reviewRequired: z.literal(true),
    warnings: z.array(z.string().min(1)),
  })
  .strict();

export type ScenarioGeneratedFrom = z.infer<typeof scenarioGeneratedFromSchema>;

export const scenarioManifestSchema = z
  .object({
    version: z.literal(1),
    generatedFrom: scenarioGeneratedFromSchema.optional(),
    /**
     * Normalized LLM outputs extracted from a real execution log when the
     * manifest was drafted via `scenario import`; informational review data.
     */
    llmOutputs: z
      .array(
        z
          .object({
            node: z.string().min(1),
            kind: z.enum(["agent-output", "language-model", "chain-text"]),
            text: z.string().optional(),
            output: z.unknown().optional(),
          })
          .strict(),
      )
      .optional(),
    defaults: scenarioRunOverlaySchema.default({}),
    cases: z.array(scenarioCaseSchema).min(1),
  })
  .strict()
  .superRefine((manifest, context) => {
    const names = new Set<string>();
    manifest.cases.forEach((entry, index) => {
      if (names.has(entry.name)) {
        context.addIssue({
          code: "custom",
          path: ["cases", index, "name"],
          message: `Duplicate scenario case name: ${entry.name}`,
        });
      }
      names.add(entry.name);

      // Inline/file pairs are mutually exclusive within one overlay. Across
      // defaults and a case, the case deliberately replaces its counterpart.
    });
  });

export type ScenarioManifest = z.infer<typeof scenarioManifestSchema>;
