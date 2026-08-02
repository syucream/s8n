/**
 * Tailored mock-shape hints for node types s8n doesn't (and can't
 * meaningfully) execute for real - third-party app/service integrations and
 * AI/LangChain nodes. These are inherently external IO: s8n's only useful
 * job for them is mocking their output, but a generic "guess the shape"
 * hint is much less useful than a hint that reflects what that specific
 * API actually returns. Shapes below are simplified subsets of each
 * service's well-known public API response format - written from public
 * API documentation knowledge, not copied from any n8n or Ubie source.
 *
 * Keyed by the bare node type string (`n8n-nodes-base.slack`, etc.). Falls
 * back to the fully generic hint in `generic-fallback.ts` when a type has
 * no entry here.
 */
export interface NodeTypeMockHint {
  description: string;
  example: Record<string, unknown>;
}

const SLACK_MESSAGE_EXAMPLE = {
  ok: true,
  channel: "C0123456789",
  ts: "1706400000.000100",
  message: { text: "Hello from s8n", user: "U0BOT", ts: "1706400000.000100" },
};

const NOTION_PAGE_EXAMPLE = {
  object: "page",
  id: "9bdb0000-0000-0000-0000-000000000000",
  created_time: "2026-01-28T00:00:00.000Z",
  last_edited_time: "2026-01-28T00:00:00.000Z",
  url: "https://www.notion.so/Example-Page-9bdb0000000000000000000000000000",
  properties: { Name: { title: [{ plain_text: "Example page" }] } },
};

const GOOGLE_SHEETS_VALUES_EXAMPLE = {
  spreadsheetId: "1AbCDefGhIjKLmNoPQRstuVWxyz",
  updatedRange: "Sheet1!A2:C2",
  updatedRows: 1,
  values: [["value1", "value2", "value3"]],
};

const HTTP_LIKE_TOOL_EXAMPLE = { status: 200, data: { result: "ok" } };

const NODE_TYPE_MOCK_HINTS: Record<string, NodeTypeMockHint> = {
  // --- Slack ---
  "n8n-nodes-base.slack": {
    description: "A Slack Web API response, such as chat.postMessage.",
    example: SLACK_MESSAGE_EXAMPLE,
  },
  "n8n-nodes-base.slackTrigger": {
    description: "A Slack event payload, such as a posted message.",
    example: {
      type: "message",
      channel: "C0123456789",
      user: "U0123456789",
      text: "hello",
      ts: "1706400000.000100",
    },
  },
  "n8n-nodes-base.slackTool": {
    description:
      "The result of a Slack tool called by a LangChain Agent, usually a text summary.",
    example: { output: "Message sent to #general" },
  },

  // --- Notion ---
  "n8n-nodes-base.notion": {
    description: "A Notion API page or database object.",
    example: NOTION_PAGE_EXAMPLE,
  },
  "n8n-nodes-base.notionTrigger": {
    description: "A Notion page creation or update event.",
    example: NOTION_PAGE_EXAMPLE,
  },
  "n8n-nodes-base.notionTool": {
    description: "The result of a Notion tool called by a LangChain Agent.",
    example: { output: "Page created: Example page" },
  },

  // --- Google BigQuery ---
  "n8n-nodes-base.googleBigQuery": {
    description: "BigQuery query results with jobs.query-compatible row data.",
    example: {
      kind: "bigquery#queryResponse",
      totalRows: "1",
      rows: [{ f: [{ v: "42" }] }],
    },
  },
  "n8n-nodes-base.googleBigQueryTool": {
    description: "The result of a BigQuery tool called by a LangChain Agent.",
    example: { output: "1 row returned" },
  },

  // --- Google Sheets ---
  "n8n-nodes-base.googleSheets": {
    description: "A Google Sheets API response, such as append or read.",
    example: GOOGLE_SHEETS_VALUES_EXAMPLE,
  },
  "n8n-nodes-base.googleSheetsTool": {
    description:
      "The result of a Google Sheets tool called by a LangChain Agent.",
    example: { output: "1 row appended" },
  },
  "n8n-nodes-base.googleSheetsTrigger": {
    description: "A sheet change event containing the updated row data.",
    example: { row_number: 2, id: "1", value: "changed" },
  },

  // --- Google Drive ---
  "n8n-nodes-base.googleDrive": {
    description: "Google Drive API file or folder metadata.",
    example: {
      id: "1a2b3c",
      name: "example.pdf",
      mimeType: "application/pdf",
      webViewLink: "https://drive.google.com/file/d/1a2b3c/view",
    },
  },
  "n8n-nodes-base.googleDriveTrigger": {
    description: "A Google Drive file creation or update event.",
    example: { id: "1a2b3c", name: "example.pdf", mimeType: "application/pdf" },
  },

  // --- Google Calendar ---
  "n8n-nodes-base.googleCalendar": {
    description: "A Google Calendar API event object.",
    example: {
      id: "abc123",
      summary: "Team sync",
      start: { dateTime: "2026-01-28T10:00:00+09:00" },
      end: { dateTime: "2026-01-28T10:30:00+09:00" },
    },
  },
  "n8n-nodes-base.googleCalendarTrigger": {
    description: "A calendar event creation or start notification.",
    example: {
      id: "abc123",
      summary: "Team sync",
      start: { dateTime: "2026-01-28T10:00:00+09:00" },
    },
  },

  // --- Google Docs / Cloud Storage ---
  "n8n-nodes-base.googleDocs": {
    description: "Google Docs API document metadata.",
    example: { documentId: "1a2b3c", title: "Example doc" },
  },
  "n8n-nodes-base.googleCloudStorage": {
    description: "Google Cloud Storage object metadata.",
    example: {
      name: "example.json",
      bucket: "my-bucket",
      size: "1024",
      contentType: "application/json",
    },
  },

  // --- Gmail ---
  "n8n-nodes-base.gmail": {
    description: "A Gmail API message object.",
    example: {
      id: "18abc",
      threadId: "18abc",
      labelIds: ["INBOX"],
      snippet: "Hello, this is an example email",
    },
  },
  "n8n-nodes-base.gmailTrigger": {
    description: "A new-email event.",
    example: {
      id: "18abc",
      from: "sender@example.com",
      subject: "Example",
      snippet: "Hello",
    },
  },
  "n8n-nodes-base.emailSend": {
    description: "The delivery result from an SMTP email send operation.",
    example: {
      accepted: ["recipient@example.com"],
      rejected: [],
      messageId: "<s8n-sample@example.com>",
      response: "250 Message accepted",
    },
  },
  "n8n-nodes-base.emailReadImap": {
    description: "An email received over IMAP.",
    example: {
      subject: "Example",
      from: "sender@example.com",
      textPlain: "Hello",
      date: "2026-01-28T00:00:00.000Z",
    },
  },

  // --- Jira / Salesforce / HubSpot ---
  "n8n-nodes-base.jira": {
    description: "A Jira REST API issue object.",
    example: {
      id: "10001",
      key: "PROJ-1",
      fields: { summary: "Example issue", status: { name: "To Do" } },
    },
  },
  "n8n-nodes-base.jiraTool": {
    description: "The result of a Jira tool called by a LangChain Agent.",
    example: { output: "Issue PROJ-1 updated" },
  },
  "n8n-nodes-base.jiraTrigger": {
    description: "A Jira issue update event.",
    example: { issue: { key: "PROJ-1", fields: { summary: "Example issue" } } },
  },
  "n8n-nodes-base.salesforce": {
    description: "A Salesforce REST API record.",
    example: {
      id: "0011U00000ExampleId",
      success: true,
      Name: "Example Account",
    },
  },
  "n8n-nodes-base.salesforceTrigger": {
    description: "A Salesforce record change event.",
    example: { Id: "0011U00000ExampleId", Name: "Example Account" },
  },
  "n8n-nodes-base.hubspot": {
    description: "A HubSpot API object, such as a contact or deal.",
    example: {
      id: "1",
      properties: { email: "example@example.com", firstname: "Taro" },
    },
  },
  "n8n-nodes-base.hubspotTrigger": {
    description: "A HubSpot event notification.",
    example: {
      objectId: 1,
      propertyName: "email",
      propertyValue: "example@example.com",
    },
  },

  // --- GitHub ---
  "n8n-nodes-base.github": {
    description: "A GitHub REST API object, such as an issue or pull request.",
    example: {
      id: 1,
      number: 1,
      title: "Example issue",
      state: "open",
      html_url: "https://github.com/example/repo/issues/1",
    },
  },
  "n8n-nodes-base.githubTool": {
    description: "The result of a GitHub tool called by a LangChain Agent.",
    example: { output: "Issue #1 created" },
  },

  // --- Misc SaaS ---
  "n8n-nodes-base.redis": {
    description: "The result of a Redis command.",
    example: { result: "OK" },
  },
  "n8n-nodes-base.todoist": {
    description: "A Todoist API task object.",
    example: { id: "1", content: "Example task", is_completed: false },
  },
  "n8n-nodes-base.zendeskTrigger": {
    description: "A Zendesk ticket event.",
    example: { id: 1, subject: "Example ticket", status: "open" },
  },
  "n8n-nodes-base.twitter": {
    description: "An X (Twitter) API v2 response.",
    example: { data: { id: "1234567890", text: "Example tweet" } },
  },
  "n8n-nodes-base.telegram": {
    description: "A Telegram Bot API message response.",
    example: {
      ok: true,
      result: {
        message_id: 1,
        date: 1785628800,
        chat: { id: 123456789, type: "private" },
        text: "Hello from s8n",
      },
    },
  },
  "n8n-nodes-base.telegramTrigger": {
    description: "A Telegram Bot API update received by a trigger.",
    example: {
      update_id: 1,
      message: {
        message_id: 1,
        date: 1785628800,
        chat: { id: 123456789, type: "private" },
        from: { id: 123456789, first_name: "Sample" },
        text: "Representative workflow sample",
      },
    },
  },
  "n8n-nodes-base.miro": {
    description: "A Miro API board or item object.",
    example: {
      id: "3074457345",
      type: "sticky_note",
      data: { content: "Example note" },
    },
  },
  "n8n-nodes-base.microsoftOneDriveTrigger": {
    description: "A OneDrive file change event.",
    example: { id: "01ABC", name: "example.docx" },
  },
  "n8n-nodes-base.openAi": {
    description: "An OpenAI API response, such as a chat completion.",
    example: {
      id: "chatcmpl-example",
      choices: [
        { message: { role: "assistant", content: "Example response" } },
      ],
    },
  },
  "n8n-nodes-base.dataTable": {
    description: "Row data from an n8n Data Table.",
    example: { rows: [{ id: 1, name: "example" }] },
  },
  "n8n-nodes-base.rssFeedRead": {
    description: "Items from an RSS feed.",
    example: {
      title: "Example entry",
      link: "https://example.com/entry",
      pubDate: "2026-01-28T00:00:00.000Z",
      contentSnippet: "Example summary",
    },
  },
  "n8n-nodes-base.rssFeedReadTrigger": {
    description: "A new RSS entry event.",
    example: {
      title: "Example entry",
      link: "https://example.com/entry",
      pubDate: "2026-01-28T00:00:00.000Z",
    },
  },
  "n8n-nodes-base.n8n": {
    description: "An n8n API response for workflow or execution management.",
    example: { id: "1", name: "Example workflow", active: true },
  },
  "n8n-nodes-base.executeWorkflow": {
    description:
      "The data a called sub-workflow would return. s8n does not resolve or execute sub-workflows, so provide the final items expected from the logic after its Execute Workflow Trigger.",
    example: { output: "example result from the sub-workflow" },
  },
  "n8n-nodes-base.formTrigger": {
    description: "Submitted n8n Form data mapping field names to input values.",
    example: { "Field 1": "example value", "Field 2": "example value 2" },
  },
  "n8n-nodes-base.errorTrigger": {
    description: "Error details passed when another workflow fails.",
    example: {
      execution: { id: "123", url: "" },
      workflow: { id: "1", name: "Example" },
      trigger: { mode: "manual" },
    },
  },
  "n8n-nodes-base.evaluationTrigger": {
    description: "One row from an evaluation dataset.",
    example: {
      input: "example input",
      expectedOutput: "example expected output",
    },
  },
  "n8n-nodes-base.form": {
    description: "Input data for one step of a multi-step n8n Form.",
    example: { "Field 1": "example value" },
  },
  "n8n-nodes-base.executeCommand": {
    description:
      "The result of a host shell command. s8n does not execute the real command.",
    example: { stdout: "example output\n", stderr: "", exitCode: 0 },
  },
  "n8n-nodes-base.extractFromFile": {
    description: "Data extracted from a binary file, such as CSV or JSON.",
    example: { data: [{ column1: "value1", column2: "value2" }] },
  },
  "n8n-nodes-base.convertToFile": {
    description:
      "Metadata for a generated binary file. s8n does not handle the actual bytes.",
    example: { fileName: "output.csv", mimeType: "text/csv" },
  },
  "n8n-nodes-base.spreadsheetFile": {
    description: "Row data read from a spreadsheet file.",
    example: { data: [{ column1: "value1", column2: "value2" }] },
  },
  "n8n-nodes-base.html": {
    description:
      "Data extracted from HTML into fields selected by CSS selectors.",
    example: { title: "Example title", body: "Example body text" },
  },
  "n8n-nodes-base.markdown": {
    description:
      "The result of a Markdown-to-HTML or HTML-to-Markdown conversion.",
    example: { data: "<p>Example</p>" },
  },
  "n8n-nodes-base.httpRequestTool": {
    description:
      "The result of an HTTP request tool called by a LangChain Agent.",
    example: HTTP_LIKE_TOOL_EXAMPLE,
  },
  "n8n-nodes-base.dateTimeTool": {
    description:
      "The result of a Date & Time tool called by a LangChain Agent.",
    example: { output: "2026-01-28" },
  },

  // --- LangChain / AI ---
  "@n8n/n8n-nodes-langchain.agent": {
    description:
      "The final text output from a LangChain Agent after tool calls.",
    example: { output: "Here is the answer you requested." },
  },
  "@n8n/n8n-nodes-langchain.chainLlm": {
    description: "Text output from an LLM Chain.",
    example: { text: "Example generated text" },
  },
  "@n8n/n8n-nodes-langchain.openAi": {
    description:
      "An OpenAI chat completion response returned through LangChain.",
    example: { message: { content: "Example response" } },
  },
  "@n8n/n8n-nodes-langchain.googleGemini": {
    description: "A Google Gemini API response.",
    example: { content: "Example response" },
  },
  "@n8n/n8n-nodes-langchain.lmChatOpenAi": {
    description:
      "An OpenAI Chat Model response, normally consumed through an Agent or Chain.",
    example: { content: "Example response" },
  },
  "@n8n/n8n-nodes-langchain.lmChatGoogleGemini": {
    description: "A Google Gemini Chat Model response.",
    example: { content: "Example response" },
  },
  "@n8n/n8n-nodes-langchain.lmChatGoogleVertex": {
    description: "A Google Vertex AI Chat Model response.",
    example: { content: "Example response" },
  },
  "@n8n/n8n-nodes-langchain.lmChatAnthropic": {
    description: "An Anthropic Claude Chat Model response.",
    example: { content: "Example response" },
  },
  "@n8n/n8n-nodes-langchain.lmChatOpenRouter": {
    description:
      "An OpenRouter chat-model response, normally consumed through an Agent or Chain.",
    example: { content: "Example response from an OpenRouter model" },
  },
  "@n8n/n8n-nodes-langchain.outputParserStructured": {
    description:
      "The result of a structured output parser, conforming to its JSON schema.",
    example: { output: { field1: "value1" } },
  },
  "@n8n/n8n-nodes-langchain.memoryBufferWindow": {
    description:
      "Conversation memory state, normally not referenced directly downstream.",
    example: { chatHistory: [] },
  },
  "@n8n/n8n-nodes-langchain.toolHttpRequest": {
    description: "The result of an Agent HTTP request tool.",
    example: HTTP_LIKE_TOOL_EXAMPLE,
  },
  "@n8n/n8n-nodes-langchain.toolWorkflow": {
    description: "The result of an Agent sub-workflow tool.",
    example: { output: "example result" },
  },
  "@n8n/n8n-nodes-langchain.toolSerpApi": {
    description: "The result of an Agent SerpAPI search tool.",
    example: { output: "Example search results summary" },
  },
  "@n8n/n8n-nodes-langchain.chatTrigger": {
    description: "A message received from the n8n Chat UI.",
    example: { chatInput: "Example user message", sessionId: "abc-123" },
  },
  "@n8n/n8n-nodes-langchain.chat": {
    description: "A Chat node response.",
    example: { output: "Example response" },
  },
};

export function findNodeTypeMockHint(
  type: string,
): NodeTypeMockHint | undefined {
  return NODE_TYPE_MOCK_HINTS[type];
}

export function allNodeTypeMockHints(): Array<
  { type: string } & NodeTypeMockHint
> {
  return Object.entries(NODE_TYPE_MOCK_HINTS).map(([type, hint]) => ({
    type,
    ...hint,
  }));
}
