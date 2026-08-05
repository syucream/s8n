# Contributing

## Prerequisites

- Bun 1.3.4, as pinned by the `packageManager` field in `package.json`
- Git

Install the locked dependencies:

```bash
bun install --frozen-lockfile
```

## Development checks

Before opening a pull request, run:

```bash
bun run check
bun run build
./dist/s8n --version
```

`bun run check` applies the English-language repository policy, Biome checks,
TypeScript type checking, and the Bun test suite. The standalone build is a
separate required check because a type-correct CLI can still fail during Bun
compilation.

Use `bun run quality` for release-level changes to the execution engine,
emulators, expression handling, or supported node contracts. Some quality
gates fetch hash-pinned or structurally neutralized public workflow fixtures;
read their safety notes in the README before changing those policies.

## Pull requests

- Keep unrelated working-tree changes out of the commit.
- Add normal and failure-path tests for behavior changes.
- Update `NODE_SUPPORT.md` when a node changes support tier or an emulator adds
  an operation.
- Update `SERVICE_EMULATION.md` when emulator fidelity or limitations change.
- Keep all repository-facing text in English.

GitHub Actions runs lint, build, and test as separate required-check candidates
so failures have a clear owner. Repository administrators can mark the checks
named `Lint`, `Build`, and `Test` as required in branch protection.

## Releases

1. Update `version` in `package.json`, the CLI version in
   `src/cli/index.ts`, and `CHANGELOG.md` in the release commit.
2. Run `bun run quality` from a clean checkout.
3. Create and push a `vX.Y.Z` tag matching `package.json` exactly.
4. The release workflow re-runs `bun run quality`, builds platform-specific
   standalone executables, creates `SHA256SUMS`, and publishes a GitHub Release.

The release workflow rejects a tag whose version does not match
`package.json`. Each published platform artifact is a single executable and
does not require Bun at runtime.
