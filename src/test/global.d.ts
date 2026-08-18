import type { SuiteConfig, TestFn, TestSuite } from "./types.ts";

/**
 * Ambient declarations for the globals injected by `s8n test`. They let a
 * test file written without imports type-check against the injected DSL.
 * Reference them with a `/// <reference types="s8n/globals" />` directive or
 * by importing from the s8n package. Nothing here runs at runtime.
 */
declare global {
  function defineSuite(
    config: SuiteConfig,
    register: (test: (name: string, fn: TestFn) => void) => void,
  ): TestSuite;
}
