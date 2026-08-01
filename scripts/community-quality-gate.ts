import { runWorkflow } from "../src/engine/execute.ts";
import { EmulatorIntegrationRunner } from "../src/integrations/emulator.ts";
import { emptyMockLookup } from "../src/mock/provider.ts";
import { createDefaultRegistry } from "../src/nodes/registry.ts";
import { toItems } from "../src/schema/item.ts";
import { validateWorkflow, type Workflow } from "../src/schema/workflow.ts";

interface TemplateResponse {
  workflow?: {
    name?: string;
    workflow?: unknown;
  };
}

interface LoadedTemplate {
  id: number;
  url: string;
  publishedName?: string;
  workflow: Workflow;
}

async function loadTemplate(id: number): Promise<LoadedTemplate> {
  const url = `https://api.n8n.io/templates/workflows/${id}`;
  const fetched = await fetch(url, {
    headers: { "user-agent": "s8n-community-quality-gate/0.2" },
  });
  if (!fetched.ok) {
    throw new Error(
      `Failed to fetch official n8n template ${id}: HTTP ${fetched.status}`,
    );
  }
  const template = (await fetched.json()) as TemplateResponse;
  const validated = validateWorkflow(template.workflow?.workflow);
  if (!validated.valid || !validated.workflow) {
    throw new Error(
      `Official n8n template ${id} is not accepted: ${JSON.stringify(validated.issues)}`,
    );
  }
  return {
    id,
    url,
    publishedName: template.workflow?.name,
    workflow: validated.workflow,
  };
}

async function verifyReleaseNotification(
  template: LoadedTemplate,
  runner: EmulatorIntegrationRunner,
) {
  const result = await runWorkflow(template.workflow, {
    initialInput: toItems([
      {
        body: {
          repository: { full_name: "community/example" },
          release: {
            tag_name: "v0.2.0-quality-gate",
            body: "Stateful Slack emulation verification",
            html_url:
              "https://example.invalid/community/example/releases/v0.2.0-quality-gate",
          },
        },
      },
    ]),
    hasExplicitInput: true,
    mocks: emptyMockLookup,
    registry: createDefaultRegistry(),
    integrationRunner: runner,
  });
  const slackEffect = result.effects.find(
    (effect) =>
      effect.service === "slack" && effect.operation === "chat.postMessage",
  );
  const messageText = String(
    (slackEffect?.request as Record<string, unknown> | undefined)?.text ?? "",
  );
  const assertions = {
    workflowSucceeded: result.status === "success",
    noMocksPending: result.pendingMocks.length === 0,
    slackEffectObserved: slackEffect?.verified === true,
    resolvedCommunityPayload:
      messageText.includes("community/example") &&
      messageText.includes("v0.2.0-quality-gate"),
  };
  return { result, assertions };
}

async function verifyRecordTransformation(
  template: LoadedTemplate,
  runner: EmulatorIntegrationRunner,
) {
  const result = await runWorkflow(template.workflow, {
    initialInput: toItems([
      {
        body: {
          records: [
            {
              Artikelnr: " A-1001 ",
              Bezeichnung: " Steel bolt M8 ",
              Preis: "12,50",
              Gewicht_kg: "0,125",
              Aktiv: "ja",
              Erstellt_am: "15.03.2026",
            },
          ],
        },
      },
    ]),
    hasExplicitInput: true,
    mocks: emptyMockLookup,
    registry: createDefaultRegistry(),
    integrationRunner: runner,
  });
  const output = result.nodeOutputs["Return Transformed Data"]?.[0]?.json;
  const records = Array.isArray(output?.records)
    ? (output.records as Record<string, unknown>[])
    : [];
  const transformed = records[0];
  const assertions = {
    workflowSucceeded: result.status === "success",
    noMocksPending: result.pendingMocks.length === 0,
    validRecordReported:
      output?.success === true &&
      output?.totalRecords === 1 &&
      output?.validRecords === 1 &&
      output?.errorCount === 0,
    stringsTrimmed:
      transformed?.article_number === "A-1001" &&
      transformed?.description === "Steel bolt M8",
    numberConverted:
      transformed?.price === 12.5 && transformed?.weight_kg === 0.125,
    booleanConverted: transformed?.is_active === true,
    dateConverted: transformed?.created_at === "2026-03-15",
  };
  return { result, assertions, transformed };
}

function assertAll(
  template: LoadedTemplate,
  assertions: Record<string, boolean>,
): void {
  if (Object.values(assertions).some((passed) => !passed)) {
    throw new Error(
      `Community template ${template.id} assertions failed: ${JSON.stringify(assertions)}`,
    );
  }
}

async function main(): Promise<void> {
  const [releaseTemplate, transformTemplate] = await Promise.all([
    loadTemplate(371),
    loadTemplate(14034),
  ]);
  const runner = await EmulatorIntegrationRunner.create();
  try {
    const release = await verifyReleaseNotification(releaseTemplate, runner);
    const transform = await verifyRecordTransformation(
      transformTemplate,
      runner,
    );
    assertAll(releaseTemplate, release.assertions);
    assertAll(transformTemplate, transform.assertions);

    console.log(
      JSON.stringify(
        {
          ok: true,
          gate: "community-workflows",
          workflows: [
            {
              source: {
                templateId: releaseTemplate.id,
                url: releaseTemplate.url,
                name: releaseTemplate.publishedName,
              },
              workflow: {
                name: release.result.workflowName,
                nodeTypes: releaseTemplate.workflow.nodes.map(
                  (node) => node.type,
                ),
              },
              assertions: release.assertions,
              effects: release.result.effects,
            },
            {
              source: {
                templateId: transformTemplate.id,
                url: transformTemplate.url,
                name: transformTemplate.publishedName,
              },
              workflow: {
                name: transform.result.workflowName,
                nodeTypes: transformTemplate.workflow.nodes.map(
                  (node) => node.type,
                ),
              },
              assertions: transform.assertions,
              transformedRecord: transform.transformed,
            },
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await runner.close();
  }
}

await main();
