---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

## s8n project notes

- s8n is an independent n8n workflow simulator. Do not copy source code or
  real workflow/sample data from private or third-party repositories into
  this repo; use them only as background reading. Node type identifiers like
  `n8n-nodes-base.httpRequest` are used as a compatible file-format
  convention, not copied code.
- Quality gates: `bun run check` (English policy + biome + tsc --noEmit + bun
  test) and `bun run quality` (check + standalone build + stateful emulator +
  live community-template verification) must pass for a release.
  Single-binary build: `bun run build` (bun build --compile).
- Write all repository-facing prose in English, including documentation,
  comments, CLI help and error messages, schema descriptions, fixtures, and
  test names. `bun run check` enforces this policy for tracked file names and
  text; do not bypass or weaken the check.
- Any node type not explicitly implemented in `src/nodes/builtin/` falls back
  to `generic-fallback.ts` (mock-based, never a hard error) - see
  `src/engine/execute.ts`. Only add a dedicated executor for node types with
  real local-compute/control-flow semantics (Set, If, Merge, Aggregate...), or
  for the two generic IO *primitives* every other integration node reduces to
  (HTTP Request, Webhook) where richer mock-request plumbing earns its keep.
  App-specific integration nodes (Slack, Notion, BigQuery, ...) should stay on
  the generic fallback rather than becoming registry executors. Explicit
  stateful emulation belongs behind the generic fallback's integration runner;
  without `--emulate`, the same node must continue to request ordinary mocks.
- Before implementing or fixing a node type's parameter shape, verify the
  exact field names against the upstream n8n source (do not guess). Several
  simplified assumptions can be incorrect, such as Set's
  `includeOtherFields` default. Private workflow exports may be consulted to
  understand real-world node shapes and expressions, but never copy their
  content into this repo, even as test fixtures.
- `$now`/`$today` in expressions and Code nodes are Luxon `DateTime` objects
  (matching real n8n's `workflow-data-proxy.ts`), not plain strings/ISO
  text - `.minus()/.toFormat()` etc. are common in real workflows.
- Engine invariants worth remembering: a node only fires once ALL of its
  required input slots have received >=1 delivery (not once ALL source
  nodes have delivered - multiple sources into the same slot is OR, not
  AND); a node with zero total input items across all slots is skipped
  entirely unless `alwaysOutputData` is set (matches real n8n's
  `executionOrder: "v1"` behavior); only one start/trigger node fires per
  run (`--start-node` picks among several, e.g. Manual + Execute Workflow
  Trigger dual-entry workflows).

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
