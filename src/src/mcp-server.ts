/**
 * Harness MCP Server — stdio transport.
 * Provides tools to Claude Code sessions: memory_save, memory_daily,
 * instruction_add, channel_send, cron_create, cron_list, cron_delete.
 *
 * Runs as a subprocess spawned by claude via --mcp-config.
 * Communicates via stdin/stdout JSON-RPC (MCP protocol).
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { resolve as pathResolve, join } from "path";

const MEMORY_DIR = pathResolve("workspace/memory");
const INSTRUCTIONS_DIR = pathResolve("workspace/instructions");
const DATA_DIR = pathResolve("workspace/data");

// Ensure dirs exist
mkdirSync(MEMORY_DIR, { recursive: true });
mkdirSync(INSTRUCTIONS_DIR, { recursive: true });
mkdirSync(DATA_DIR, { recursive: true });

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function timeNow(): string {
  return new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

// === Tool implementations ===

function memorySave(args: { fact: string; source?: string }): string {
  const memFile = join(MEMORY_DIR, "MEMORY.md");
  if (!existsSync(memFile)) {
    writeFileSync(memFile, "# Long-term Memory\n\n");
  }
  const entry = `- ${args.fact}${args.source ? ` [${args.source}]` : ""} (${today()})\n`;
  appendFileSync(memFile, entry);
  return `Saved to memory: ${args.fact.slice(0, 100)}`;
}

function memoryDaily(args: { note: string; channel?: string }): string {
  const dailyFile = join(MEMORY_DIR, `${today()}.md`);
  if (!existsSync(dailyFile)) {
    writeFileSync(dailyFile, `# Daily Notes — ${today()}\n\n`);
  }
  const entry = `### ${args.channel ?? "claude"} — ${timeNow()}\n${args.note}\n\n`;
  appendFileSync(dailyFile, entry);
  return `Daily note saved.`;
}

function instructionAdd(args: { rule: string; source?: string }): string {
  const rulesFile = join(INSTRUCTIONS_DIR, "user-rules.md");
  if (!existsSync(rulesFile)) {
    writeFileSync(rulesFile, "# User Rules\n\n");
  }
  const entry = `- ${args.rule} (${today()})\n`;
  appendFileSync(rulesFile, entry);
  return `Instruction saved: ${args.rule.slice(0, 100)}`;
}

function channelSend(args: { channel: string; message: string }): string {
  // Write to a queue file that the main harness process picks up
  const queueFile = join(DATA_DIR, "outgoing-messages.jsonl");
  const entry = JSON.stringify({ channel: args.channel, message: args.message, ts: Date.now() }) + "\n";
  appendFileSync(queueFile, entry);
  return `Message queued for channel "${args.channel}"`;
}

function cronCreate(args: { name: string; cron: string; channel: string; prompt: string }): string {
  const cronFile = join(DATA_DIR, "cron-jobs.json");
  let jobs: any[] = [];
  if (existsSync(cronFile)) {
    try { jobs = JSON.parse(readFileSync(cronFile, "utf-8")); } catch {}
  }
  jobs = jobs.filter(j => j.name !== args.name);
  jobs.push({ name: args.name, cron: args.cron, channel: args.channel, prompt: args.prompt, enabled: true });
  writeFileSync(cronFile, JSON.stringify(jobs, null, 2));
  return `Cron job "${args.name}" created: ${args.cron}`;
}

function cronList(): string {
  const cronFile = join(DATA_DIR, "cron-jobs.json");
  if (!existsSync(cronFile)) return "No cron jobs.";
  try {
    const jobs = JSON.parse(readFileSync(cronFile, "utf-8"));
    return jobs.map((j: any) => `${j.enabled ? "✅" : "⏸"} ${j.name} [${j.cron}] → ${j.channel}`).join("\n") || "No cron jobs.";
  } catch { return "Error reading cron jobs."; }
}

function cronDelete(args: { name: string }): string {
  const cronFile = join(DATA_DIR, "cron-jobs.json");
  if (!existsSync(cronFile)) return "No cron jobs to delete.";
  try {
    let jobs = JSON.parse(readFileSync(cronFile, "utf-8"));
    const before = jobs.length;
    jobs = jobs.filter((j: any) => j.name !== args.name);
    writeFileSync(cronFile, JSON.stringify(jobs, null, 2));
    return before > jobs.length ? `Deleted "${args.name}"` : `Job "${args.name}" not found`;
  } catch { return "Error"; }
}

// === MCP Protocol (JSON-RPC over stdio) ===

const TOOLS = [
  {
    name: "memory_save",
    description: "Save an important fact to long-term memory. Gets indexed by QMD for semantic search. Use for decisions, user preferences, project details, key outcomes.",
    inputSchema: {
      type: "object",
      properties: {
        fact: { type: "string", description: "The fact to save" },
        source: { type: "string", description: "Optional: where this fact came from (channel name, context)" },
      },
      required: ["fact"],
    },
  },
  {
    name: "memory_daily",
    description: "Write a note to today's daily log. Use for session summaries, work progress, status updates.",
    inputSchema: {
      type: "object",
      properties: {
        note: { type: "string", description: "The note to write" },
        channel: { type: "string", description: "Optional: channel name for attribution" },
      },
      required: ["note"],
    },
  },
  {
    name: "instruction_add",
    description: "Save a persistent user instruction/rule. Use when the user says 'always do X', 'remember to Y', or gives a standing instruction.",
    inputSchema: {
      type: "object",
      properties: {
        rule: { type: "string", description: "The instruction/rule to save" },
        source: { type: "string", description: "Optional: context" },
      },
      required: ["rule"],
    },
  },
  {
    name: "channel_send",
    description: "Send a message to another Telegram channel/topic. Use to notify other channels or coordinate across topics.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel name to send to" },
        message: { type: "string", description: "Message text" },
      },
      required: ["channel", "message"],
    },
  },
  {
    name: "cron_create",
    description: "Create a scheduled recurring task. Use for daily standups, periodic checks, reminders.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Unique job name" },
        cron: { type: "string", description: "Cron expression (e.g. '0 9 * * 1-5' for weekdays at 9am)" },
        channel: { type: "string", description: "Channel to run in" },
        prompt: { type: "string", description: "Prompt to send to Claude" },
      },
      required: ["name", "cron", "channel", "prompt"],
    },
  },
  {
    name: "cron_list",
    description: "List all scheduled cron tasks.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cron_delete",
    description: "Delete a scheduled cron task by name.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Job name to delete" },
      },
      required: ["name"],
    },
  },
];

function handleRequest(method: string, params: any): any {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "claude-harness", version: "0.1.0" },
      };

    case "tools/list":
      return { tools: TOOLS };

    case "tools/call": {
      const toolName = params.name;
      const args = params.arguments ?? {};
      let result: string;

      switch (toolName) {
        case "memory_save": result = memorySave(args); break;
        case "memory_daily": result = memoryDaily(args); break;
        case "instruction_add": result = instructionAdd(args); break;
        case "channel_send": result = channelSend(args); break;
        case "cron_create": result = cronCreate(args); break;
        case "cron_list": result = cronList(); break;
        case "cron_delete": result = cronDelete(args); break;
        default: result = `Unknown tool: ${toolName}`;
      }

      return {
        content: [{ type: "text", text: result }],
      };
    }

    case "notifications/initialized":
      return undefined; // no response needed for notifications

    default:
      throw { code: -32601, message: `Method not found: ${method}` };
  }
}

// === stdio JSON-RPC loop ===

let buffer = "";

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;

  // MCP uses newline-delimited JSON
  let newlineIdx: number;
  while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);

    if (!line) continue;

    try {
      const request = JSON.parse(line);
      const result = handleRequest(request.method, request.params ?? {});

      // Don't respond to notifications
      if (result === undefined) continue;

      const response = {
        jsonrpc: "2.0",
        id: request.id,
        result,
      };
      process.stdout.write(JSON.stringify(response) + "\n");
    } catch (err: any) {
      const errorResponse = {
        jsonrpc: "2.0",
        id: null,
        error: err.code ? err : { code: -32603, message: String(err) },
      };
      process.stdout.write(JSON.stringify(errorResponse) + "\n");
    }
  }
});

process.stdin.on("end", () => process.exit(0));
