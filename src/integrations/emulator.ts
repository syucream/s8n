import type { Item } from "../schema/item.ts";
import type { WorkflowNode } from "../schema/workflow.ts";
import { ServiceEmulators } from "./service-emulators.ts";
import type {
  EmulatedIntegrationResult,
  EmulatedService,
  EmulatorSeed,
  IntegrationRunner,
} from "./types.ts";

interface SlackChannel {
  id: string;
  name: string;
}

interface SlackUser {
  id: string;
  name: string;
  real_name: string;
  profile: {
    display_name: string;
    real_name: string;
    email: string;
  };
}

interface SlackMessage {
  type: "message";
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
  reply_broadcast?: boolean;
  blocks?: unknown;
  attachments?: unknown;
}

function locatorValue(value: unknown): string {
  if (value !== null && typeof value === "object" && "value" in value) {
    return String((value as { value: unknown }).value ?? "");
  }
  return String(value ?? "");
}

function firstCollectionValue(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const entries = (value as Record<string, unknown>)[key];
  return Array.isArray(entries) ? entries[0] : undefined;
}

/**
 * Stateful, in-memory integration emulator used by the standalone binary.
 * It intentionally models observable Slack outcomes instead of opening a
 * network port: channels, messages, thread replies, updates, and users all
 * live in this one s8n process and are read back before an effect is marked
 * verified.
 */
export class EmulatorIntegrationRunner implements IntegrationRunner {
  private readonly serviceEmulators: ServiceEmulators;
  private readonly channels: SlackChannel[] = [
    { id: "C000000001", name: "general" },
    { id: "C000000002", name: "random" },
  ];
  private readonly users: SlackUser[] = [
    {
      id: "U000000001",
      name: "s8n-agent",
      real_name: "s8n Local Agent",
      profile: {
        display_name: "s8n-agent",
        real_name: "s8n Local Agent",
        email: "agent@s8n.local",
      },
    },
  ];
  private readonly messages = new Map<string, SlackMessage[]>();
  private sequence = 0;
  private readonly epochSeconds = Math.floor(Date.now() / 1000);

  private constructor(
    private readonly enabled: ReadonlySet<EmulatedService> = new Set(["slack"]),
    seed?: EmulatorSeed,
  ) {
    this.serviceEmulators = new ServiceEmulators(seed);
  }

  static async create(
    services: Iterable<EmulatedService> = ["slack"],
    seed?: EmulatorSeed,
  ): Promise<EmulatorIntegrationRunner> {
    return new EmulatorIntegrationRunner(new Set(services), seed);
  }

  private nextId(prefix: string, count: number): string {
    return `${prefix}${String(count).padStart(9, "0")}`;
  }

  private nextTimestamp(): string {
    this.sequence += 1;
    return `${this.epochSeconds}.${String(this.sequence).padStart(6, "0")}`;
  }

  private resolveSlackTarget(rawTarget: unknown): string {
    const target = locatorValue(rawTarget).replace(/^#/, "");
    if (!target) throw new Error("Slack message target is empty");
    const byId = this.channels.find((channel) => channel.id === target);
    if (byId) return byId.id;
    const byName = this.channels.find((channel) => channel.name === target);
    if (byName) return byName.id;
    const created = {
      id: this.nextId("C", this.channels.length + 1),
      name: target,
    };
    this.channels.push(created);
    return created.id;
  }

  private slackMessageBody(
    parameters: Record<string, unknown>,
    channel: string,
  ): Record<string, unknown> {
    const messageType = String(parameters.messageType ?? "text");
    const body: Record<string, unknown> = { channel };
    if (parameters.text !== undefined) body.text = parameters.text;

    if (messageType === "block" && parameters.blocksUi !== undefined) {
      const raw = parameters.blocksUi;
      body.blocks =
        typeof raw === "string"
          ? (() => {
              try {
                return JSON.parse(raw);
              } catch {
                return raw;
              }
            })()
          : raw;
    }
    if (messageType === "attachment" && parameters.attachments !== undefined) {
      body.attachments = parameters.attachments;
    }

    const otherOptions =
      parameters.otherOptions !== null &&
      typeof parameters.otherOptions === "object"
        ? { ...(parameters.otherOptions as Record<string, unknown>) }
        : {};
    const reply = firstCollectionValue(otherOptions.thread_ts, "replyValues");
    if (reply !== null && typeof reply === "object") {
      const replyValues = reply as Record<string, unknown>;
      if (replyValues.thread_ts !== undefined)
        body.thread_ts = String(replyValues.thread_ts);
      if (replyValues.reply_broadcast !== undefined)
        body.reply_broadcast = replyValues.reply_broadcast;
    }
    delete otherOptions.thread_ts;
    delete otherOptions.ephemeral;
    delete otherOptions.botProfile;
    Object.assign(body, otherOptions);
    return body;
  }

  private postMessage(body: Record<string, unknown>): {
    response: Record<string, unknown>;
    observed: SlackMessage;
    observationOperation: string;
  } {
    const channel = String(body.channel ?? "");
    const threadTs =
      body.thread_ts === undefined ? undefined : String(body.thread_ts);
    const channelMessages = this.messages.get(channel) ?? [];
    if (
      threadTs &&
      !channelMessages.some((message) => message.ts === threadTs)
    ) {
      throw new Error(`Slack thread parent ${threadTs} was not found`);
    }
    const message: SlackMessage = {
      type: "message",
      user: this.users[0]?.id ?? "U000000001",
      text: String(body.text ?? ""),
      ts: this.nextTimestamp(),
      ...(threadTs ? { thread_ts: threadTs } : {}),
      ...(body.reply_broadcast !== undefined
        ? { reply_broadcast: Boolean(body.reply_broadcast) }
        : {}),
      ...(body.blocks !== undefined ? { blocks: body.blocks } : {}),
      ...(body.attachments !== undefined
        ? { attachments: body.attachments }
        : {}),
    };
    channelMessages.push(message);
    this.messages.set(channel, channelMessages);

    const observed = threadTs
      ? channelMessages.find(
          (candidate) =>
            candidate.ts === message.ts && candidate.thread_ts === threadTs,
        )
      : channelMessages.find((candidate) => candidate.ts === message.ts);
    if (!observed) {
      throw new Error(`Slack emulator did not persist message ${message.ts}`);
    }
    const snapshot = structuredClone(observed);
    return {
      response: { ok: true, channel, ts: message.ts, message: snapshot },
      observed: snapshot,
      observationOperation: threadTs
        ? "conversations.replies"
        : "conversations.history",
    };
  }

  private updateMessage(body: Record<string, unknown>): {
    response: Record<string, unknown>;
    observed: SlackMessage;
  } {
    const channel = String(body.channel ?? "");
    const ts = String(body.ts ?? "");
    const message = (this.messages.get(channel) ?? []).find(
      (candidate) => candidate.ts === ts,
    );
    if (!message) throw new Error(`Slack message ${ts} was not found`);
    if (body.text !== undefined) message.text = String(body.text);
    if (body.blocks !== undefined) message.blocks = body.blocks;
    if (body.attachments !== undefined) message.attachments = body.attachments;
    const snapshot = structuredClone(message);
    return {
      response: {
        ok: true,
        channel,
        ts,
        text: message.text,
        message: snapshot,
      },
      observed: snapshot,
    };
  }

  async execute(
    node: WorkflowNode,
    parameters: Record<string, unknown>,
    inputItem?: Item,
  ): Promise<EmulatedIntegrationResult | undefined> {
    if (node.type !== "n8n-nodes-base.slack") {
      return this.serviceEmulators.execute(
        node,
        parameters,
        this.enabled,
        inputItem,
      );
    }
    if (!this.enabled.has("slack")) return undefined;

    const resource = String(parameters.resource ?? "message");
    const legacyPost =
      parameters.resource === undefined &&
      parameters.operation === undefined &&
      parameters.text !== undefined &&
      parameters.channel !== undefined;
    const operation = String(
      parameters.operation ?? (legacyPost ? "post" : ""),
    );

    if (resource === "user" && operation === "lookupByEmail") {
      const email = String(parameters.email ?? "");
      const user = this.users.find(
        (candidate) => candidate.profile.email === email,
      );
      if (!user) throw new Error(`Slack user not found for email ${email}`);
      const observedUser = this.users.find(
        (candidate) => candidate.id === user.id,
      );
      if (!observedUser) {
        throw new Error(
          `Slack emulator could not verify the user returned for ${email}`,
        );
      }
      return {
        output: user,
        effect: {
          nodeName: node.name,
          nodeType: node.type,
          service: "slack",
          operation: "users.lookupByEmail",
          request: { email },
          response: user,
          observation: { operation: "users.info", user: observedUser },
          verified: true,
        },
      };
    }

    if (resource !== "message" || !["post", "update"].includes(operation))
      return undefined;

    const channel = this.resolveSlackTarget(
      parameters.channelId ?? parameters.channel ?? parameters.user,
    );
    const body = this.slackMessageBody(parameters, channel);
    if (operation === "update") {
      body.ts = String(parameters.ts ?? parameters.timestamp ?? "");
      if (
        parameters.updateFields !== null &&
        typeof parameters.updateFields === "object"
      ) {
        Object.assign(body, parameters.updateFields);
      }
      const { response, observed } = this.updateMessage(body);
      return {
        output: response,
        effect: {
          nodeName: node.name,
          nodeType: node.type,
          service: "slack",
          operation: "chat.update",
          request: body,
          response,
          observation: {
            operation: observed.thread_ts
              ? "conversations.replies"
              : "conversations.history",
            message: observed,
          },
          verified: true,
        },
      };
    }

    const { response, observed, observationOperation } = this.postMessage(body);
    return {
      output: response,
      effect: {
        nodeName: node.name,
        nodeType: node.type,
        service: "slack",
        operation: "chat.postMessage",
        request: body,
        response,
        observation: { operation: observationOperation, message: observed },
        verified: true,
      },
    };
  }

  async close(): Promise<void> {}
}
