/**
 * Prevent ordinary workflow expressions and Code nodes from reaching host I/O.
 *
 * This is a local guardrail for trusted workflow definitions, not a security
 * boundary for hostile JavaScript. JavaScript isolation requires an OS-level
 * sandbox or a separate hardened runtime, which s8n does not claim to provide.
 */
const isolatedGlobal = Object.freeze(Object.create(null));

export const SAFE_RUNTIME_GLOBALS: Record<string, unknown> = Object.freeze({
  fetch: undefined,
  process: undefined,
  Bun: undefined,
  Deno: undefined,
  require: undefined,
  WebSocket: undefined,
  EventSource: undefined,
  XMLHttpRequest: undefined,
  global: isolatedGlobal,
  globalThis: isolatedGlobal,
  self: isolatedGlobal,
  window: isolatedGlobal,
  Function: undefined,
});
