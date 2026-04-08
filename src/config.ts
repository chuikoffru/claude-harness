import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { readFileSync } from "fs";
import { config as loadDotenv } from "dotenv";

// Load .env file
loadDotenv();

const ChannelSchema = z.object({
  topic_id: z.number(),
  work_dir: z.string(),
  instructions: z.string(),
  model: z.enum(["opus", "sonnet", "haiku"]).default("sonnet"),
});

const ConfigSchema = z.object({
  telegram: z.object({
    bot_token: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
    group_id: z.coerce.number(),
    allowed_users: z.array(z.number()).default([]),
  }),
  claude: z.object({
    max_concurrent: z.number().default(5),
    default_model: z.enum(["opus", "sonnet", "haiku"]).default("sonnet"),
    allowed_tools: z.array(z.string()).default(["Read", "Edit", "Write", "Bash"]),
  }),
  ollama: z.object({
    host: z.string().default("http://localhost:11434"),
    embed_model: z.string().default("qwen3-embedding"),
  }),
  qmd: z.object({
    mode: z.enum(["stdio", "http"]).default("http"),
    port: z.number().default(3100),
    collections: z.array(z.object({
      name: z.string(),
      path: z.string(),
    })).default([]),
  }),
  memory: z.object({
    auto_flush: z.boolean().default(true),
    daily_consolidation: z.string().default("0 3 * * *"),
  }),
  heartbeat: z.object({
    enabled: z.boolean().default(true),
    interval_minutes: z.number().default(30),
    prompt: z.string().default("Check notifications and tasks."),
  }),
  channels: z.record(z.string(), ChannelSchema).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ChannelConfig = z.infer<typeof ChannelSchema>;

function replaceEnvVars(str: string): string {
  return str.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] ?? "");
}

export async function loadConfig(path = "config.yaml"): Promise<Config> {
  const raw = readFileSync(path, "utf-8");
  const replaced = replaceEnvVars(raw);
  const parsed = parseYaml(replaced);
  return ConfigSchema.parse(parsed);
}
