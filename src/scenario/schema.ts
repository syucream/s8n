import { z } from "zod";
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

export const scenarioNodeOutputAssertionSchema = z
  .object({
    node: z.string().min(1),
    item: z.number().int().nonnegative().optional(),
    pointer: jsonPointerSchema.optional(),
    exists: z.boolean().optional(),
    equals: z.unknown().optional(),
  })
  .strict();
// Zod intentionally treats unknown as optional. The evaluator checks own
// property presence so equals: undefined differs from omitting equals.

export type ScenarioNodeOutputAssertion = z.infer<
  typeof scenarioNodeOutputAssertionSchema
>;

export const scenarioAssertionsSchema = z
  .object({
    status: z
      .enum(["success", "error", "needs_mock", "needs_start_node"])
      .optional(),
    minimumCoverage: z.number().min(0).max(1).optional(),
    requiredNodes: z.array(z.string().min(1)).optional(),
    forbiddenNodes: z.array(z.string().min(1)).optional(),
    pendingMockCount: z.number().int().nonnegative().optional(),
    verifiedEffects: z.boolean().optional(),
    subExecutionCount: z.number().int().nonnegative().optional(),
    nodeOutputItemCounts: z
      .record(z.string().min(1), z.number().int().nonnegative())
      .optional(),
    nodeOutputs: z.array(scenarioNodeOutputAssertionSchema).optional(),
  })
  .strict();

export type ScenarioAssertions = z.infer<typeof scenarioAssertionsSchema>;

const scenarioCaseBaseSchema = z.object({
  name: z.string().min(1),
  assertions: scenarioAssertionsSchema.optional(),
});

export const scenarioCaseSchema = scenarioCaseBaseSchema
  .extend(scenarioRunOverlayShape)
  .strict()
  .superRefine(validateRunOverlay);

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
