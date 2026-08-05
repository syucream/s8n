#!/usr/bin/env bun
import { createHash } from "node:crypto";
import ts from "typescript";
import { type RunResult, runWorkflow } from "../src/engine/execute.ts";
import { EmulatorIntegrationRunner } from "../src/integrations/emulator.ts";
import type {
  EmulatedService,
  EmulatorSeed,
  IntegrationEffect,
} from "../src/integrations/types.ts";
import { createMockLookup, emptyMockLookup } from "../src/mock/provider.ts";
import { createDefaultRegistry } from "../src/nodes/registry.ts";
import { toItems } from "../src/schema/item.ts";
import { validateWorkflow, type Workflow } from "../src/schema/workflow.ts";

const API_ROOT = "https://api.n8n.io/api/templates/workflows";
const REVIEWED_IDS = [1049, 5889, 7502, 11728, 15245] as const;
const REVIEWED_SHA256: Record<number, string> = {
  1049: "08c90f98d314ae28d0a2136dbb3d1c841bb27e1190afc747642f6cd60f2300f2",
  5889: "2fde37e1b167fd3fc36e5cb340720cf908a80a01900f424f9aed824fbb01b011",
  7502: "e23b04225cc9009d3771c2b1b27acaeb1e100307a00127c346c6067a3d025f17",
  11728: "62b910f6018119e3fe8e2f1dbc53e51e0bb9fb0b647ec3414b6a602f16643a75",
  15245: "3a61da060a1ecfe0b474ab29dca672c8264e7006b976703d2a117ab9718f21d4",
};

interface TemplatePayload {
  workflow?: { name?: string; workflow?: unknown };
}

interface LoadedTemplate {
  id: number;
  title: string;
  source: string;
  hash: string;
  workflow: Workflow;
}

interface ScenarioReport {
  template: LoadedTemplate;
  purpose: string;
  result: RunResult;
  assertions: Record<string, boolean>;
}

const INTERPOLATION_RE = /\{\{([\s\S]*?)\}\}/g;
const BLOCKED_IDENTIFIERS = new Set([
  "Bun",
  "Deno",
  "Function",
  "eval",
  "fetch",
  "globalThis",
  "process",
  "require",
]);
const BLOCKED_PROPERTIES = new Set([
  "__defineGetter__",
  "__defineSetter__",
  "__proto__",
  "constructor",
  "prototype",
]);
const ALLOWED_METHODS = new Set([
  "$",
  "$fromAI",
  "all",
  "concat",
  "endsWith",
  "first",
  "format",
  "includes",
  "join",
  "last",
  "map",
  "now",
  "parseJson",
  "slice",
  "startsWith",
  "toDateTime",
  "toFixed",
  "toFormat",
  "toLowerCase",
  "toUpperCase",
  "trim",
]);
const BLOCKED_SYNTAX = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AwaitExpression,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.DeleteExpression,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.NewExpression,
  ts.SyntaxKind.PostfixUnaryExpression,
  ts.SyntaxKind.TaggedTemplateExpression,
  ts.SyntaxKind.YieldExpression,
]);

function assertSafeExpression(expression: string, label: string): void {
  const normalized = expression.trim().replace(/;$/, "");
  const source = ts.createSourceFile(
    "workflow-expression.ts",
    `const value = (${normalized});`,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const diagnostics = (
    source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  if (diagnostics.length > 0)
    throw new Error(`${label} has invalid expression syntax`);
  const visit = (node: ts.Node): void => {
    if (BLOCKED_SYNTAX.has(node.kind))
      throw new Error(
        `${label} uses blocked syntax ${ts.SyntaxKind[node.kind]}`,
      );
    if (
      ts.isPrefixUnaryExpression(node) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(
        node.operator,
      )
    )
      throw new Error(`${label} contains a mutating unary expression`);
    if (ts.isIdentifier(node) && BLOCKED_IDENTIFIERS.has(node.text))
      throw new Error(`${label} uses blocked identifier ${node.text}`);
    if (
      ts.isPropertyAccessExpression(node) &&
      BLOCKED_PROPERTIES.has(node.name.text)
    )
      throw new Error(`${label} uses blocked property ${node.name.text}`);
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      BLOCKED_PROPERTIES.has(node.argumentExpression.text)
    )
      throw new Error(
        `${label} uses blocked property ${node.argumentExpression.text}`,
      );
    if (ts.isCallExpression(node)) {
      const method = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : "";
      if (!ALLOWED_METHODS.has(method))
        throw new Error(
          `${label} calls non-whitelisted method ${method || "<computed>"}`,
        );
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      throw new Error(`${label} contains an assignment`);
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function assertSafeWorkflowExpressions(value: unknown, label: string): void {
  if (typeof value === "string" && value.startsWith("=")) {
    for (const match of value.matchAll(INTERPOLATION_RE))
      assertSafeExpression(match[1] ?? "", label);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => {
      assertSafeWorkflowExpressions(entry, label);
    });
    return;
  }
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach((entry) => {
      assertSafeWorkflowExpressions(entry, label);
    });
  }
}

function assertScenario(report: ScenarioReport): ScenarioReport {
  return report;
}

async function loadTemplate(id: number): Promise<LoadedTemplate> {
  const source = `${API_ROOT}/${id}`;
  const response = await fetch(source, {
    headers: { "user-agent": "s8n-real-service-simulation/0.3" },
  });
  if (!response.ok) throw new Error(`Template ${id}: HTTP ${response.status}`);
  const payload = (await response.json()) as TemplatePayload;
  const raw = payload.workflow?.workflow;
  const hash = createHash("sha256").update(JSON.stringify(raw)).digest("hex");
  if (hash !== REVIEWED_SHA256[id]) {
    throw new Error(
      `Template ${id} changed after review; refusing to evaluate expressions (expected ${REVIEWED_SHA256[id]}, got ${hash})`,
    );
  }
  assertSafeWorkflowExpressions(raw, `Template ${id}`);
  const candidate =
    raw !== null && typeof raw === "object"
      ? {
          name: payload.workflow?.name ?? `Template ${id}`,
          id: String(id),
          ...raw,
        }
      : raw;
  const validated = validateWorkflow(candidate);
  if (!validated.valid || !validated.workflow)
    throw new Error(
      `Template ${id} validation failed: ${JSON.stringify(validated.issues)}`,
    );
  if (
    validated.workflow.nodes.some((node) => node.type === "n8n-nodes-base.code")
  ) {
    throw new Error(`Template ${id} contains untrusted Code nodes`);
  }
  return {
    id,
    title: payload.workflow?.name ?? validated.workflow.name,
    source: `https://n8n.io/workflows/${id}`,
    hash,
    workflow: validated.workflow,
  };
}

async function execute(
  template: LoadedTemplate,
  services: EmulatedService[],
  options: {
    input?: Record<string, unknown>;
    mocks?: Record<string, unknown>;
    seed?: EmulatorSeed;
    startNode?: string;
  } = {},
): Promise<RunResult> {
  const runner = await EmulatorIntegrationRunner.create(services, options.seed);
  try {
    return await runWorkflow(template.workflow, {
      initialInput: toItems([options.input ?? {}]),
      hasExplicitInput: true,
      mocks: options.mocks ? createMockLookup(options.mocks) : emptyMockLookup,
      registry: createDefaultRegistry(),
      now: new Date("2026-08-03T09:00:00.000Z"),
      startNode: options.startNode,
      integrationRunner: runner,
    });
  } finally {
    await runner.close();
  }
}

function operation(
  result: RunResult,
  name: string,
): IntegrationEffect | undefined {
  return result.effects.find((effect) => effect.operation === name);
}

async function simulateIssToBigQuery(
  template: LoadedTemplate,
): Promise<ScenarioReport> {
  const result = await execute(template, ["gcp"], {
    mocks: {
      "HTTP Request": {
        "0": {
          name: "iss",
          latitude: 35.6812,
          longitude: 139.7671,
          timestamp: 1785747600,
        },
      },
    },
    startNode: "Cron",
  });
  const inserted = operation(result, "bigquery.tabledata.insertAll");
  const row = (
    inserted?.response as Array<Record<string, unknown>> | undefined
  )?.[0];
  return assertScenario({
    template,
    purpose:
      "Fetch an ISS position, normalize it, and insert the row into BigQuery.",
    result,
    assertions: {
      workflowSucceeded: result.status === "success",
      normalizedCoordinates:
        row?.name === "iss" &&
        row?.latitude === 35.6812 &&
        row?.longitude === 139.7671,
      bigQueryWriteReadBack: inserted?.verified === true,
    },
  });
}

async function simulateNotionToGithub(
  template: LoadedTemplate,
): Promise<ScenarioReport> {
  const result = await execute(template, ["notion", "github", "gws"], {
    startNode: "Schedule Trigger",
    seed: {
      stores: {
        "notion.databasePages": [
          {
            id: "feature-101",
            name: "Offline checkout mode",
            property_description: "Allow orders to queue during an outage.",
            property_labels: ["enhancement"],
            property_repository: ["product-app"],
            property_status: "To develop",
          },
          {
            id: "feature-099",
            name: "Improve audit log",
            property_description: "Audit log shipped.",
            property_labels: ["completed"],
            property_repository: ["product-app"],
            property_status: "Done",
          },
        ],
        "notion.users": [
          {
            id: "user-1",
            name: "Product Owner",
            person: { email: "owner@example.com" },
            type: "person",
          },
          {
            id: "bot-1",
            name: "Automation Bot",
            person: { email: "bot@example.com" },
            type: "bot",
          },
        ],
      },
    },
  });
  const issue = operation(result, "issues.create");
  const notionUpdate = operation(result, "databasePages.update");
  const mail = operation(result, "gmail.users.messages.send");
  return assertScenario({
    template,
    purpose:
      "Route Notion feature rows by status, create a GitHub issue, update Notion, and notify people about completed work.",
    result,
    assertions: {
      workflowSucceeded: result.status === "success",
      githubIssueCreated:
        (issue?.response as Record<string, unknown> | undefined)?.title ===
        "Offline checkout mode",
      notionStatusAndUrlUpdated:
        notionUpdate?.verified === true &&
        (
          notionUpdate.response as
            | { properties?: Record<string, unknown> }
            | undefined
        )?.properties?.Status === "In progress",
      completionMailSent:
        mail?.verified === true &&
        String(
          (mail?.request as Record<string, unknown> | undefined)?.sendTo,
        ).includes("owner@example.com"),
    },
  });
}

async function simulateGcsLifecycle(
  template: LoadedTemplate,
): Promise<ScenarioReport> {
  const result = await execute(template, ["gcp"], {
    input: {
      project_id: "s8n-quality",
      location: "US",
      image_description: "A clean integration evidence diagram",
    },
    mocks: {
      "Prompt Generation Agent": {
        output: "A clean integration evidence diagram on a white background",
      },
      "Generate an image": {
        fileExtension: "png",
        content: "simulated-image-bytes",
      },
    },
    startNode: "When clicking ‘Execute workflow’",
  });
  const bucket = operation(result, "storage.buckets.create");
  const objectCreated = operation(result, "storage.objects.create");
  const objectDeleted = operation(result, "storage.objects.delete");
  return assertScenario({
    template,
    purpose:
      "Create a GCS bucket, generate a deterministic image result, upload it, and delete the object.",
    result,
    assertions: {
      workflowSucceeded: result.status === "success",
      bucketCreated: bucket?.verified === true,
      objectUploaded:
        objectCreated?.verified === true &&
        String(
          (objectCreated.response as Record<string, unknown> | undefined)?.name,
        ).endsWith(".png"),
      objectDeletionObserved:
        objectDeleted?.verified === true &&
        (objectDeleted.response as Record<string, unknown> | undefined)
          ?.deleted === true,
    },
  });
}

async function simulateJiraToGithub(
  template: LoadedTemplate,
): Promise<ScenarioReport> {
  const jiraEvent = {
    webhookEvent: "jira:issue_updated",
    issue: {
      key: "WEB-42",
      fields: {
        status: { name: "In Progress" },
        labels: ["product_approved"],
        summary: "Checkout fails after network reconnect",
        description: "Queued orders are not retried.",
        issuetype: { name: "Bug" },
        project: { key: "WEB", name: "Web Store" },
        customfield_10308: { value: "checkout-service" },
      },
    },
  };
  const result = await execute(template, ["jira", "github"], {
    input: jiraEvent,
    startNode: "On Jira ticket updated",
    seed: {
      stores: {
        "jira.issues": [
          {
            id: "WEB-42",
            key: "WEB-42",
            fields: jiraEvent.issue.fields,
          },
        ],
      },
    },
    mocks: {
      "Extract context from Port": { invocationIdentifier: "invocation-1" },
      "Parse Port AI response": {
        result: {
          message: JSON.stringify({
            github_issue_title: "WEB-42 Retry queued orders after reconnect",
            github_issue_body:
              "Checkout service drops queued orders after reconnect. @github-copilot please begin working on this issue.",
          }),
        },
      },
    },
  });
  const issue = operation(result, "issues.create");
  const copilotComment = operation(result, "issues.comments.create");
  const jiraUpdate = operation(result, "issues.update");
  return assertScenario({
    template,
    purpose:
      "Turn an approved Jira bug into a GitHub issue, assign Copilot, link it back, and mark Jira handled.",
    result,
    assertions: {
      workflowSucceeded: result.status === "success",
      githubIssueCreated:
        (issue?.response as Record<string, unknown> | undefined)?.title ===
        "WEB-42 Retry queued orders after reconnect",
      copilotAssigned:
        copilotComment?.service === "github" && copilotComment.verified,
      jiraLinkCommented: result.effects.some(
        (effect) =>
          effect.service === "jira" &&
          effect.operation === "issues.comments.create" &&
          String((effect.request as Record<string, unknown>).comment).includes(
            "github.com",
          ),
      ),
      jiraLabelUpdated:
        jiraUpdate?.verified === true &&
        Array.isArray(
          (
            jiraUpdate.response as
              | { fields?: Record<string, unknown> }
              | undefined
          )?.fields?.labels,
        ) &&
        (
          jiraUpdate.response as { fields: { labels: string[] } }
        ).fields.labels.includes("copilot_assigned"),
    },
  });
}

async function simulateVertexInbox(
  template: LoadedTemplate,
): Promise<ScenarioReport> {
  const result = await execute(template, ["gws", "gcp"], {
    startNode: "Schedule Trigger",
    seed: {
      stores: {
        "gws.gmail.messages": [
          {
            id: "mail-1",
            threadId: "thread-1",
            From: "manager@example.com",
            To: "agent@example.com",
            Subject: "Approve the launch checklist",
            snippet: "Please review and approve the launch checklist today.",
            labelIds: ["INBOX", "UNREAD"],
          },
          {
            id: "mail-2",
            threadId: "thread-2",
            From: "shipping@example.com",
            To: "agent@example.com",
            Subject: "Package dispatched",
            snippet: "Your package is on its way and arrives tomorrow.",
            labelIds: ["INBOX", "UNREAD"],
          },
        ],
      },
    },
    mocks: {
      "Analyze importance and reply needs via AI#0": {
        output: { id: "mail-1", importance: 1, reply_required: 1 },
      },
      "Analyze importance and reply needs via AI#1": {
        output: { id: "mail-2", importance: 2, reply_required: 0 },
      },
      "Google Task writer": {
        output: "Created task: Approve launch checklist",
      },
      "Generate daily summary message": {
        text: "Daily Summary: manager requests launch checklist approval today.",
      },
      "Generate AI draft": {
        text: "Thanks, I will review and approve the checklist today.",
      },
    },
  });
  const vertexCalls = result.effects.filter(
    (effect) => effect.operation === "vertex.models.generateContent",
  );
  const sentSummary = operation(result, "gmail.users.messages.send");
  return assertScenario({
    template,
    purpose:
      "Classify a seeded Gmail message with Vertex AI, update labels, create a reply draft, and send a daily summary.",
    result,
    assertions: {
      workflowSucceeded: result.status === "success",
      vertexPromptAndResponsesRecorded:
        vertexCalls.length >= 2 &&
        vertexCalls.every((effect) => effect.verified),
      gmailLabelsMutated: result.effects.some(
        (effect) =>
          effect.operation === "gmail.users.messages.addLabels" &&
          effect.verified,
      ),
      dailySummarySent:
        sentSummary?.verified === true &&
        String(
          (sentSummary.request as Record<string, unknown>).message,
        ).includes("launch checklist"),
      replyDraftCreated: result.effects.some(
        (effect) => effect.operation === "gmail.users.drafts.create",
      ),
    },
  });
}

const templates = new Map(
  (await Promise.all(REVIEWED_IDS.map(loadTemplate))).map((template) => [
    template.id,
    template,
  ]),
);
const get = (id: number) => {
  const template = templates.get(id);
  if (!template) throw new Error(`Template ${id} was not loaded`);
  return template;
};
const reports = [
  await simulateIssToBigQuery(get(1049)),
  await simulateNotionToGithub(get(5889)),
  await simulateGcsLifecycle(get(7502)),
  await simulateJiraToGithub(get(11728)),
  await simulateVertexInbox(get(15245)),
];

function compact(value: unknown, depth = 0): unknown {
  if (typeof value === "string")
    return value.length > 240 ? `${value.slice(0, 237)}...` : value;
  if (depth >= 4) return Array.isArray(value) ? "[nested]" : "{nested}";
  if (Array.isArray(value))
    return value.slice(0, 8).map((entry) => compact(entry, depth + 1));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 20)
        .map(([key, entry]) => [key, compact(entry, depth + 1)]),
    );
  return value;
}

const summaryOnly = process.argv.includes("--summary");
const gatePassed = reports.every((report) =>
  Object.values(report.assertions).every(Boolean),
);

console.log(
  JSON.stringify(
    {
      ok: gatePassed,
      gate: "real-service-workflows",
      fetchedAt: new Date().toISOString(),
      workflows: reports.map((report) => ({
        source: {
          id: report.template.id,
          title: report.template.title,
          url: report.template.source,
          sha256: report.template.hash,
        },
        purpose: report.purpose,
        status: report.result.status,
        assertions: report.assertions,
        errors: report.result.trace
          .filter((entry) => entry.status === "error")
          .map((entry) => ({ node: entry.nodeName, error: entry.error })),
        reachedNodes: report.result.trace
          .filter((entry) => ["success", "pinned"].includes(entry.status))
          .map((entry) => entry.nodeName),
        effects: report.result.effects.map((effect) =>
          summaryOnly
            ? {
                node: effect.nodeName,
                service: effect.service,
                operation: effect.operation,
                verified: effect.verified,
              }
            : {
                node: effect.nodeName,
                service: effect.service,
                operation: effect.operation,
                request: compact(effect.request),
                response: compact(effect.response),
                observation: compact(effect.observation),
                verified: effect.verified,
              },
        ),
      })),
    },
    null,
    2,
  ),
);
if (!gatePassed) process.exitCode = 1;
