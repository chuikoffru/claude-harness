import { Cron } from "croner";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve as pathResolve } from "path";
import type { Config } from "./config";
import type { ChannelState } from "./types";
import { Router } from "./router";
import { SessionManager } from "./session-manager";
import { logger } from "./logger";

export interface CronJob {
  name: string;
  cron: string;
  channel: string;
  prompt: string;
  enabled: boolean;
}

const CRON_FILE = pathResolve("workspace/data/cron-jobs.json");

export class CronEngine {
  private jobs: CronJob[] = [];
  private runners: Map<string, Cron> = new Map();
  private config: Config;
  private router: Router;
  private sessionManager: SessionManager;
  private sendToTelegram: (channel: ChannelState, text: string) => Promise<void>;

  constructor(
    config: Config,
    router: Router,
    sessionManager: SessionManager,
    sendToTelegram: (channel: ChannelState, text: string) => Promise<void>,
  ) {
    this.config = config;
    this.router = router;
    this.sessionManager = sessionManager;
    this.sendToTelegram = sendToTelegram;
  }

  /** Load cron jobs from file and start them */
  start() {
    mkdirSync(pathResolve("workspace/data"), { recursive: true });
    this.loadJobs();

    // Start heartbeat if enabled
    if (this.config.heartbeat.enabled) {
      const heartbeatCron = `*/${this.config.heartbeat.interval_minutes} * * * *`;
      this.addJob({
        name: "_heartbeat",
        cron: heartbeatCron,
        channel: "", // runs for all channels
        prompt: this.config.heartbeat.prompt,
        enabled: true,
      }, false); // don't persist system jobs
      logger.info("Cron", `Heartbeat scheduled every ${this.config.heartbeat.interval_minutes} min`);
    }

    // Start all loaded jobs
    for (const job of this.jobs) {
      if (job.enabled) this.schedule(job);
    }

    logger.info("Cron", `${this.jobs.length} jobs loaded, ${this.runners.size} running`);
  }

  /** Add a new cron job */
  addJob(job: CronJob, persist = true) {
    // Remove existing job with same name
    this.removeJob(job.name, false);

    this.jobs.push(job);
    if (job.enabled) this.schedule(job);
    if (persist) this.saveJobs();

    logger.info("Cron", `Added job "${job.name}" [${job.cron}] -> ${job.channel || "all"}`);
  }

  /** Remove a cron job */
  removeJob(name: string, persist = true) {
    const runner = this.runners.get(name);
    if (runner) {
      runner.stop();
      this.runners.delete(name);
    }
    this.jobs = this.jobs.filter(j => j.name !== name);
    if (persist) this.saveJobs();
  }

  /** List all jobs */
  listJobs(): CronJob[] {
    return [...this.jobs];
  }

  /** Schedule a single job */
  private schedule(job: CronJob) {
    const runner = new Cron(job.cron, async () => {
      logger.info("Cron", `Firing job "${job.name}"`);
      try {
        if (job.channel) {
          // Run for specific channel
          const channel = this.router.resolveByName(job.channel);
          if (!channel) {
            logger.warn("Cron", `Channel "${job.channel}" not found for job "${job.name}"`);
            return;
          }
          const response = await this.sessionManager.send(channel, job.prompt);
          await this.sendToTelegram(channel, response);
        } else {
          // Heartbeat: run once with general context
          const channels = this.router.listChannels();
          if (channels.length > 0) {
            const channel = channels[0]; // use first channel for heartbeat
            const response = await this.sessionManager.send(channel, job.prompt);
            await this.sendToTelegram(channel, response);
          }
        }
      } catch (err) {
        logger.error("Cron", `Job "${job.name}" failed`, err);
      }
    });

    this.runners.set(job.name, runner);
  }

  private loadJobs() {
    if (!existsSync(CRON_FILE)) return;
    try {
      const raw = readFileSync(CRON_FILE, "utf-8");
      this.jobs = JSON.parse(raw);
    } catch (e) {
      logger.warn("Cron", "Failed to load cron-jobs.json", e);
    }
  }

  private saveJobs() {
    // Don't persist system jobs (starting with _)
    const userJobs = this.jobs.filter(j => !j.name.startsWith("_"));
    writeFileSync(CRON_FILE, JSON.stringify(userJobs, null, 2));
  }

  stop() {
    for (const [name, runner] of this.runners) {
      runner.stop();
    }
    this.runners.clear();
    logger.info("Cron", "All jobs stopped");
  }
}
