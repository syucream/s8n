/**
 * Every s8n CLI command prints exactly one JSON object to stdout in this
 * envelope, so a calling AI agent can parse the result the same way
 * regardless of which command ran.
 */
export interface CliEnvelope<T> {
  ok: boolean;
  command: string;
  data?: T;
  issues?: { path: string; message: string }[];
  error?: string;
}

export function printEnvelope<T>(envelope: CliEnvelope<T>): void {
  console.log(JSON.stringify(envelope, null, 2));
}
