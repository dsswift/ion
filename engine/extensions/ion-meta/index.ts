import * as readline from "readline";

// --- JSON-RPC helpers ---

interface RpcRequest {
  jsonrpc: string;
  id: number;
  method: string;
  params?: any;
}

function respond(id: number, result: any): void {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(msg + "\n");
}

function respondError(id: number, code: number, message: string): void {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  process.stdout.write(msg + "\n");
}

// --- Hook catalog ---

const hookCatalog: Record<string, string[]> = {
  lifecycle: [
    "session_start", "session_end", "before_prompt", "turn_start", "turn_end",
    "message_start", "message_end", "tool_start", "tool_end", "tool_call",
    "on_error", "agent_start", "agent_end",
  ],
  session: [
    "session_before_compact", "session_compact", "session_before_fork",
    "session_fork", "session_before_switch",
  ],
  "pre-action": [
    "before_agent_start", "before_provider_request",
  ],
  content: [
    "context", "message_update", "tool_result", "input", "model_select", "user_bash",
  ],
  "per-tool-call": [
    "bash_tool_call", "read_tool_call", "write_tool_call", "edit_tool_call",
    "grep_tool_call", "glob_tool_call", "agent_tool_call",
  ],
  "per-tool-result": [
    "bash_tool_result", "read_tool_result", "write_tool_result", "edit_tool_result",
    "grep_tool_result", "glob_tool_result", "agent_tool_result",
  ],
  "context-discovery": [
    "context_discover", "context_load", "instruction_load",
  ],
  permission: [
    "permission_request", "permission_denied",
  ],
  file: [
    "file_changed",
  ],
  task: [
    "task_created", "task_completed",
  ],
  elicitation: [
    "elicitation_request", "elicitation_result",
  ],
};

// --- Tool handlers ---

function handleScaffold(params: { name: string; type: "extension" | "agent" | "skill" }): any {
  const { name, type } = params;

  switch (type) {
    case "extension":
      return {
        files: ["index.ts", "README.md", "agents/orchestrator.md"],
        description: "Extension directory with entry point, README, and root agent",
      };
    case "agent":
      return {
        files: [`${name}.md`],
        template: [
          "---",
          `name: ${name}`,
          `description: <description>`,
          "model: claude-sonnet-4-6",
          "tools: [Read, Write]",
          "---",
          "",
          "You are...",
        ].join("\n"),
      };
    case "skill":
      return {
        files: [`${name}.md`],
        template: [
          "---",
          `name: ${name}`,
          `description: <description>`,
          "---",
          "",
          "Skill body...",
        ].join("\n"),
      };
    default:
      return { error: `Unknown scaffold type: ${type}` };
  }
}

function handleValidateAgent(params: { content: string }): any {
  const { content } = params;
  const errors: string[] = [];
  const warnings: string[] = [];

  // Find frontmatter between --- fences
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    return { valid: false, errors: ["No frontmatter found (expected --- fenced block)"], warnings };
  }

  const frontmatter = fmMatch[1];
  const lines = frontmatter.split("\n");
  const fields: Record<string, string> = {};

  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    fields[key] = value;
  }

  // Required fields
  if (!fields["name"]) errors.push("Missing required field: name");
  if (!fields["description"]) errors.push("Missing required field: description");

  // Optional fields -- warn if missing
  if (!fields["model"]) warnings.push("No model specified (will use session default)");
  if (!fields["tools"]) warnings.push("No tools specified (agent will have no tool access)");

  return { valid: errors.length === 0, errors, warnings };
}

function handleListHooks(params: { category?: string }): any {
  if (params.category) {
    const key = params.category.toLowerCase();
    if (hookCatalog[key]) {
      return { [key]: hookCatalog[key] };
    }
    return { error: `Unknown category: ${params.category}. Valid categories: ${Object.keys(hookCatalog).join(", ")}` };
  }
  return hookCatalog;
}

// --- Tool execution dispatch ---

function executeTool(toolName: string, params: any): any {
  switch (toolName) {
    case "ion_scaffold":
      return handleScaffold(params);
    case "ion_validate_agent":
      return handleValidateAgent(params);
    case "ion_list_hooks":
      return handleListHooks(params);
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// --- Tool and command definitions ---

const toolDefinitions = [
  {
    name: "ion_scaffold",
    description: "Generate scaffold structure for an Ion extension, agent, or skill",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name of the extension, agent, or skill" },
        type: { type: "string", enum: ["extension", "agent", "skill"], description: "Type of scaffold to generate" },
      },
      required: ["name", "type"],
    },
  },
  {
    name: "ion_validate_agent",
    description: "Validate agent markdown frontmatter for required and optional fields",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "Full markdown content of the agent file" },
      },
      required: ["content"],
    },
  },
  {
    name: "ion_list_hooks",
    description: "List available Ion engine hooks, optionally filtered by category",
    parameters: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Filter by category (lifecycle, session, pre-action, content, per-tool-call, per-tool-result, context-discovery, permission, file, task, elicitation)",
        },
      },
    },
  },
];

const commandDefinitions: Record<string, { description: string }> = {
  "/ion-meta": { description: "Ion Meta: extension authoring assistant" },
};

// --- Request handler ---

function handleRequest(req: RpcRequest): void {
  const { id, method, params } = req;

  switch (method) {
    case "init":
      respond(id, { tools: toolDefinitions, commands: commandDefinitions });
      break;

    case "hook/session_start":
      process.stderr.write("[ion-meta] extension active\n");
      respond(id, null);
      break;

    case "hook/before_prompt":
      respond(id, { value: "" });
      break;

    default:
      if (method.startsWith("hook/")) {
        respond(id, null);
      } else if (method.startsWith("tool/")) {
        const toolName = method.slice(5);
        const result = executeTool(toolName, params);
        respond(id, result);
      } else {
        respondError(id, -32601, `Method not found: ${method}`);
      }
      break;
  }
}

// --- Main: read JSON-RPC from stdin line by line ---

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const req: RpcRequest = JSON.parse(trimmed);
    handleRequest(req);
  } catch (err: any) {
    // Can't respond without an id, write parse error to stderr
    process.stderr.write(`[ion-meta] parse error: ${err.message}\n`);
  }
});
