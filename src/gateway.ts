import { Bot, Context } from "grammy";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import type { Config } from "./config";
import { Router } from "./router";
import { SessionManager } from "./session-manager";
import { CronEngine } from "./cron-engine";
import { MemoryManager } from "./memory-manager";
import type { ChannelState } from "./types";
import { logger } from "./logger";

export class Gateway {
  private bot: Bot;
  private router: Router;
  private sessionManager: SessionManager;
  private cronEngine: CronEngine;
  private memoryManager: MemoryManager;
  private config: Config;
  private outgoingPollInterval?: ReturnType<typeof setInterval>;

  constructor(
    config: Config,
    router: Router,
    sessionManager: SessionManager,
    cronEngine: CronEngine,
    memoryManager: MemoryManager,
  ) {
    this.config = config;
    this.router = router;
    this.sessionManager = sessionManager;
    this.cronEngine = cronEngine;
    this.memoryManager = memoryManager;
    this.bot = new Bot(config.telegram.bot_token);

    // Debug: log ALL incoming updates (must be before handlers)
    this.bot.use(async (ctx, next) => {
      const hasMsg = !!ctx.message;
      logger.debug("Gateway", `Update: hasMsg=${hasMsg}, chat=${ctx.chat?.id}, thread=${ctx.message?.message_thread_id ?? "none"}, text="${ctx.message?.text?.slice(0, 50) ?? ""}"`);
      await next();
    });

    this.setupHandlers();
  }

  /** Send a message to a channel's topic (used by CronEngine) */
  async sendToChannel(channel: ChannelState, text: string) {
    const chunks = splitMessage(text, 4000);
    for (const chunk of chunks) {
      await this.bot.api.sendMessage(this.config.telegram.group_id, chunk, {
        message_thread_id: channel.topicId || undefined,
        parse_mode: "Markdown",
      }).catch(async () => {
        await this.bot.api.sendMessage(this.config.telegram.group_id, chunk, {
          message_thread_id: channel.topicId || undefined,
        });
      });
    }
  }

  private setupHandlers() {
    // === Auto-discovery: when a new topic is created ===
    this.bot.on("message:forum_topic_created", async (ctx) => {
      const topicId = ctx.message.message_thread_id!;
      const topicName = ctx.message.forum_topic_created!.name;
      const channel = this.router.discover(topicId, topicName);
      logger.info("Gateway", `Auto-discovered topic: "${topicName}" -> ${channel.name} (${topicId})`);
      await ctx.reply(
        `Channel "${channel.name}" registered.\nDir: ${channel.workDir}\nModel: ${channel.model}`,
        { message_thread_id: topicId },
      );
    });

    // === Admin commands ===
    this.bot.command("status", async (ctx) => {
      if (!this.isAllowed(ctx)) return;
      const status = this.sessionManager.getStatus();
      const channels = this.router.listChannels();
      const cronJobs = this.cronEngine.listJobs();
      const lines = [
        `Active: ${status.active}/${status.max} | Queued: ${status.queued}`,
        `Channels: ${channels.length} | Cron: ${cronJobs.length}`,
        ``,
        ...channels.map(ch =>
          `${ch.busy ? "🔄" : "✅"} ${ch.name} (t:${ch.topicId})${ch.sessionId ? ` [${ch.sessionId.slice(0, 8)}]` : ""}`
        ),
      ];
      await ctx.reply(lines.join("\n"), { message_thread_id: ctx.message?.message_thread_id });
    });

    this.bot.command("channels", async (ctx) => {
      if (!this.isAllowed(ctx)) return;
      const channels = this.router.listChannels();
      const lines = channels.map(ch =>
        `${ch.name}: topic=${ch.topicId} model=${ch.model}`
      );
      await ctx.reply(lines.join("\n") || "No channels", {
        message_thread_id: ctx.message?.message_thread_id,
      });
    });

    this.bot.command("memory", async (ctx) => {
      if (!this.isAllowed(ctx)) return;
      try {
        const { readFileSync } = await import("fs");
        const { resolve } = await import("path");
        const memFile = resolve("workspace/memory/MEMORY.md");
        const memory = readFileSync(memFile, "utf-8");
        const preview = memory.length > 3000 ? memory.slice(-3000) + "\n..." : memory;
        await ctx.reply(preview || "Memory is empty.", {
          message_thread_id: ctx.message?.message_thread_id,
        });
      } catch {
        await ctx.reply("Memory is empty.", { message_thread_id: ctx.message?.message_thread_id });
      }
    });

    this.bot.command("cron", async (ctx) => {
      if (!this.isAllowed(ctx)) return;
      const jobs = this.cronEngine.listJobs();
      if (jobs.length === 0) {
        await ctx.reply("No cron jobs.", { message_thread_id: ctx.message?.message_thread_id });
        return;
      }
      const lines = jobs.map(j =>
        `${j.enabled ? "✅" : "⏸"} ${j.name} [${j.cron}] -> ${j.channel || "all"}`
      );
      await ctx.reply(lines.join("\n"), { message_thread_id: ctx.message?.message_thread_id });
    });

    this.bot.command("ask", async (ctx) => {
      if (!this.isAllowed(ctx)) return;
      const topicId = ctx.message?.message_thread_id ?? 0;
      const text = ctx.match;
      if (!text) {
        await ctx.reply("Usage: /ask <question>", { message_thread_id: topicId || undefined });
        return;
      }
      const channel = this.resolveOrDiscover(topicId);
      if (!channel) {
        await ctx.reply("Use inside a topic.", { message_thread_id: topicId || undefined });
        return;
      }
      await this.handlePrompt(ctx, channel, topicId, text);
    });

    this.bot.command("discover", async (ctx) => {
      if (!this.isAllowed(ctx)) return;
      const topicId = ctx.message?.message_thread_id;
      if (!topicId) {
        await ctx.reply("Use inside a topic.");
        return;
      }
      const name = ctx.match || `topic-${topicId}`;
      const channel = this.router.discover(topicId, name);
      await ctx.reply(
        `Registered "${channel.name}"\nDir: ${channel.workDir}\nModel: ${channel.model}`,
        { message_thread_id: topicId },
      );
    });

    // === Main message handler ===
    this.bot.on("message:text", async (ctx) => {
      if (!this.isAllowed(ctx)) return;
      const text = ctx.message.text;
      if (!text || text.startsWith("/")) return;

      const topicId = ctx.message.message_thread_id ?? 0;
      const channel = this.resolveOrDiscover(topicId);
      if (!channel) return;

      await this.handlePrompt(ctx, channel, topicId, text);
    });

    this.bot.catch((err) => {
      logger.error("Gateway", `Bot error`, err);
    });
  }

  /** Core prompt handler with typing indicator */
  private async handlePrompt(ctx: Context, channel: ChannelState, topicId: number, text: string) {
    logger.info("Gateway", `[${channel.name}] ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}`);

    // Start typing immediately and keep it alive
    const sendTyping = () => {
      ctx.replyWithChatAction("typing").catch(() => {});
    };
    sendTyping();
    const typingInterval = setInterval(sendTyping, 4000);

    try {
      const response = await this.sessionManager.send(channel, text);
      clearInterval(typingInterval);

      const chunks = splitMessage(response, 4000);
      for (const chunk of chunks) {
        await ctx.reply(chunk, {
          message_thread_id: topicId || undefined,
          parse_mode: "Markdown",
        }).catch(async () => {
          await ctx.reply(chunk, { message_thread_id: topicId || undefined });
        });
      }
    } catch (error) {
      clearInterval(typingInterval);
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error("Gateway", `[${channel.name}] Error`, error);
      await ctx.reply(`Error: ${errMsg.slice(0, 500)}`, {
        message_thread_id: topicId || undefined,
      });
    }
  }

  private resolveOrDiscover(topicId: number): ChannelState | null {
    let channel = this.router.resolve(topicId);
    if (!channel && topicId !== 0) {
      channel = this.router.discover(topicId, `topic-${topicId}`);
      logger.info("Gateway", `Auto-registered topic ${topicId} as "${channel.name}"`);
    }
    if (!channel) {
      logger.debug("Gateway", `Ignoring message outside topics`);
      return null;
    }
    return channel;
  }

  private isAllowed(ctx: Context): boolean {
    const userId = ctx.from?.id;
    if (!userId) return false;
    if (this.config.telegram.allowed_users.length === 0) return true;
    return this.config.telegram.allowed_users.includes(userId);
  }

  async start() {
    logger.info("Gateway", "Starting Telegram bot...");
    this.cronEngine.start();
    this.startOutgoingPoll();
    // Delete webhook to ensure clean long-polling (don't drop pending!)
    await this.bot.api.deleteWebhook();
    logger.info("Gateway", "Webhook cleared, starting long-polling...");
    this.bot.start({
      allowed_updates: ["message", "message_reaction", "callback_query"],
      onStart: () => {
        logger.info("Gateway", "Bot is now receiving updates!");
      },
    });
  }

  /** Poll outgoing-messages.jsonl written by MCP channel_send tool */
  private startOutgoingPoll() {
    const queueFile = resolve("workspace/data/outgoing-messages.jsonl");
    this.outgoingPollInterval = setInterval(async () => {
      try {
        if (!existsSync(queueFile)) return;
        const raw = readFileSync(queueFile, "utf-8").trim();
        if (!raw) return;

        // Atomically clear the file before processing
        writeFileSync(queueFile, "");

        const lines = raw.split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as { channel: string; message: string; ts: number };
            const channel = this.router.resolveByName(msg.channel);
            if (!channel) {
              logger.warn("Gateway", `Outgoing: channel "${msg.channel}" not found, dropping message`);
              continue;
            }
            await this.sendToChannel(channel, msg.message);
            logger.info("Gateway", `Outgoing: sent to "${msg.channel}": ${msg.message.slice(0, 80)}`);
          } catch (parseErr) {
            logger.warn("Gateway", `Outgoing: bad line: ${line.slice(0, 100)}`);
          }
        }
      } catch (err) {
        logger.error("Gateway", `Outgoing poll error`, err);
      }
    }, 2000); // poll every 2 seconds
  }

  async stop() {
    if (this.outgoingPollInterval) clearInterval(this.outgoingPollInterval);
    this.cronEngine.stop();
    await this.bot.stop();
    logger.info("Gateway", "Stopped");
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= maxLen) { chunks.push(rest); break; }
    let idx = rest.lastIndexOf("\n", maxLen);
    if (idx === -1 || idx < maxLen * 0.3) idx = maxLen;
    chunks.push(rest.slice(0, idx));
    rest = rest.slice(idx).trimStart();
  }
  return chunks;
}
