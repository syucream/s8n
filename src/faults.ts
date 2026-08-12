/**
 * A deliberately small, local-only failure contract for scenario rehearsal.
 *
 * Faults are matched by node name at the mocked external-I/O boundary. They
 * never perform I/O or wait for wall-clock time; a timeout is represented by
 * the same deterministic node error a caller would observe after a timeout.
 */
export const FAULT_KINDS = ["timeout", "http-error", "malformed-json"] as const;

export type FaultKind = (typeof FAULT_KINDS)[number];

export interface ScenarioFault {
  node: string;
  kind: FaultKind;
  /** HTTP status for `http-error`; defaults to 500. */
  statusCode?: number;
  /** Optional stable diagnostic detail included in the injected error. */
  message?: string;
}

export interface FaultLookup {
  get: (nodeName: string) => ScenarioFault | undefined;
}

export function createFaultLookup(
  faults: readonly ScenarioFault[] | undefined,
): FaultLookup | undefined {
  if (faults === undefined || faults.length === 0) return undefined;
  const byNode = new Map(faults.map((fault) => [fault.node, fault]));
  return { get: (nodeName) => byNode.get(nodeName) };
}

/** Formats a safe, deterministic error without exposing a mock response. */
export function formatFaultMessage(fault: ScenarioFault): string {
  const base =
    fault.kind === "timeout"
      ? `Injected timeout fault for node "${fault.node}"`
      : fault.kind === "http-error"
        ? `Injected HTTP error ${fault.statusCode ?? 500} for node "${fault.node}"`
        : `Injected malformed JSON fault for node "${fault.node}"`;
  return fault.message === undefined ? base : `${base}: ${fault.message}`;
}
