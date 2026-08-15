import type { Item } from "../schema/item.ts";
import type { WorkflowNode } from "../schema/workflow.ts";
import type {
  EmulatedIntegrationResult,
  EmulatedService,
  EmulatorSeed,
} from "./types.ts";

type Json = Record<string, unknown>;

function value(raw: unknown): string {
  if (raw !== null && typeof raw === "object" && "value" in raw) {
    return String((raw as { value: unknown }).value ?? "");
  }
  return String(raw ?? "");
}

function object(raw: unknown): Json {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Json)
    : {};
}

function text(raw: unknown): string {
  if (typeof raw === "string") return raw;
  return raw === undefined ? "" : JSON.stringify(raw);
}

function clone<T>(input: T): T {
  return structuredClone(input);
}

/**
 * Real BigQuery read APIs return row values as strings (`rows[].f[].v`),
 * and the upstream n8n node passes them through unchanged unless the
 * `returnAsNumbers` option converts numeric columns back to numbers.
 * Booleans therefore surface as "true"/"false" - a mock that returned real
 * booleans would hide `if (row.is_hit)`-style truthiness bugs, so the
 * emulator reproduces the string pass-through on every read.
 */
function coerceBigQueryRow(row: Json, returnAsNumbers: boolean): Json {
  return Object.fromEntries(
    Object.entries(row).map(([key, entry]) => {
      if (entry === null || entry === undefined) return [key, null];
      if (typeof entry === "boolean") return [key, String(entry)];
      if (typeof entry === "number") {
        return [key, returnAsNumbers ? entry : String(entry)];
      }
      if (typeof entry === "object") return [key, JSON.stringify(entry)];
      return [key, entry];
    }),
  );
}

function contentMetadata(raw: unknown): {
  present: boolean;
  kind: "string" | "array" | "object" | "scalar";
  sizeBucket: "empty" | "short" | "medium" | "long";
} {
  const source = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
  const kind =
    typeof raw === "string"
      ? "string"
      : Array.isArray(raw)
        ? "array"
        : raw !== null && typeof raw === "object"
          ? "object"
          : "scalar";
  return {
    present: source.length > 0,
    kind,
    sizeBucket:
      source.length === 0
        ? "empty"
        : source.length <= 128
          ? "short"
          : source.length <= 4096
            ? "medium"
            : "long",
  };
}

function result(
  node: WorkflowNode,
  service: EmulatedService,
  operation: string,
  request: Json,
  response: unknown,
  readOperation: string,
  observed: unknown,
): EmulatedIntegrationResult {
  return {
    output: response,
    effect: {
      nodeName: node.name,
      nodeType: node.type,
      service,
      operation,
      request: clone(request),
      response: clone(response),
      observation: { operation: readOperation, data: clone(observed) },
      verified: true,
    },
  };
}

/**
 * Compact stateful emulators for the highest-value integration families.
 * They model the resources workflows observe (rather than credentials or
 * transport), and every mutation is read from the backing store before an
 * effect can be returned as verified.
 */
export class ServiceEmulators {
  private sequence = 0;
  private readonly stores = new Map<string, Map<string, Json>>();

  constructor(seed?: EmulatorSeed) {
    for (const [storeName, entries] of Object.entries(seed?.stores ?? {})) {
      const store = this.store(storeName);
      entries.forEach((entry, index) => {
        const id = value(
          entry.id ?? entry.key ?? entry.number ?? entry.name ?? entry.email,
        );
        store.set(id || `seed-${index + 1}`, clone(entry));
      });
    }
  }

  private store(name: string): Map<string, Json> {
    let store = this.stores.get(name);
    if (!store) {
      store = new Map();
      this.stores.set(name, store);
    }
    return store;
  }

  private id(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${String(this.sequence).padStart(6, "0")}`;
  }

  private require(store: Map<string, Json>, id: string, label: string): Json {
    const found = store.get(id);
    if (!found) throw new Error(`${label} ${id || "<empty>"} was not found`);
    return found;
  }

  private remove(
    node: WorkflowNode,
    service: EmulatedService,
    operation: string,
    storeName: string,
    parameters: Json,
    id: string,
  ): EmulatedIntegrationResult {
    const store = this.store(storeName);
    const previous = clone(this.require(store, id, storeName));
    store.delete(id);
    const remaining = [...store.values()].map(clone);
    return result(
      node,
      service,
      operation,
      parameters,
      { deleted: true, ...previous },
      `${storeName}.list`,
      remaining,
    );
  }

  private upsert(
    node: WorkflowNode,
    service: EmulatedService,
    operation: string,
    storeName: string,
    prefix: string,
    parameters: Json,
    fields: Json,
    requestedId?: string,
  ): EmulatedIntegrationResult {
    const store = this.store(storeName);
    const id = requestedId || this.id(prefix);
    const previous = store.get(id) ?? {};
    const entity = { ...previous, id, ...fields };
    store.set(id, entity);
    const observed = this.require(store, id, storeName);
    return result(
      node,
      service,
      operation,
      parameters,
      entity,
      `${storeName}.get`,
      observed,
    );
  }

  private getOrList(
    node: WorkflowNode,
    service: EmulatedService,
    operation: string,
    storeName: string,
    parameters: Json,
    id: string,
  ): EmulatedIntegrationResult {
    const store = this.store(storeName);
    if (["getAll", "search", "list"].includes(operation)) {
      const rows = [...store.values()].map(clone);
      return result(
        node,
        service,
        `${storeName}.${operation}`,
        parameters,
        rows,
        `${storeName}.list`,
        rows,
      );
    }
    const entity = clone(this.require(store, id, storeName));
    return result(
      node,
      service,
      `${storeName}.get`,
      parameters,
      entity,
      `${storeName}.get`,
      entity,
    );
  }

  execute(
    node: WorkflowNode,
    parameters: Json,
    enabled: ReadonlySet<EmulatedService>,
    inputItem?: Item,
  ): EmulatedIntegrationResult | undefined {
    const type = node.type.toLowerCase();
    if (enabled.has("ai")) {
      const ai = this.executeAiModel(node, type, parameters);
      if (ai) return ai;
    }
    if (enabled.has("gws")) {
      const gws = this.executeGws(node, type, parameters, inputItem?.json);
      if (gws) return gws;
    }
    if (enabled.has("gcp")) {
      const gcp = this.executeGcp(node, type, parameters, inputItem?.json);
      if (gcp) return gcp;
    }
    if (enabled.has("notion") && type.includes("notion"))
      return this.executeNotion(node, parameters, inputItem?.json);
    if (enabled.has("jira") && type.includes("jira"))
      return this.executeJira(node, parameters, inputItem?.json);
    if (enabled.has("github") && type.includes("github"))
      return this.executeGithub(node, parameters, inputItem?.json);
    return undefined;
  }

  private executeAiModel(
    node: WorkflowNode,
    type: string,
    p: Json,
  ): EmulatedIntegrationResult | undefined {
    const isLanguageModel =
      type.startsWith("@n8n/n8n-nodes-langchain.lm") ||
      [
        "@n8n/n8n-nodes-langchain.openai",
        "@n8n/n8n-nodes-langchain.googlegemini",
      ].includes(type);
    if (!isLanguageModel || p.simulatedResponse === undefined) return undefined;

    const prompt = text(p.prompt ?? p.text ?? p.messages ?? p.input);
    if (!prompt) throw new Error("AI model prompt is empty");
    const model =
      value(p.modelName ?? p.modelId ?? p.model) ||
      node.type.split(".").at(-1) ||
      "local-model";
    const invocation = {
      id: this.id("ai-call"),
      providerNodeType: node.type,
      modelMetadata: contentMetadata(model),
      promptMetadata: contentMetadata(prompt),
      systemMessageMetadata: contentMetadata(p.systemMessage ?? ""),
      optionCount: Object.keys(object(p.options)).length,
      toolCount: Array.isArray(p.tools) ? p.tools.length : 0,
      memoryCount: Array.isArray(p.memory) ? p.memory.length : 0,
    };
    const calls = this.store("ai.invocations");
    calls.set(invocation.id, invocation);
    const emulated = result(
      node,
      "ai",
      "models.generate",
      invocation,
      contentMetadata(p.simulatedResponse),
      "ai.invocations.get",
      this.require(calls, invocation.id, "AI invocation"),
    );
    emulated.output = clone(p.simulatedResponse);
    return emulated;
  }

  private executeGws(
    node: WorkflowNode,
    type: string,
    p: Json,
    input: Json = {},
  ): EmulatedIntegrationResult | undefined {
    const operation = String(p.operation ?? "");
    if (type.includes("googlesheets")) {
      const documentId = value(p.documentId ?? p.sheetId) || "default";
      const sheetName = value(p.sheetName) || "Sheet1";
      const storeName = `gws.sheets.${documentId}.${sheetName}`;
      const store = this.store(storeName);
      if (["append", "appendOrUpdate", "create"].includes(operation)) {
        const explicit = object(p.fieldsUi ?? p.data ?? p.row);
        const row = {
          id: this.id("row"),
          ...(Object.keys(explicit).length > 0 ? explicit : input),
        };
        store.set(String(row.id), row);
        return result(
          node,
          "gws",
          "sheets.values.append",
          p,
          row,
          "sheets.values.get",
          row,
        );
      }
      if (["read", "getAll", "lookup"].includes(operation)) {
        const rows = [...store.values()].map(clone);
        return result(
          node,
          "gws",
          "sheets.values.get",
          p,
          rows,
          "sheets.values.get",
          rows,
        );
      }
    }
    if (type.includes("googledrive")) {
      const operationName = operation || "upload";
      const id = value(p.fileId ?? p.id);
      if (["get", "download", "getAll", "search"].includes(operationName))
        return this.getOrList(
          node,
          "gws",
          operationName,
          "gws.drive.files",
          p,
          id,
        );
      return this.upsert(
        node,
        "gws",
        `drive.files.${operationName}`,
        "gws.drive.files",
        "file",
        p,
        {
          name: value(p.name ?? p.fileName) || "untitled",
          mimeType: value(p.mimeType) || "application/octet-stream",
          content: p.content ?? p.data ?? "",
          webViewLink: `https://drive.google.com/file/d/${id || "local"}/view`,
        },
        id,
      );
    }
    if (type.includes("gmail")) {
      const resource = String(p.resource ?? "message");
      const operationName =
        operation || (resource === "draft" ? "create" : "send");
      const messages = this.store("gws.gmail.messages");
      if (["get", "getAll"].includes(operationName))
        return this.getOrList(
          node,
          "gws",
          operationName,
          "gws.gmail.messages",
          p,
          value(p.messageId ?? p.id),
        );
      if (["send", "create"].includes(operationName)) {
        const id = this.id("message");
        const message = {
          id,
          threadId: this.id("thread"),
          to: p.sendTo ?? p.to,
          subject: p.subject ?? "",
          text: p.message ?? p.text ?? "",
          labelIds: resource === "draft" ? ["DRAFT"] : ["SENT"],
          snippet: p.message ?? p.text ?? "",
        };
        messages.set(id, message);
        return result(
          node,
          "gws",
          resource === "draft"
            ? "gmail.users.drafts.create"
            : "gmail.users.messages.send",
          p,
          message,
          "gmail.users.messages.get",
          this.require(messages, id, "gmail message"),
        );
      }
      if (["addLabels", "removeLabels", "markAsRead"].includes(operationName)) {
        const id = value(p.messageId ?? p.id);
        const existing = this.require(messages, id, "gmail message");
        const labels = new Set(
          Array.isArray(existing.labelIds)
            ? existing.labelIds.map(String)
            : ["INBOX", "UNREAD"],
        );
        const requested = Array.isArray(p.labelIds)
          ? p.labelIds.map(String)
          : [];
        if (operationName === "addLabels")
          requested.forEach((label) => {
            labels.add(label);
          });
        if (operationName === "removeLabels")
          requested.forEach((label) => {
            labels.delete(label);
          });
        if (operationName === "markAsRead") labels.delete("UNREAD");
        const updated = { ...existing, labelIds: [...labels] };
        messages.set(id, updated);
        return result(
          node,
          "gws",
          `gmail.users.messages.${operationName}`,
          p,
          updated,
          "gws.gmail.messages.get",
          this.require(messages, id, "gmail message"),
        );
      }
    }
    if (type.includes("googlecalendar")) {
      const id = value(p.eventId ?? p.id);
      if (["get", "getAll"].includes(operation))
        return this.getOrList(
          node,
          "gws",
          operation,
          "gws.calendar.events",
          p,
          id,
        );
      if (["create", "update"].includes(operation))
        return this.upsert(
          node,
          "gws",
          `calendar.events.${operation}`,
          "gws.calendar.events",
          "event",
          p,
          {
            summary: p.summary ?? p.title ?? "",
            start: p.start ?? p.startTime,
            end: p.end ?? p.endTime,
          },
          id,
        );
    }
    if (type.includes("googledocs")) {
      const id = value(p.documentId ?? p.id);
      if (operation === "get")
        return this.getOrList(
          node,
          "gws",
          operation,
          "gws.docs.documents",
          p,
          id,
        );
      if (["create", "update"].includes(operation))
        return this.upsert(
          node,
          "gws",
          `docs.documents.${operation}`,
          "gws.docs.documents",
          "doc",
          p,
          { title: p.title ?? "Untitled", body: p.text ?? p.content ?? "" },
          id,
        );
    }
    return undefined;
  }

  private executeGcp(
    node: WorkflowNode,
    type: string,
    p: Json,
    input: Json = {},
  ): EmulatedIntegrationResult | undefined {
    const operation = String(p.operation ?? "");
    if (type.includes("bigquery")) {
      const operationName = operation || "insert";
      const table = value(p.tableId ?? p.table) || "default";
      const storeName = `gcp.bigquery.${table}`;
      const rows = this.store(storeName);
      if (["insert", "insertRows", "create"].includes(operationName)) {
        const explicit = object(p.fieldsUi ?? p.data ?? p.row);
        const rawRows = Array.isArray(p.rows)
          ? p.rows
          : [Object.keys(explicit).length > 0 ? explicit : input];
        const inserted = rawRows.map((raw) => {
          const row = { id: this.id("bqrow"), ...object(raw) };
          rows.set(String(row.id), row);
          return row;
        });
        return result(
          node,
          "gcp",
          "bigquery.tabledata.insertAll",
          { ...p, rows: inserted },
          inserted,
          "bigquery.tabledata.list",
          [...rows.values()],
        );
      }
      if (["executeQuery", "query", "getAll"].includes(operationName)) {
        const query = value(p.query);
        const fromTable = query.match(
          /\bfrom\s+`?(?:[\w-]+\.){0,2}([\w-]+)`?/i,
        )?.[1];
        const queryRows = fromTable
          ? this.store(`gcp.bigquery.${fromTable}`)
          : rows;
        const returnAsNumbers =
          p.returnAsNumbers === true ||
          object(p.options).returnAsNumbers === true;
        const output = [...queryRows.values()].map((row) =>
          coerceBigQueryRow(clone(row), returnAsNumbers),
        );
        return result(
          node,
          "gcp",
          "bigquery.jobs.query",
          p,
          output,
          "bigquery.jobs.getQueryResults",
          output,
        );
      }
    }
    if (type.includes("googlecloudstorage") || type.includes("gcs")) {
      const resource = String(
        p.resource ??
          (p.objectName !== undefined ||
          p.fileName !== undefined ||
          ["upload", "download"].includes(operation)
            ? "object"
            : "bucket"),
      );
      const operationName = operation || "getAll";
      if (resource === "bucket") {
        const bucketId = value(p.bucketName ?? p.bucket ?? p.id);
        if (["get", "getAll", "list"].includes(operationName))
          return this.getOrList(
            node,
            "gcp",
            operationName,
            "gcp.gcs.buckets",
            p,
            bucketId,
          );
        if (operationName === "create")
          return this.upsert(
            node,
            "gcp",
            "storage.buckets.create",
            "gcp.gcs.buckets",
            "bucket",
            p,
            { name: bucketId, location: p.location ?? p.createBody ?? "US" },
            bucketId,
          );
        if (operationName === "delete")
          return this.remove(
            node,
            "gcp",
            "storage.buckets.delete",
            "gcp.gcs.buckets",
            p,
            bucketId,
          );
      }
      const id = value(p.objectName ?? p.fileName ?? p.id);
      if (["get", "download", "getAll", "list"].includes(operationName))
        return this.getOrList(
          node,
          "gcp",
          operationName,
          "gcp.gcs.objects",
          p,
          id,
        );
      if (["upload", "create", "update"].includes(operationName))
        return this.upsert(
          node,
          "gcp",
          `storage.objects.${operationName}`,
          "gcp.gcs.objects",
          "object",
          p,
          {
            name: id || "untitled",
            bucket: value(p.bucketName ?? p.bucket),
            content: p.content ?? p.data ?? "",
            contentType: p.contentType ?? "application/octet-stream",
          },
          id,
        );
      if (operationName === "delete")
        return this.remove(
          node,
          "gcp",
          "storage.objects.delete",
          "gcp.gcs.objects",
          p,
          id,
        );
    }
    if (type.includes("vertex") || type.includes("googlegemini")) {
      const prompt = text(p.prompt ?? p.text ?? p.messages ?? p.input);
      if (!prompt) throw new Error("Vertex AI prompt is empty");
      const model = value(p.modelName ?? p.model) || "gemini-local";
      const invocation = {
        id: this.id("prediction"),
        modelMetadata: contentMetadata(model),
        promptMetadata: contentMetadata(prompt),
        text: "[s8n vertex emulator]",
        output: "[s8n vertex emulator]",
        finishReason: "STOP",
        usageMetadata: {
          promptSizeBucket: contentMetadata(prompt).sizeBucket,
          candidatesTokenCount: 4,
        },
      };
      const calls = this.store("gcp.vertex.invocations");
      calls.set(String(invocation.id), invocation);
      const emulated = result(
        node,
        "gcp",
        "vertex.models.generateContent",
        invocation,
        invocation,
        "vertex.invocations.get",
        this.require(calls, String(invocation.id), "Vertex invocation"),
      );
      if (p.simulatedResponse !== undefined)
        emulated.output = clone(p.simulatedResponse);
      return emulated;
    }
    return undefined;
  }

  private executeNotion(
    node: WorkflowNode,
    p: Json,
    _input: Json = {},
  ): EmulatedIntegrationResult | undefined {
    const resource = String(p.resource ?? "page");
    const operation = String(
      p.operation ?? (resource === "block" ? "append" : "get"),
    );
    const id = value(p.pageId ?? p.databaseId ?? p.blockId ?? p.id);
    const storeName = `notion.${resource}s`;
    if (["get", "getAll", "search"].includes(operation))
      return this.getOrList(node, "notion", operation, storeName, p, id);
    if (["create", "update", "append"].includes(operation)) {
      const propertyValues = Array.isArray(
        object(p.propertiesUi).propertyValues,
      )
        ? (object(p.propertiesUi).propertyValues as Json[])
        : [];
      const mappedProperties = Object.fromEntries(
        propertyValues.map((entry) => {
          const key = value(entry.key).split("|")[0] || "property";
          const field = Object.keys(entry).find((name) =>
            name.endsWith("Value"),
          );
          return [key, field ? entry[field] : undefined];
        }),
      );
      return this.upsert(
        node,
        "notion",
        `${resource}s.${operation}`,
        storeName,
        resource,
        p,
        {
          object: resource,
          parent: p.parent ?? p.databaseId,
          properties:
            propertyValues.length > 0
              ? mappedProperties
              : object(p.propertiesUi ?? p.properties),
          title: p.title ?? "",
          blocks: p.blockUi,
        },
        id,
      );
    }
    return undefined;
  }

  private executeJira(
    node: WorkflowNode,
    p: Json,
    _input: Json = {},
  ): EmulatedIntegrationResult | undefined {
    const operation = String(p.operation ?? "create");
    const resource = String(p.resource ?? "issue");
    if (resource === "issueComment" || resource === "comment") {
      const issueKey = value(p.issueKey ?? p.issueId);
      if (!issueKey) throw new Error("Jira issue key is empty");
      return this.upsert(
        node,
        "jira",
        "issues.comments.create",
        `jira.comments.${issueKey}`,
        "comment",
        p,
        { issueKey, body: p.comment ?? p.body ?? "" },
      );
    }
    const id = value(p.issueKey ?? p.issueId ?? p.id);
    if (["get", "getAll", "search"].includes(operation))
      return this.getOrList(node, "jira", operation, "jira.issues", p, id);
    if (["create", "update"].includes(operation)) {
      const key = id || `S8N-${this.sequence + 1}`;
      const previousFields = object(this.store("jira.issues").get(key)?.fields);
      const updateFields = object(p.updateFields);
      return this.upsert(
        node,
        "jira",
        `issues.${operation}`,
        "jira.issues",
        "issue",
        p,
        {
          key,
          fields: {
            ...previousFields,
            ...(p.summary !== undefined ? { summary: p.summary } : {}),
            ...(p.description !== undefined
              ? { description: p.description }
              : {}),
            ...(p.issueType !== undefined || p.issueTypeId !== undefined
              ? { issueType: p.issueType ?? p.issueTypeId }
              : {}),
            ...(p.projectKey !== undefined || p.project !== undefined
              ? { project: p.projectKey ?? p.project }
              : {}),
            ...updateFields,
          },
        },
        key,
      );
    }
    return undefined;
  }

  private executeGithub(
    node: WorkflowNode,
    p: Json,
    _input: Json = {},
  ): EmulatedIntegrationResult | undefined {
    const operation = String(p.operation ?? "create");
    const resource = String(p.resource ?? "issue");
    const rawOwner = value(p.owner) || "local";
    const owner = rawOwner
      .replace(/^https?:\/\/github\.com\//, "")
      .replace(/\/$/, "");
    const repository = value(p.repository ?? p.repo) || "repo";
    const namespace = `github.${owner}.${repository}.${resource}s`;
    const id = value(
      p.issueNumber ?? p.releaseId ?? p.filePath ?? p.path ?? p.id,
    );
    if (["get", "getAll", "list"].includes(operation))
      return this.getOrList(node, "github", operation, namespace, p, id);
    if (operation === "createComment") {
      this.require(
        this.store(`github.${owner}.${repository}.issues`),
        id,
        "github issue",
      );
      return this.upsert(
        node,
        "github",
        "issues.comments.create",
        `github.${owner}.${repository}.issueComments.${id}`,
        "comment",
        p,
        { issueNumber: Number(id), body: p.body ?? "" },
      );
    }
    if (["create", "edit", "update"].includes(operation)) {
      const number = id || String(this.store(namespace).size + 1);
      return this.upsert(
        node,
        "github",
        `${resource}s.${operation}`,
        namespace,
        resource,
        p,
        {
          number: Number.isNaN(Number(number)) ? number : Number(number),
          title: p.title ?? "",
          body: p.body ?? p.description ?? "",
          state: p.state ?? "open",
          owner,
          repository,
          html_url: `https://github.com/${owner}/${repository}/${resource}/${number}`,
        },
        number,
      );
    }
    return undefined;
  }
}
