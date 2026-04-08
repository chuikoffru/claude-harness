type Level = "debug" | "info" | "warn" | "error";

const COLORS: Record<Level, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";

function log(level: Level, component: string, message: string, data?: unknown) {
  const ts = new Date().toISOString().slice(11, 23);
  const prefix = `${COLORS[level]}${ts} [${level.toUpperCase().padEnd(5)}]${RESET} [${component}]`;
  if (data) {
    console.log(`${prefix} ${message}`, data);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

export const logger = {
  debug: (component: string, msg: string, data?: unknown) => log("debug", component, msg, data),
  info: (component: string, msg: string, data?: unknown) => log("info", component, msg, data),
  warn: (component: string, msg: string, data?: unknown) => log("warn", component, msg, data),
  error: (component: string, msg: string, data?: unknown) => log("error", component, msg, data),
};
