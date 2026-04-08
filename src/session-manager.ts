import type { ChannelState, QueueItem } from "./types";
import type { Config } from "./config";
import { InstructionAssembler } from "./instruction-assembler";
import { MemoryManager } from "./memory-manager";
import { logger } from "./logger";
import { spawn } from "child_process";
import { resolve as pathResolve } from "path";

export class SessionManager {
  private activeCount = 0;
  private queue: QueueItem[] = [];
  private config: Config;
  private instructions: InstructionAssembler;
  private memory: MemoryManager;

  constructor(config: Config, instructions: InstructionAssembler, memory: MemoryManager) {
    this.config = config;
    this.instructions = instructions;
    this.memory = memory;
  }

  async send(channel: ChannelState, prompt: string): Promise<string> {
    if (this.activeCount >= this.config.claude.max_concurrent) {
      logger.warn("SessionMgr", `At capacity (${this.activeCount}/${this.config.claude.max_concurrent}), enqueueing "${channel.name}"`);
      return new Promise((resolve, reject) => {
        this.queue.push({ channel, prompt, resolve, reject });
      });
    }
    return this.execute(channel, prompt);
  }

  private async execute(channel: ChannelState, prompt: string): Promise<string> {
    this.activeCount++;
    channel.busy = true;
    const startTime = Date.now();
    logger.info("SessionMgr", `[${channel.name}] Starting (active: ${this.activeCount}/${this.config.claude.max_concurrent})`);

    try {
      // Build CLAUDE.md with instructions only (no history — that's in QMD)
      this.instructions.build(channel);

      const args = [
        "-p", prompt,
        "--output-format", "json",
        "--allowedTools", this.config.claude.allowed_tools.join(","),
        "--model", channel.model,
        "--mcp-config", pathResolve("mcp-servers.json"),
      ];

      // Resume existing session
      if (channel.sessionId) {
        args.push("--resume", channel.sessionId);
      }

      const result = await this.runClaude(args, channel.workDir);

      // Persist session_id for resume
      channel.sessionId = result.session_id;

      const elapsed = Date.now() - startTime;
      logger.info("SessionMgr", `[${channel.name}] Done in ${elapsed}ms (claude: ${result.duration_ms}ms, cost: $${result.total_cost_usd.toFixed(4)})`);

      // Flush to memory (non-blocking)
      this.memory.flush(channel, prompt, result.result, result.session_id, result.duration_ms, result.total_cost_usd)
        .catch(err => logger.warn("SessionMgr", "Memory flush failed (non-critical)", err));

      return result.result;
    } catch (error) {
      logger.error("SessionMgr", `[${channel.name}] Failed`, error);
      throw error;
    } finally {
      this.activeCount--;
      channel.busy = false;
      this.processQueue();
    }
  }

  private runClaude(args: string[], cwd: string): Promise<{
    result: string;
    session_id: string;
    duration_ms: number;
    total_cost_usd: number;
  }> {
    return new Promise((resolve, reject) => {
      const proc = spawn("claude", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn claude: ${err.message}`));
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`Claude exited with code ${code}: ${stderr.slice(0, 500)}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          resolve({
            result: parsed.result ?? "",
            session_id: parsed.session_id ?? "",
            duration_ms: parsed.duration_ms ?? 0,
            total_cost_usd: parsed.total_cost_usd ?? 0,
          });
        } catch (e) {
          reject(new Error(`Failed to parse Claude output: ${stdout.slice(0, 300)}`));
        }
      });
    });
  }

  private processQueue() {
    if (this.queue.length === 0 || this.activeCount >= this.config.claude.max_concurrent) return;

    const item = this.queue.shift()!;
    logger.info("SessionMgr", `Dequeuing "${item.channel.name}" (queue: ${this.queue.length} remaining)`);

    this.execute(item.channel, item.prompt)
      .then(item.resolve)
      .catch(item.reject);
  }

  getStatus(): { active: number; queued: number; max: number } {
    return {
      active: this.activeCount,
      queued: this.queue.length,
      max: this.config.claude.max_concurrent,
    };
  }
}
