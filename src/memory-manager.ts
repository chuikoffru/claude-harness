import { mkdirSync, existsSync, appendFileSync, readFileSync, writeFileSync } from "fs";
import { resolve as pathResolve, join } from "path";
import { spawn } from "child_process";
import type { Config } from "./config";
import type { ChannelState } from "./types";
import { logger } from "./logger";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function timeNow(): string {
  return new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

export class MemoryManager {
  private memoryDir: string;
  private sessionsDir: string;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    this.memoryDir = pathResolve("workspace/memory");
    this.sessionsDir = pathResolve("workspace/sessions");
    mkdirSync(this.memoryDir, { recursive: true });
    mkdirSync(this.sessionsDir, { recursive: true });

    // Ensure MEMORY.md exists
    const memFile = join(this.memoryDir, "MEMORY.md");
    if (!existsSync(memFile)) {
      writeFileSync(memFile, "# Long-term Memory\n\n");
    }

    logger.info("Memory", `Memory: ${this.memoryDir}, Sessions: ${this.sessionsDir}`);
  }

  /**
   * Called after every completed session.
   * Logs the session, writes daily notes, triggers QMD reindex.
   */
  async flush(channel: ChannelState, prompt: string, response: string, sessionId: string, durationMs: number, costUsd: number) {
    try {
      // 1. Log raw session as JSONL (searchable by QMD)
      this.logSession(channel, prompt, response, sessionId, durationMs, costUsd);

      // 2. Write daily note (also searchable by QMD)
      this.writeDailyNote(channel, prompt, response);

      // 3. Trigger QMD incremental reindex (non-blocking)
      this.reindexQmd().catch(err =>
        logger.warn("Memory", `QMD reindex failed (non-critical)`, err)
      );

      logger.info("Memory", `[${channel.name}] Flushed session ${sessionId.slice(0, 8)}`);
    } catch (err) {
      logger.error("Memory", `[${channel.name}] Flush failed`, err);
    }
  }

  /** Append session log as JSONL — this is the main searchable data */
  private logSession(channel: ChannelState, prompt: string, response: string, sessionId: string, durationMs: number, costUsd: number) {
    const entry = {
      ts: new Date().toISOString(),
      channel: channel.name,
      topicId: channel.topicId,
      sessionId,
      durationMs,
      costUsd,
      prompt,
      response,
    };
    const logFile = join(this.sessionsDir, `${today()}.jsonl`);
    appendFileSync(logFile, JSON.stringify(entry) + "\n");
  }

  /** Write a brief summary to today's daily note */
  private writeDailyNote(channel: ChannelState, prompt: string, response: string) {
    const dailyFile = join(this.memoryDir, `${today()}.md`);
    if (!existsSync(dailyFile)) {
      writeFileSync(dailyFile, `# Daily Notes — ${today()}\n\n`);
    }
    const snippet = response.length > 200 ? response.slice(0, 200) + "..." : response;
    const note = `### ${channel.name} — ${timeNow()}\n**Q:** ${prompt.slice(0, 150)}\n**A:** ${snippet}\n\n`;
    appendFileSync(dailyFile, note);
  }

  /** Trigger QMD incremental reindex of memory and sessions */
  private async reindexQmd(): Promise<void> {
    return new Promise((resolve) => {
      // Index both memory dir and sessions dir
      const proc = spawn("qmd", [
        "index",
        "--collection", "harness",
        this.memoryDir,
        this.sessionsDir,
      ], { stdio: "ignore" });

      proc.on("close", () => resolve());
      proc.on("error", () => resolve()); // QMD might not be installed yet

      // Timeout
      setTimeout(() => { proc.kill(); resolve(); }, 15000);
    });
  }

  /** Save a fact directly to MEMORY.md */
  saveFact(fact: string, source?: string) {
    const memFile = join(this.memoryDir, "MEMORY.md");
    const entry = `- ${fact}${source ? ` [${source}]` : ""} (${today()})\n`;
    appendFileSync(memFile, entry);
    logger.info("Memory", `Saved: ${fact.slice(0, 80)}`);
  }
}
