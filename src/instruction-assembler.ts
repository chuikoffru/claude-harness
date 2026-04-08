import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "fs";
import { resolve as pathResolve, join } from "path";
import type { ChannelState } from "./types";
import { logger } from "./logger";

export class InstructionAssembler {
  private instructionsDir: string;

  constructor() {
    this.instructionsDir = pathResolve("workspace/instructions");
    mkdirSync(this.instructionsDir, { recursive: true });

    // Ensure global.md exists with base instructions
    const globalFile = join(this.instructionsDir, "global.md");
    if (!existsSync(globalFile)) {
      writeFileSync(globalFile, DEFAULT_GLOBAL_INSTRUCTIONS);
    }
  }

  /**
   * Build CLAUDE.md for a channel session.
   * Contains ONLY instructions: global + channel-specific + user rules.
   * NO conversation history, NO daily notes — those are in QMD.
   */
  build(channel: ChannelState): string {
    const parts: string[] = [];

    // 1. Global instructions (how to use tools, QMD, memory)
    const globalFile = join(this.instructionsDir, "global.md");
    if (existsSync(globalFile)) {
      parts.push(readFileSync(globalFile, "utf-8"));
    }

    // 2. Channel-specific instructions
    const channelFile = join(this.instructionsDir, `${channel.name}.md`);
    if (existsSync(channelFile)) {
      parts.push(readFileSync(channelFile, "utf-8"));
    }

    // 3. User rules (persistent user requests accumulated over time)
    const rulesFile = join(this.instructionsDir, "user-rules.md");
    if (existsSync(rulesFile)) {
      parts.push(readFileSync(rulesFile, "utf-8"));
    }

    const assembled = parts.join("\n\n---\n\n");

    // Write to channel's workDir so claude picks it up
    const claudeMdDir = join(channel.workDir, ".claude");
    mkdirSync(claudeMdDir, { recursive: true });
    writeFileSync(join(claudeMdDir, "CLAUDE.md"), assembled);

    logger.debug("Instructions", `[${channel.name}] Built CLAUDE.md (${assembled.length} chars)`);
    return assembled;
  }

  /**
   * Save a user instruction/rule that should persist across sessions.
   * Called when user says "always do X" or "remember to Y".
   */
  addUserRule(rule: string, source?: string) {
    const rulesFile = join(this.instructionsDir, "user-rules.md");
    if (!existsSync(rulesFile)) {
      writeFileSync(rulesFile, "# User Rules\n\n<!-- Persistent user instructions -->\n\n");
    }
    const timestamp = new Date().toISOString().slice(0, 10);
    appendFileSync(rulesFile, `- ${rule}${source ? ` (${source}, ${timestamp})` : ` (${timestamp})`}\n`);
    logger.info("Instructions", `Added user rule: ${rule.slice(0, 80)}`);
  }

  /** Get current user rules */
  getUserRules(): string {
    const rulesFile = join(this.instructionsDir, "user-rules.md");
    if (!existsSync(rulesFile)) return "";
    return readFileSync(rulesFile, "utf-8");
  }
}

const DEFAULT_GLOBAL_INSTRUCTIONS = `# Claude Harness — Instructions

You are an AI assistant running inside Claude Harness, a personal agent system.
You communicate through Telegram topics (each topic = isolated channel/session).

## Tools Available

### QMD — Semantic Memory Search
You have access to QMD search via MCP tools. Use it to recall past conversations,
decisions, and context:

- **qmd_query** — hybrid search (BM25 + vector + rerank). Best quality, use by default.
- **qmd_search** — keyword-only BM25 search. Fast, good for exact terms.
- **qmd_vsearch** — vector semantic search only. Good for conceptual similarity.

**Always search memory before starting complex tasks.** The user expects continuity.

### Harness MCP Tools
- **memory_save** — save important facts to long-term memory (gets indexed by QMD)
- **memory_daily** — write a note to today's daily log
- **instruction_add** — save a persistent user instruction/rule
- **channel_send** — send a message to another Telegram channel/topic
- **cron_create** — schedule a recurring task
- **cron_list** — list scheduled tasks
- **cron_delete** — remove a scheduled task

## Rules
- Search memory (qmd_query) before complex tasks to get relevant context
- Save important decisions, facts, and outcomes using memory_save
- When the user asks you to "always do X" or "remember to Y", use instruction_add
- Be concise — responses go to Telegram chat (limited formatting)
- Use Markdown sparingly (Telegram supports basic markdown only)
- When you learn something new about the user or project, save it to memory
`;
