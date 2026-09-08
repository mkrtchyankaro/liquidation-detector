import pino, { type Logger } from "pino";

const level = process.env.LOG_LEVEL ?? "info";

const base: pino.LoggerOptions = {
  level,
  base: { app: "liquidation-detector" },
  timestamp: pino.stdTimeFunctions.isoTime,
};

// Sep 3 2026, operator-approved (Karo) -- CONFIRMED PRODUCTION BUG FIX.
// Root cause of the recurring V3_FIRE_ENTRY_CRASH ("Cannot read
// properties of undefined (reading 'Symbol(pino.msgPrefix)')") at the
// five-criteria-filter stage: pino-pretty's own worker-thread-based
// transport is fragile under sustained, high-frequency production
// logging, and it was being loaded whenever NODE_ENV was NOT exactly
// "production" -- which includes empty/undefined, the actual observed
// state in production (confirmed via
// `cat /proc/<pid>/environ | grep NODE_ENV` returning nothing, even
// after prior env-var attempts, since PM2's own crash-triggered
// auto-restart does not inherit a manually-exported shell variable).
//
// FIXED: inverted to an explicit opt-in. Only NODE_ENV === 'development'
// enables pino-pretty. Every other value (production, empty, undefined,
// or any typo/unexpected value) now safely uses plain pino -- no
// worker-thread transport, no crash path.
const isDev = process.env.NODE_ENV === "development";

export const logger: Logger = isDev
  ? pino({
      ...base,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss.l",
          ignore: "pid,hostname,app",
        },
      },
    })
  : pino(base);

/** Create a child logger tagged with a module / symbol context. */
export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
