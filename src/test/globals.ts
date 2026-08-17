import { defineSuite } from "./suite.ts";

export interface S8nGlobals {
  defineSuite: typeof defineSuite;
}

/**
 * Installs the test DSL on `globalThis` so a test file can use `defineSuite`
 * without importing anything (the CLI does this before loading a test file).
 * Files that import from the s8n package keep working: the imported binding
 * shadows the global, and both reference the same function.
 */
export function installTestGlobals(): void {
  const target = globalThis as typeof globalThis & S8nGlobals;
  target.defineSuite = defineSuite;
}
