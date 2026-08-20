import { type RunResult, terminalOutput } from "../engine/execute.ts";
import type { Item } from "../schema/item.ts";
import type { Workflow, WorkflowNode } from "../schema/workflow.ts";
import type { ServeResponseMode } from "./types.ts";

const RESPOND_TO_WEBHOOK_TYPE = "n8n-nodes-base.respondToWebhook";

/** Serialized HTTP response the server writes back to a caller. */
export interface HttpRespond {
  status: number;
  headers?: Record<string, string>;
  contentType?: string;
  body: string | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function extractResponseHeaders(
  options: Record<string, unknown>,
): Record<string, string> | undefined {
  const entries = options.responseHeaders;
  if (
    entries === null ||
    typeof entries !== "object" ||
    !("entries" in entries) ||
    !Array.isArray((entries as { entries: unknown }).entries)
  ) {
    return undefined;
  }
  const headers: Record<string, string> = {};
  for (const entry of (entries as { entries: unknown[] }).entries) {
    if (entry === null || typeof entry !== "object") continue;
    const { name, value } = entry as { name?: unknown; value?: unknown };
    if (typeof name === "string" && name !== "") {
      headers[name] = stringOf(value);
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/** Response code for a webhook, honoring both the v1 `responseCode` and the v2 `options.responseCode` shapes. */
function resolveWebhookResponseCode(
  node: WorkflowNode,
  options: Record<string, unknown>,
): number {
  if (typeof node.parameters.responseCode === "number") {
    return node.parameters.responseCode;
  }
  const collection = options.responseCode;
  if (isObject(collection) && isObject(collection.values)) {
    const values = collection.values;
    if (typeof values.customCode === "number" && values.customCode > 0) {
      return values.customCode;
    }
    if (typeof values.responseCode === "number" && values.responseCode > 0) {
      return values.responseCode;
    }
  }
  return 200;
}

function jsonRespond(
  status: number,
  payload: unknown,
  headers?: Record<string, string>,
): HttpRespond {
  return {
    status,
    headers,
    contentType: "application/json",
    body: JSON.stringify(payload),
  };
}

/** Terminal output of a run: nodes that have no main-connection destinations. */
function terminalItems(workflow: Workflow, result: RunResult): Item[] {
  return (terminalOutput(workflow, result)[0] ?? []).slice();
}

function respondNodeResponse(
  workflow: Workflow,
  result: RunResult,
): HttpRespond {
  const nodes = workflow.nodes.filter(
    (node) => node.type === RESPOND_TO_WEBHOOK_TYPE,
  );
  for (const node of [...nodes].reverse()) {
    const items = result.nodeOutputs[node.name];
    if (items === undefined || items.length === 0) continue;
    return buildRespondToWebhookResponse(node, items);
  }
  return jsonRespond(500, {
    ok: false,
    error:
      'responseNode mode requires an executed "Respond to Webhook" node, but none produced output',
  });
}

function buildRespondToWebhookResponse(
  node: WorkflowNode,
  items: Item[],
): HttpRespond {
  const respondWith =
    stringOf(node.parameters.respondWith) || "firstIncomingItem";
  const options = isObject(node.parameters.options)
    ? node.parameters.options
    : {};
  const headers = extractResponseHeaders(options);
  const status =
    typeof options.responseCode === "number" && options.responseCode > 0
      ? options.responseCode
      : 200;

  const wrap = (value: unknown): unknown => {
    const key = stringOf(options.responseKey);
    return key !== "" ? { [key]: value } : value;
  };

  switch (respondWith) {
    case "allIncomingItems": {
      return jsonRespond(status, wrap(items.map((item) => item.json)), headers);
    }
    case "firstIncomingItem": {
      return jsonRespond(status, wrap(items[0]?.json ?? {}), headers);
    }
    case "json": {
      const raw = node.parameters.responseBody;
      let parsed: unknown;
      if (typeof raw === "string" && raw.trim() !== "") {
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
      } else {
        parsed = raw ?? {};
      }
      return jsonRespond(status, parsed, headers);
    }
    case "text": {
      return {
        status,
        headers,
        contentType: "text/plain",
        body: stringOf(node.parameters.responseBody),
      };
    }
    case "redirect": {
      return {
        status: status === 200 ? 307 : status,
        headers: {
          ...(headers ?? {}),
          location: stringOf(node.parameters.redirectURL),
        },
        body: null,
      };
    }
    case "noData": {
      return { status, headers, body: null };
    }
    case "binary":
    case "jwt": {
      return jsonRespond(
        501,
        {
          ok: false,
          error: `Respond to Webhook respondWith "${respondWith}" is not supported by the s8n mock server`,
        },
        headers,
      );
    }
    default: {
      return jsonRespond(
        500,
        { ok: false, error: `Unsupported respondWith "${respondWith}"` },
        headers,
      );
    }
  }
}

/** Builds the webhook HTTP response from a completed run, per n8n responseMode. */
export function buildWebhookResponse(
  workflow: Workflow,
  result: RunResult,
  triggerNode: WorkflowNode,
): HttpRespond {
  const params = triggerNode.parameters;
  const options = isObject(params.options) ? params.options : {};
  const responseMode = (stringOf(params.responseMode) ||
    "onReceived") as ServeResponseMode;
  const statusCode = resolveWebhookResponseCode(triggerNode, options);
  const headers = extractResponseHeaders(options);

  if (responseMode === "responseNode") {
    return respondNodeResponse(workflow, result);
  }

  // "streaming" degrades to onReceived for the mock (documented).
  if (responseMode === "onReceived" || responseMode === "streaming") {
    const customData =
      typeof options.responseData === "string" && options.responseData !== ""
        ? (options.responseData as string)
        : undefined;
    const noBody = options.noResponseBody === true || customData === undefined;
    return {
      status: statusCode,
      headers,
      contentType: noBody ? undefined : "text/plain",
      body: noBody ? null : customData,
    };
  }

  // lastNode
  const responseData = stringOf(params.responseData) || "firstEntryJson";
  if (responseData === "noData") {
    return { status: statusCode, headers, body: null };
  }
  const items = terminalItems(workflow, result);
  const contentType =
    stringOf(options.responseContentType) || "application/json";
  if (responseData === "allEntries") {
    return {
      status: statusCode,
      headers: { ...(headers ?? {}), "content-type": contentType },
      contentType,
      body: JSON.stringify(items.map((item) => item.json)),
    };
  }
  // firstEntryJson (default) - optionally narrowed to one property
  const first = items[0]?.json ?? {};
  const propertyName = stringOf(options.responsePropertyName);
  const payload =
    propertyName !== ""
      ? (first as Record<string, unknown>)[propertyName]
      : first;
  return {
    status: statusCode,
    headers: { ...(headers ?? {}), "content-type": contentType },
    contentType,
    body: JSON.stringify(payload),
  };
}

/** Form POST responses: n8n returns an empty 200 (post-submit UX is client-side). */
export function buildFormResponse(): HttpRespond {
  return { status: 200, body: null };
}

/** Error/waiting responses that surface engine outcomes to the HTTP caller. */
export function buildErrorResponse(result: RunResult): HttpRespond {
  return jsonRespond(500, {
    ok: false,
    status: result.status,
    errors: result.errors,
    pendingMocks: result.pendingMocks,
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderFormField(
  field: Record<string, unknown>,
  index: number,
): string {
  const fieldType = stringOf(field.fieldType) || "text";
  const label = stringOf(field.fieldLabel) || stringOf(field.fieldName);
  const name = `field-${index}`;
  const placeholder = stringOf(field.placeholder);
  const defaultValue = stringOf(field.defaultValue);
  const required = field.requiredField === true ? " required" : "";
  const options = Array.isArray(
    (field.fieldOptions as { values?: unknown } | undefined)?.values,
  )
    ? ((field.fieldOptions as { values: unknown[] }).values as Array<{
        option?: unknown;
      }>)
    : [];

  switch (fieldType) {
    case "textarea": {
      return `<label for="${name}">${escapeHtml(label)}</label><textarea id="${name}" name="${name}" placeholder="${escapeHtml(placeholder)}">${escapeHtml(defaultValue)}</textarea>`;
    }
    case "dropdown": {
      const optionHtml = options
        .map((option) => {
          const value = stringOf(option.option);
          return `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`;
        })
        .join("");
      return `<label for="${name}">${escapeHtml(label)}</label><select id="${name}" name="${name}">${optionHtml}</select>`;
    }
    case "checkbox": {
      return options
        .map((option) => {
          const value = stringOf(option.option);
          return `<label><input type="checkbox" name="${name}" value="${escapeHtml(value)}">${escapeHtml(value)}</label>`;
        })
        .join(" ");
    }
    case "radio": {
      return options
        .map((option) => {
          const value = stringOf(option.option);
          return `<label><input type="radio" name="${name}" value="${escapeHtml(value)}">${escapeHtml(value)}</label>`;
        })
        .join(" ");
    }
    case "hiddenField": {
      const value = stringOf(field.fieldValue) || defaultValue;
      return `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
    }
    case "html": {
      // Rich HTML fields are the workflow author's own content; rendered as-is
      // like n8n does (script/style tags are stripped by the editor upstream).
      return stringOf(field.html);
    }
    case "file": {
      return ""; // file uploads are not supported by the mock server
    }
    default: {
      const inputType =
        fieldType === "email" ||
        fieldType === "number" ||
        fieldType === "date" ||
        fieldType === "password"
          ? fieldType
          : "text";
      return `<label for="${name}">${escapeHtml(label)}</label><input id="${name}" type="${inputType}" name="${name}"${required} value="${escapeHtml(defaultValue)}" placeholder="${escapeHtml(placeholder)}">`;
    }
  }
}

/** Renders an HTML form page from a Form Trigger node, approximating n8n's form. */
export function renderFormPage(node: WorkflowNode, actionPath: string): string {
  const params = node.parameters;
  const options = isObject(params.options) ? params.options : {};
  const title = stringOf(params.formTitle);
  const description = stringOf(params.formDescription);
  const buttonLabel = stringOf(options.buttonLabel) || "Submit";
  const rawFields = Array.isArray(
    (params.formFields as { values?: unknown } | null | undefined)?.values,
  )
    ? ((params.formFields as { values: unknown[] }).values as Record<
        string,
        unknown
      >[])
    : [];
  const respondWith = isObject(
    (options.respondWithOptions as { values?: unknown } | undefined)?.values,
  )
    ? ((options.respondWithOptions as { values: Record<string, unknown> })
        .values as Record<string, unknown>)
    : undefined;
  const isRedirect = respondWith?.respondWith === "redirect";
  const redirectUrl = isRedirect ? stringOf(respondWith?.redirectUrl) : "";
  const submittedText =
    respondWith?.respondWith === "text"
      ? stringOf(respondWith?.formSubmittedText)
      : "Your response has been recorded";

  const fieldHtml = rawFields.map(renderFormField).join("\n");
  const script = `
    <script>
      (function () {
        var form = document.querySelector('form');
        var status = document.getElementById('s8n-form-status');
        var submittedText = ${JSON.stringify(submittedText)};
        var redirectUrl = ${JSON.stringify(redirectUrl || null)};
        if (!form) return;
        form.addEventListener('submit', async function (event) {
          event.preventDefault();
          try {
            await fetch(form.getAttribute('action'), {
              method: 'POST',
              body: new URLSearchParams(new FormData(form)),
            });
            if (redirectUrl) { window.location.href = redirectUrl; return; }
            status.textContent = submittedText;
          } catch (error) {
            status.textContent = 'Submission failed';
          }
        });
      })();
    </script>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;color:#172033}label{display:block;margin-top:1rem}input,select,textarea{width:100%;padding:.5rem;margin-top:.25rem;border:1px solid #cbd5e1;border-radius:.25rem}button{margin-top:1.25rem;padding:.6rem 1.25rem;background:#1f2937;color:#fff;border:0;border-radius:.25rem;cursor:pointer}button:hover{background:#111827}</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
${description === "" ? "" : `<p>${escapeHtml(description)}</p>`}
<form method="post" action="${escapeHtml(actionPath)}" enctype="application/x-www-form-urlencoded">
${fieldHtml}
<button type="submit">${escapeHtml(buttonLabel)}</button>
</form>
<p id="s8n-form-status" role="status"></p>
</main>
${script}
</body>
</html>
`;
}
