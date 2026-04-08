import { loadConfig } from "./config";
import { Router } from "./router";
import { SessionManager } from "./session-manager";
import { MemoryManager } from "./memory-manager";
import { InstructionAssembler } from "./instruction-assembler";
import { CronEngine } from "./cron-engine";
import { Gateway } from "./gateway";
import { logger } from "./logger";

async function main() {
  logger.info("Main", "=== Claude Harness starting ===");

  // Load config
  const config = await loadConfig();
  logger.info("Main", `Config: group=${config.telegram.group_id}, model=${config.claude.default_model}, concurrent=${config.claude.max_concurrent}`);

  // Initialize components
  const router = new Router(config);
  router.loadPersisted();

  const memoryManager = new MemoryManager(config);
  const instructionAssembler = new InstructionAssembler();
  const sessionManager = new SessionManager(config, instructionAssembler, memoryManager);

  // CronEngine needs a callback to send messages — will be wired via Gateway
  let gateway: Gateway;

  const cronEngine = new CronEngine(
    config,
    router,
    sessionManager,
    async (channel, text) => {
      await gateway.sendToChannel(channel, text);
    },
  );

  gateway = new Gateway(config, router, sessionManager, cronEngine, memoryManager);

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Main", "Shutting down...");
    await gateway.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start (gateway.start does NOT block — bot runs in background via event loop)
  await gateway.start();
  logger.info("Main", `Claude Harness running! ${router.listChannels().length} channels, heartbeat=${config.heartbeat.enabled}`);

  // Keep process alive
  await new Promise(() => {});
}

main().catch((err) => {
  logger.error("Main", "Fatal error", err);
  process.exit(1);
});
