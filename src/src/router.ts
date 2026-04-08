import type { Config } from "./config";
import type { ChannelState } from "./types";
import { logger } from "./logger";
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "fs";
import { join, resolve as pathResolve } from "path";

/** Sanitize a topic name into a safe directory/channel name */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9а-яё\s-]/gi, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    || "unnamed";
}

export class Router {
  private topicMap = new Map<number, ChannelState>();
  private nameMap = new Map<string, ChannelState>();
  private config: Config;
  private baseWorkDir: string;
  private baseInstructionsDir: string;

  constructor(config: Config) {
    this.config = config;

    // Base dirs for auto-discovered channels
    this.baseWorkDir = pathResolve("workspace/channels");
    this.baseInstructionsDir = pathResolve("workspace/instructions");
    mkdirSync(this.baseWorkDir, { recursive: true });
    mkdirSync(this.baseInstructionsDir, { recursive: true });

    // Load pre-configured channels
    for (const [name, ch] of Object.entries(config.channels)) {
      this.register({
        name,
        topicId: ch.topic_id,
        workDir: ch.work_dir.replace("~", process.env.HOME ?? ""),
        instructions: ch.instructions,
        model: ch.model ?? config.claude.default_model,
        busy: false,
      });
    }
  }

  /** Register a channel (from config or auto-discovery) */
  private register(state: ChannelState) {
    this.topicMap.set(state.topicId, state);
    this.nameMap.set(state.name, state);
    logger.info("Router", `Channel "${state.name}" -> topic ${state.topicId} [${state.model}] dir=${state.workDir}`);
  }

  /** Resolve a topic_id to its channel. Returns undefined if unknown. */
  resolve(topicId: number): ChannelState | undefined {
    return this.topicMap.get(topicId);
  }

  resolveByName(name: string): ChannelState | undefined {
    return this.nameMap.get(name);
  }

  listChannels(): ChannelState[] {
    return Array.from(this.nameMap.values());
  }

  /**
   * Auto-discover a new topic: create workspace dir, instructions file,
   * register the channel, and persist to channels.json for next restart.
   */
  discover(topicId: number, topicName: string): ChannelState {
    // Check if already known
    const existing = this.topicMap.get(topicId);
    if (existing) return existing;

    const slug = slugify(topicName);
    const workDir = join(this.baseWorkDir, slug);
    const instructionsFile = `instructions/${slug}.md`;
    const instructionsPath = join(this.baseInstructionsDir, `${slug}.md`);

    // Create workspace directory
    mkdirSync(workDir, { recursive: true });

    // Create instructions file if it doesn't exist
    if (!existsSync(instructionsPath)) {
      writeFileSync(instructionsPath, [
        `# ${topicName}`,
        ``,
        `<!-- Channel-specific instructions for "${topicName}" -->`,
        `<!-- Edit this file to customize Claude's behavior in this channel -->`,
        ``,
      ].join("\n"));
    }

    const state: ChannelState = {
      name: slug,
      topicId,
      workDir,
      instructions: instructionsFile,
      model: this.config.claude.default_model,
      busy: false,
    };

    this.register(state);
    this.persistDiscovered();

    return state;
  }

  /** Save auto-discovered channels to a JSON file so they survive restarts */
  private persistDiscovered() {
    const discovered: Record<string, { topic_id: number; work_dir: string; instructions: string; model: string }> = {};
    for (const ch of this.nameMap.values()) {
      discovered[ch.name] = {
        topic_id: ch.topicId,
        work_dir: ch.workDir,
        instructions: ch.instructions,
        model: ch.model,
      };
    }
    const path = pathResolve("workspace/data/channels.json");
    mkdirSync(pathResolve("workspace/data"), { recursive: true });
    writeFileSync(path, JSON.stringify(discovered, null, 2));
    logger.debug("Router", `Persisted ${Object.keys(discovered).length} channels to channels.json`);
  }

  /** Load previously discovered channels from channels.json */
  loadPersisted() {
    const path = pathResolve("workspace/data/channels.json");
    if (!existsSync(path)) return;

    try {
      const raw = readFileSync(path, "utf-8");
      const data = JSON.parse(raw) as Record<string, { topic_id: number; work_dir: string; instructions: string; model: string }>;

      for (const [name, ch] of Object.entries(data)) {
        if (this.topicMap.has(ch.topic_id)) continue; // config takes priority
        this.register({
          name,
          topicId: ch.topic_id,
          workDir: ch.work_dir,
          instructions: ch.instructions,
          model: ch.model,
          busy: false,
        });
      }
      logger.info("Router", `Loaded ${Object.keys(data).length} persisted channels`);
    } catch (e) {
      logger.warn("Router", `Failed to load channels.json`, e);
    }
  }
}
