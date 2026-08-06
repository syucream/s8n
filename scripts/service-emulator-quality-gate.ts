import { type RunResult, runWorkflow } from "../src/engine/execute.ts";
import { EmulatorIntegrationRunner } from "../src/integrations/emulator.ts";
import type { EmulatedService } from "../src/integrations/types.ts";
import { emptyMockLookup } from "../src/mock/provider.ts";
import { createDefaultRegistry } from "../src/nodes/registry.ts";
import { toItems } from "../src/schema/item.ts";
import {
  validateWorkflow,
  type WorkflowNode,
  workflowNodeSchema,
} from "../src/schema/workflow.ts";

type ScenarioNode = Pick<WorkflowNode, "id" | "name" | "type" | "parameters">;

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate an oracle port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function verifyExistingEmulatorCompatibility(): Promise<{
  githubIssueReadBack: boolean;
  googleGmailReadBack: boolean;
}> {
  const [github, google] = await Promise.all([
    createEmulator({
      service: "github",
      port: await availablePort(),
      seed: {
        tokens: { "github-quality-token": { login: "s8n", scopes: ["repo"] } },
        github: {
          users: [
            {
              login: "s8n",
              name: "s8n Quality Agent",
              email: "agent@s8n.local",
            },
          ],
          repos: [{ owner: "s8n", name: "quality-gate", auto_init: true }],
        },
      },
    }),
    createEmulator({
      service: "google",
      port: await availablePort(),
      seed: {
        tokens: {
          "google-quality-token": {
            login: "agent@s8n.local",
            scopes: ["gmail.send", "gmail.readonly"],
          },
        },
        google: {
          users: [{ email: "agent@s8n.local", name: "s8n Quality Agent" }],
        },
      },
    }),
  ]);
  try {
    const githubHeaders = {
      authorization: "Bearer github-quality-token",
      "content-type": "application/json",
    };
    const issue = (await (
      await fetch(`${github.url}/repos/s8n/quality-gate/issues`, {
        method: "POST",
        headers: githubHeaders,
        body: JSON.stringify({ title: "Integration evidence", body: "passed" }),
      })
    ).json()) as { number: number; title: string };
    const fetchedIssue = (await (
      await fetch(
        `${github.url}/repos/s8n/quality-gate/issues/${issue.number}`,
        {
          headers: githubHeaders,
        },
      )
    ).json()) as { number: number; title: string };

    const googleHeaders = {
      authorization: "Bearer google-quality-token",
      "content-type": "application/json",
    };
    const message = (await (
      await fetch(`${google.url}/gmail/v1/users/me/messages/send`, {
        method: "POST",
        headers: googleHeaders,
        body: JSON.stringify({
          to: "reviewer@s8n.local",
          subject: "Integration evidence",
          text: "passed",
        }),
      })
    ).json()) as { id: string; snippet: string };
    const fetchedMessage = (await (
      await fetch(`${google.url}/gmail/v1/users/me/messages/${message.id}`, {
        headers: googleHeaders,
      })
    ).json()) as { id: string; snippet: string };
    return {
      githubIssueReadBack:
        fetchedIssue.number === issue.number &&
        fetchedIssue.title === "Integration evidence",
      googleGmailReadBack:
        fetchedMessage.id === message.id && fetchedMessage.snippet === "passed",
    };
  } finally {
    await Promise.all([github.close(), google.close()]);
  }
}

interface Scenario {
  service: EmulatedService;
  create: ScenarioNode;
  read: ScenarioNode;
}

const scenarios: Scenario[] = [
  {
    service: "gws",
    create: {
      id: "gws-create",
      name: "Upload Drive Evidence",
      type: "n8n-nodes-base.googleDrive",
      parameters: {
        operation: "upload",
        fileName: "quality-evidence.json",
        mimeType: "application/json",
        content: '{"passed":true}',
      },
    },
    read: {
      id: "gws-read",
      name: "Read Drive Evidence",
      type: "n8n-nodes-base.googleDrive",
      parameters: {
        operation: "get",
        fileId: "={{$('Upload Drive Evidence').first().json.id}}",
      },
    },
  },
  {
    service: "gcp",
    create: {
      id: "gcp-create",
      name: "Upload GCS Evidence",
      type: "n8n-nodes-base.googleCloudStorage",
      parameters: {
        operation: "upload",
        bucketName: "s8n-quality",
        objectName: "quality-evidence.json",
        content: '{"passed":true}',
      },
    },
    read: {
      id: "gcp-read",
      name: "Read GCS Evidence",
      type: "n8n-nodes-base.googleCloudStorage",
      parameters: {
        operation: "get",
        objectName: "={{$('Upload GCS Evidence').first().json.id}}",
      },
    },
  },
  {
    service: "notion",
    create: {
      id: "notion-create",
      name: "Create Notion Evidence",
      type: "n8n-nodes-base.notion",
      parameters: {
        resource: "page",
        operation: "create",
        title: "s8n quality evidence",
        properties: { passed: true },
      },
    },
    read: {
      id: "notion-read",
      name: "Read Notion Evidence",
      type: "n8n-nodes-base.notion",
      parameters: {
        resource: "page",
        operation: "get",
        pageId: "={{$('Create Notion Evidence').first().json.id}}",
      },
    },
  },
  {
    service: "jira",
    create: {
      id: "jira-create",
      name: "Create Jira Evidence",
      type: "n8n-nodes-base.jira",
      parameters: {
        resource: "issue",
        operation: "create",
        projectKey: "S8N",
        summary: "Verify integration emulators",
      },
    },
    read: {
      id: "jira-read",
      name: "Read Jira Evidence",
      type: "n8n-nodes-base.jira",
      parameters: {
        resource: "issue",
        operation: "get",
        issueKey: "={{$('Create Jira Evidence').first().json.key}}",
      },
    },
  },
  {
    service: "github",
    create: {
      id: "github-create",
      name: "Create GitHub Evidence",
      type: "n8n-nodes-base.github",
      parameters: {
        resource: "issue",
        operation: "create",
        owner: "s8n",
        repository: "quality-gate",
        title: "Integration evidence",
      },
    },
    read: {
      id: "github-read",
      name: "Read GitHub Evidence",
      type: "n8n-nodes-base.github",
      parameters: {
        resource: "issue",
        operation: "get",
        owner: "s8n",
        repository: "quality-gate",
        issueNumber: "={{$('Create GitHub Evidence').first().json.number}}",
      },
    },
  },
];

function verifyScenario(service: EmulatedService, run: RunResult): void {
  if (run.status !== "success") {
    throw new Error(
      `${service} scenario did not succeed: ${run.errors.join("; ")}`,
    );
  }
  if (run.effects.length !== 2) {
    throw new Error(
      `${service} scenario emitted ${run.effects.length} effects instead of 2`,
    );
  }
  if (
    run.effects.some((effect) => effect.service !== service || !effect.verified)
  ) {
    throw new Error(
      `${service} scenario contains unverified or cross-service evidence`,
    );
  }
  const created = run.effects[0]?.response;
  const read = (run.effects[1]?.observation as { data?: unknown } | undefined)
    ?.data;
  if (JSON.stringify(created) !== JSON.stringify(read)) {
    throw new Error(`${service} read-back does not match the created resource`);
  }
}

async function runScenario(scenario: Scenario): Promise<RunResult> {
  const trigger: ScenarioNode = {
    id: `${scenario.service}-trigger`,
    name: "Trigger",
    type: "n8n-nodes-base.manualTrigger",
    parameters: {},
  };
  const candidate = validateWorkflow({
    name: `${scenario.service} stateful read-back`,
    nodes: [trigger, scenario.create, scenario.read],
    connections: {
      Trigger: {
        main: [[{ node: scenario.create.name, type: "main", index: 0 }]],
      },
      [scenario.create.name]: {
        main: [[{ node: scenario.read.name, type: "main", index: 0 }]],
      },
    },
  });
  if (!candidate.valid || !candidate.workflow)
    throw new Error(`Invalid ${scenario.service} quality scenario`);
  const runner = await EmulatorIntegrationRunner.create([scenario.service]);
  try {
    return await runWorkflow(candidate.workflow, {
      initialInput: toItems([{}]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry: createDefaultRegistry(),
      integrationRunner: runner,
    });
  } finally {
    await runner.close();
  }
}

async function runGcpPriorityScenario(): Promise<RunResult> {
  const candidate = validateWorkflow({
    name: "GCP BigQuery to Vertex AI",
    nodes: [
      {
        name: "Trigger",
        type: "n8n-nodes-base.manualTrigger",
        parameters: {},
      },
      {
        name: "Insert BigQuery Row",
        type: "n8n-nodes-base.googleBigQuery",
        parameters: { operation: "insert", tableId: "quality_events" },
      },
      {
        name: "Query BigQuery Rows",
        type: "n8n-nodes-base.googleBigQuery",
        parameters: {
          operation: "executeQuery",
          query: "SELECT * FROM quality_events",
        },
      },
      {
        name: "Invoke Vertex AI",
        type: "@n8n/n8n-nodes-langchain.googleVertexChat",
        parameters: {
          model: "gemini-2.5-flash",
          prompt: "=Summarize {{$json.gate}} evidence",
        },
      },
    ],
    connections: {
      Trigger: {
        main: [[{ node: "Insert BigQuery Row", type: "main", index: 0 }]],
      },
      "Insert BigQuery Row": {
        main: [[{ node: "Query BigQuery Rows", type: "main", index: 0 }]],
      },
      "Query BigQuery Rows": {
        main: [[{ node: "Invoke Vertex AI", type: "main", index: 0 }]],
      },
    },
  });
  if (!candidate.valid || !candidate.workflow)
    throw new Error("Invalid GCP priority quality scenario");
  const runner = await EmulatorIntegrationRunner.create(["gcp"]);
  try {
    return await runWorkflow(candidate.workflow, {
      initialInput: toItems([{ gate: "priority", passed: true }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry: createDefaultRegistry(),
      integrationRunner: runner,
    });
  } finally {
    await runner.close();
  }
}

const runs = await Promise.all(
  scenarios.map(async (scenario) => {
    const run = await runScenario(scenario);
    verifyScenario(scenario.service, run);
    return { service: scenario.service, run };
  }),
);
const externalOracle = await verifyExistingEmulatorCompatibility();
if (Object.values(externalOracle).some((passed) => !passed)) {
  throw new Error(
    `Existing emulator compatibility failed: ${JSON.stringify(externalOracle)}`,
  );
}
const gcpPriority = await runGcpPriorityScenario();
const gcpOperations = gcpPriority.effects.map((effect) => effect.operation);
const gcpPriorityPassed =
  gcpPriority.status === "success" &&
  gcpOperations.includes("bigquery.tabledata.insertAll") &&
  gcpOperations.includes("bigquery.jobs.query") &&
  gcpOperations.includes("vertex.models.generateContent") &&
  gcpPriority.effects.every((effect) => effect.verified) &&
  (
    gcpPriority.nodeOutputs["Invoke Vertex AI"]?.[0]?.json.promptMetadata as {
      sizeBucket?: string;
    }
  )?.sizeBucket === "short";
if (!gcpPriorityPassed)
  throw new Error("BigQuery-to-Vertex priority scenario failed");

let mutationRejected = false;
try {
  const mutated = structuredClone(runs[0] as (typeof runs)[number]);
  if (mutated.run.effects[0]) mutated.run.effects[0].verified = false;
  verifyScenario(mutated.service, mutated.run);
} catch {
  mutationRejected = true;
}
if (!mutationRejected)
  throw new Error("Quality verifier accepted mutated evidence");

const missingRunner = await EmulatorIntegrationRunner.create(["notion"]);
const missingReadRejected = await missingRunner
  .execute(
    workflowNodeSchema.parse({
      id: "missing",
      name: "Read Missing Notion Page",
      type: "n8n-nodes-base.notion",
      parameters: {},
    }),
    { resource: "page", operation: "get", pageId: "missing" },
  )
  .then(
    () => false,
    () => true,
  );
await missingRunner.close();
if (!missingReadRejected)
  throw new Error("Missing remote resource was fabricated as a success");

console.log(
  JSON.stringify(
    {
      ok: true,
      gate: "service-emulators",
      assertions: {
        everyScenarioSucceeded: true,
        everyMutationReadBack: true,
        everyEffectVerified: true,
        missingReadRejected,
        mutatedEvidenceRejected: mutationRejected,
        vercelLabsGithubOracleParity: externalOracle.githubIssueReadBack,
        vercelLabsGoogleOracleParity: externalOracle.googleGmailReadBack,
        bigQueryToVertexWorkflowVerified: gcpPriorityPassed,
      },
      externalOracle: "Vercel Labs emulate GitHub and Google services",
      scenarios: runs.map(({ service, run }) => ({
        service,
        status: run.status,
        effects: run.effects,
      })),
      gcpPriorityEffects: gcpPriority.effects,
    },
    null,
    2,
  ),
);

import { createServer } from "node:net";
import { createEmulator } from "emulate";
