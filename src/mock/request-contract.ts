import type {
  MockCardinalityHint,
  MockHintConfidence,
  MockProvenance,
} from "../nodes/types.ts";

export interface MockContractEvidenceOptions {
  /** Fields directly referenced through downstream `$json` expressions. */
  suggestedFields: string[];
  /** Public, type-specific response guidance if one is available. */
  nodeHint?: string;
  /** Resolved user configuration that informed the request. */
  userContext?: string;
  /** Add an explicit fallback statement when no stronger shape is available. */
  genericContext?: string;
}

/**
 * The default preserves the existing mock format: one object becomes one
 * output item, while an array remains the opt-in way to model fan-out.
 */
export const defaultMockCardinalityHint: MockCardinalityHint = {
  minItems: 1,
  preferredItems: 1,
  allowsMultiple: true,
};

function evidence(
  source: MockProvenance["source"],
  confidence: MockHintConfidence,
  detail: string,
): MockProvenance {
  return { source, confidence, detail };
}

/**
 * Builds explainable, additive metadata for a pending mock request. The
 * metadata deliberately does not validate or alter supplied mock values.
 */
export function buildMockContractEvidence(
  options: MockContractEvidenceOptions,
): MockProvenance[] {
  const result: MockProvenance[] = [];
  if (options.suggestedFields.length > 0) {
    result.push(
      evidence(
        "downstream-expression",
        "high",
        `Downstream $json expressions reference: ${options.suggestedFields.join(", ")}.`,
      ),
    );
  }
  if (options.nodeHint) {
    result.push(evidence("node-hint", "medium", options.nodeHint));
  }
  if (options.userContext) {
    result.push(evidence("user", "high", options.userContext));
  }
  if (options.genericContext) {
    result.push(evidence("generic", "low", options.genericContext));
  }
  return result;
}
