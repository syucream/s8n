/**
 * The unit of data flowing between nodes. A node receives an array of items
 * on each input slot and returns an array of items on each output slot -
 * mirroring the "one execution = many records" model common to node-based
 * automation tools, without depending on any third-party implementation.
 */
export interface BinaryRef {
  mimeType: string;
  fileName?: string;
  /** Mock IO never carries real bytes; this is a stable label for tracing. */
  mockRef: string;
}

export interface PairedItem {
  /** Index into the input item array this output item was derived from. */
  item: number;
}

export interface Item {
  json: Record<string, unknown>;
  binary?: Record<string, BinaryRef>;
  pairedItem?: PairedItem;
}

export function toItems(values: Record<string, unknown>[]): Item[] {
  return values.map((json, index) => ({ json, pairedItem: { item: index } }));
}
