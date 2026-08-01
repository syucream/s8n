import { createServer } from "node:net";
import { createEmulator } from "emulate";
import { runWorkflow } from "../src/engine/execute.ts";
import { EmulatorIntegrationRunner } from "../src/integrations/emulator.ts";
import { emptyMockLookup } from "../src/mock/provider.ts";
import { createDefaultRegistry } from "../src/nodes/registry.ts";
import { toItems } from "../src/schema/item.ts";
import { validateWorkflow } from "../src/schema/workflow.ts";

async function findAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate an emulator oracle port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function verifyAgainstExternalOracle(): Promise<{
  postedText: string;
  historyText: string;
}> {
  const oracle = await createEmulator({
    service: "slack",
    port: await findAvailablePort(),
    seed: {
      slack: {
        channels: [{ name: "quality-gate" }],
        tokens: [
          {
            token: "xoxb-s8n-quality-oracle",
            scopes: ["chat:write", "channels:read", "channels:history"],
          },
        ],
      },
    },
  });
  try {
    const headers = {
      authorization: "Bearer xoxb-s8n-quality-oracle",
      "content-type": "application/json",
    };
    const listed = (await (
      await fetch(`${oracle.url}/api/conversations.list`, {
        method: "POST",
        headers,
      })
    ).json()) as { channels: Array<{ id: string; name: string }> };
    const channel = listed.channels.find(
      (candidate) => candidate.name === "quality-gate",
    );
    if (!channel) throw new Error("Slack oracle channel was not seeded");
    const posted = (await (
      await fetch(`${oracle.url}/api/chat.postMessage`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          channel: channel.id,
          text: "Release v0.2.0 is ready",
        }),
      })
    ).json()) as { ok: boolean; ts: string; message: { text: string } };
    const history = (await (
      await fetch(`${oracle.url}/api/conversations.history`, {
        method: "POST",
        headers,
        body: JSON.stringify({ channel: channel.id }),
      })
    ).json()) as { messages: Array<{ ts: string; text: string }> };
    const observed = history.messages.find(
      (message) => message.ts === posted.ts,
    );
    if (!posted.ok || !observed) {
      throw new Error("Vercel Labs Slack emulator did not persist the post");
    }
    return { postedText: posted.message.text, historyText: observed.text };
  } finally {
    await oracle.close();
  }
}

const validated = validateWorkflow({
  name: "Slack major use cases",
  nodes: [
    {
      id: "trigger",
      name: "Trigger",
      type: "n8n-nodes-base.manualTrigger",
      parameters: {},
    },
    {
      id: "parent",
      name: "Post Parent",
      type: "n8n-nodes-base.slack",
      typeVersion: 2.6,
      parameters: {
        resource: "message",
        operation: "post",
        select: "channel",
        channelId: { mode: "name", value: "quality-gate" },
        messageType: "text",
        text: "=Release {{$json.tag}} is ready",
      },
    },
    {
      id: "reply",
      name: "Post Reply",
      type: "n8n-nodes-base.slack",
      typeVersion: 2.6,
      parameters: {
        resource: "message",
        operation: "post",
        select: "channel",
        channelId: { mode: "name", value: "quality-gate" },
        messageType: "text",
        text: "Verification completed",
        otherOptions: {
          thread_ts: {
            replyValues: [
              {
                thread_ts: "={{$('Post Parent').first().json.ts}}",
                reply_broadcast: false,
              },
            ],
          },
        },
      },
    },
    {
      id: "update",
      name: "Update Parent",
      type: "n8n-nodes-base.slack",
      typeVersion: 2.6,
      parameters: {
        resource: "message",
        operation: "update",
        channelId: { mode: "name", value: "quality-gate" },
        ts: "={{$('Post Parent').first().json.ts}}",
        messageType: "text",
        text: "Release v0.2.0 verified",
      },
    },
    {
      id: "lookup",
      name: "Lookup User",
      type: "n8n-nodes-base.slack",
      typeVersion: 2.6,
      parameters: {
        resource: "user",
        operation: "lookupByEmail",
        email: "agent@s8n.local",
      },
    },
  ],
  connections: {
    Trigger: { main: [[{ node: "Post Parent", type: "main", index: 0 }]] },
    "Post Parent": {
      main: [[{ node: "Post Reply", type: "main", index: 0 }]],
    },
    "Post Reply": {
      main: [[{ node: "Update Parent", type: "main", index: 0 }]],
    },
    "Update Parent": {
      main: [[{ node: "Lookup User", type: "main", index: 0 }]],
    },
  },
});

if (!validated.valid || !validated.workflow) {
  throw new Error(
    `Invalid emulator quality workflow: ${JSON.stringify(validated.issues)}`,
  );
}

const runner = await EmulatorIntegrationRunner.create();
try {
  const result = await runWorkflow(validated.workflow, {
    initialInput: toItems([{ tag: "v0.2.0" }]),
    hasExplicitInput: true,
    mocks: emptyMockLookup,
    registry: createDefaultRegistry(),
    integrationRunner: runner,
  });
  const operations = result.effects.map((effect) => effect.operation);
  const replyEffect = result.effects.find(
    (effect) =>
      effect.operation === "chat.postMessage" &&
      (effect.request as Record<string, unknown>).thread_ts !== undefined,
  );
  const updateEffect = result.effects.find(
    (effect) => effect.operation === "chat.update",
  );
  const oracle = await verifyAgainstExternalOracle();
  const assertions = {
    workflowSucceeded: result.status === "success",
    parentMessagePersisted:
      operations.filter((operation) => operation === "chat.postMessage")
        .length === 2,
    threadReplyPersisted:
      replyEffect?.verified === true &&
      (replyEffect.observation as Record<string, unknown>).operation ===
        "conversations.replies",
    messageUpdatePersisted:
      updateEffect?.verified === true &&
      (
        (updateEffect.observation as Record<string, unknown>).message as
          | Record<string, unknown>
          | undefined
      )?.text === "Release v0.2.0 verified",
    userLookupVerified: operations.includes("users.lookupByEmail"),
    everyEffectVerified: result.effects.every((effect) => effect.verified),
    vercelLabsOracleParity:
      oracle.postedText === "Release v0.2.0 is ready" &&
      oracle.historyText === oracle.postedText,
  };
  if (Object.values(assertions).some((passed) => !passed)) {
    throw new Error(
      `Emulator quality assertions failed: ${JSON.stringify(assertions)}`,
    );
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        gate: "stateful-emulator",
        oracle: "Vercel Labs emulate Slack service",
        assertions,
        effects: result.effects,
      },
      null,
      2,
    ),
  );
} finally {
  await runner.close();
}
