// Code-first workflow definition. Must export the workflow object as the
// default export (or as a named `workflow` export). Any plain object literal
// works; `@n8n/workflow-sdk` outputs serialize to the same shape.
export default {
  name: "example-workflow-ts",
  nodes: [
    {
      name: "Manual Trigger",
      type: "n8n-nodes-base.manualTrigger",
      typeVersion: 1,
      position: [0, 0],
      parameters: {},
    },
    {
      name: "Set",
      type: "n8n-nodes-base.set",
      typeVersion: 1,
      position: [300, 0],
      parameters: {
        fields: [
          { name: "message", value: "=Hello, {{$json.name ?? 'world'}}!" },
        ],
      },
    },
  ],
  connections: {
    "Manual Trigger": {
      main: [[{ node: "Set", type: "main", index: 0 }]],
    },
  },
};
