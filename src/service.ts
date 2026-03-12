import { writeFile, readFile, mkdir, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { OpenClawPluginService } from "openclaw/plugin-sdk";

// --- Types ---

interface QueueEntry {
  sessionKey: string;
  errorTime: number;
  retryAfter: number;
  errorMessage: string;
  attempts: number;
}

interface RetryConfig {
  budgetWindowHours: number;
  maxRetryAttempts: number;
  checkIntervalMinutes: number;
  retryMessage: string;
  gatewayPort: number;
  gatewayToken: string | undefined;
  gatewayPassword: string | undefined;
}

// --- Error Detection ---

const RETRIABLE_PATTERNS = [
  /\b429\b/i,
  /rate[_ ]?limit/i,
  /too many requests/i,
  /budget/i,
  /quota[_ ]?exceeded/i,
  /resource[_ ]?(exhausted|has been exhausted)/i,
  /tokens? per minute/i,
  /\btpm\b/i,
];

const NON_RETRIABLE_PATTERNS = [
  /\b40[1-4]\b/i,
  /invalid api key/i,
  /unauthorized/i,
  /invalid request/i,
  /context[_ ]?(length|overflow)/i,
  /prompt too (large|long)/i,
  /model not found/i,
  /insufficient[_ ]?credits/i,
  /malformed/i,
];

export function isRetriableError(error: string | undefined): boolean {
  if (!error) return false;
  for (const pattern of NON_RETRIABLE_PATTERNS) {
    if (pattern.test(error)) return false;
  }
  for (const pattern of RETRIABLE_PATTERNS) {
    if (pattern.test(error)) return true;
  }
  return false;
}

// --- Reset Time Calculation ---

export function nextResetTime(now: Date, windowHours: number): number {
  if (!windowHours || windowHours <= 0) windowHours = 5;

  const currentHour = now.getUTCHours();
  const nextBoundary = currentHour + windowHours - (currentHour % windowHours);

  const result = new Date(now);

  if (nextBoundary >= 24) {
    // Overflows to next day
    result.setUTCDate(result.getUTCDate() + 1);
    result.setUTCHours(Math.floor(nextBoundary - 24), 1, 0, 0); // +1 minute margin
  } else {
    result.setUTCHours(Math.floor(nextBoundary), 1, 0, 0); // +1 minute margin
  }

  return result.getTime();
}

// --- Queue Management ---

const MAX_QUEUE_SIZE = 100;

async function loadQueue(queuePath: string): Promise<QueueEntry[]> {
  try {
    const data = await readFile(queuePath, "utf-8");
    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

async function saveQueue(queuePath: string, queue: QueueEntry[]): Promise<void> {
  await mkdir(dirname(queuePath), { recursive: true });
  const tmpPath = `${queuePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmpPath, JSON.stringify(queue, null, 2), "utf-8");
  await rename(tmpPath, queuePath);
}

function addToQueue(queue: QueueEntry[], entry: QueueEntry): QueueEntry[] {
  const filtered = queue.filter((e) => e.sessionKey !== entry.sessionKey);
  filtered.push(entry);
  if (filtered.length > MAX_QUEUE_SIZE) {
    filtered.sort((a, b) => a.errorTime - b.errorTime);
    return filtered.slice(-MAX_QUEUE_SIZE);
  }
  return filtered;
}

// --- WebSocket Chat Client ---

interface ChatSendResult {
  ok: boolean;
  error?: string;
}

async function sendRetryMessage(
  port: number,
  token: string | undefined,
  password: string | undefined,
  sessionKey: string,
  message: string,
): Promise<ChatSendResult> {
  return new Promise((outerResolve) => {
    let settled = false;
    const resolve = (val: ChatSendResult) => {
      if (settled) return;
      settled = true;
      outerResolve(val);
    };

    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      resolve({ ok: false, error: "Connection timeout" });
    }, 30_000);

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    let requestId = 0;

    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      resolve({ ok: false, error: "WebSocket connection error" });
    });

    ws.addEventListener("close", () => {
      clearTimeout(timeout);
      resolve({ ok: false, error: "Connection closed unexpectedly" });
    });

    ws.addEventListener("message", (event) => {
      try {
        const frame = JSON.parse(String(event.data));

        if (frame.type === "event" && frame.event === "connect.challenge") {
          const connectFrame: Record<string, unknown> = {
            type: "req",
            id: ++requestId,
            method: "connect",
            params: {
              minProtocol: 1,
              maxProtocol: 1,
              client: {
                name: "retry-on-error",
                displayName: "Retry on Error Plugin",
                version: "1.0.0",
                mode: "backend",
              },
              role: "operator",
              scopes: ["operator.admin"],
            },
          };

          if (token) {
            (connectFrame.params as Record<string, unknown>).auth = { token };
          } else if (password) {
            (connectFrame.params as Record<string, unknown>).auth = { password };
          }

          ws.send(JSON.stringify(connectFrame));
          return;
        }

        if (frame.type === "res" && frame.id === 1 && !frame.ok) {
          clearTimeout(timeout);
          resolve({ ok: false, error: frame.error?.message ?? "Gateway authentication failed" });
          ws.close();
          return;
        }

        if (frame.type === "res" && frame.id === 1 && frame.ok) {
          const chatFrame = {
            type: "req",
            id: ++requestId,
            method: "chat.send",
            params: {
              sessionKey,
              message,
              idempotencyKey: `retry:${sessionKey}:${Date.now()}`,
            },
          };
          ws.send(JSON.stringify(chatFrame));
          return;
        }

        if (frame.type === "res" && frame.id === 2) {
          clearTimeout(timeout);
          if (frame.ok) {
            resolve({ ok: true });
          } else {
            resolve({ ok: false, error: frame.error?.message ?? "chat.send failed" });
          }
          ws.close();
          return;
        }
      } catch {
        // Ignore unparseable frames
      }
    });
  });
}

// --- Service ---

interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export function createRetryService(): {
  service: OpenClawPluginService;
  addEntry: (sessionKey: string, errorMessage: string, config: RetryConfig, logger?: Logger) => void;
  removeEntry: (sessionKey: string) => void;
} {
  let queue: QueueEntry[] = [];
  let queuePath = "";
  let timer: ReturnType<typeof setInterval> | null = null;
  let retryInProgress = false;
  let config: RetryConfig = {
    budgetWindowHours: 5,
    maxRetryAttempts: 3,
    checkIntervalMinutes: 5,
    retryMessage: "Continue where you left off. The previous attempt failed due to a rate limit that has now reset.",
    gatewayPort: 18789,
    gatewayToken: undefined,
    gatewayPassword: undefined,
  };

  const addEntry = (sessionKey: string, errorMessage: string, cfg: RetryConfig, logger?: Logger) => {
    config = cfg;
    const now = new Date();
    const existing = queue.find((e) => e.sessionKey === sessionKey);
    const attempts = existing ? existing.attempts + 1 : 0;

    if (attempts >= config.maxRetryAttempts) {
      logger?.warn(`retry-on-error: max attempts (${config.maxRetryAttempts}) reached for ${sessionKey}, abandoning`);
      queue = queue.filter((e) => e.sessionKey !== sessionKey);
      if (queuePath) saveQueue(queuePath, queue).catch(() => {});
      return;
    }

    const entry: QueueEntry = {
      sessionKey,
      errorTime: now.getTime(),
      retryAfter: nextResetTime(now, config.budgetWindowHours),
      errorMessage,
      attempts,
    };

    queue = addToQueue(queue, entry);
    if (queuePath) saveQueue(queuePath, queue).catch(() => {});
  };

  const removeEntry = (sessionKey: string) => {
    const existed = queue.some((e) => e.sessionKey === sessionKey);
    if (existed) {
      queue = queue.filter((e) => e.sessionKey !== sessionKey);
      if (queuePath) saveQueue(queuePath, queue).catch(() => {});
    }
  };

  const processTick = async (logger: Logger) => {
    if (retryInProgress || queue.length === 0) return;
    retryInProgress = true;

    try {
      const now = Date.now();
      const ready = queue.filter((e) => e.retryAfter <= now);
      if (ready.length === 0) return;

      logger.info(`retry-on-error: ${ready.length} session(s) ready for retry`);

      for (const entry of ready) {
        logger.info(`retry-on-error: retrying session ${entry.sessionKey} (attempt ${entry.attempts + 1})`);

        const result = await sendRetryMessage(
          config.gatewayPort,
          config.gatewayToken,
          config.gatewayPassword,
          entry.sessionKey,
          config.retryMessage,
        );

        if (result.ok) {
          // Don't remove — keep entry so attempts counter is preserved.
          // Push retryAfter to next window to prevent re-sending on next tick.
          // Entry is removed when agent_end fires with success=true.
          // If the retry fails again, agent_end fires with error and increments attempts.
          entry.retryAfter = nextResetTime(new Date(), config.budgetWindowHours);
          logger.info(`retry-on-error: sent retry to ${entry.sessionKey}`);
        } else {
          // Push retryAfter forward to avoid hammering a down gateway every tick
          entry.retryAfter = nextResetTime(new Date(), config.budgetWindowHours);
          logger.warn(`retry-on-error: failed to send retry to ${entry.sessionKey}: ${result.error}`);
        }
      }

      await saveQueue(queuePath, queue);
    } finally {
      retryInProgress = false;
    }
  };

  const service: OpenClawPluginService = {
    id: "retry-on-error",

    async start(ctx) {
      const stateDir = join(ctx.stateDir, "retry-on-error");
      queuePath = join(stateDir, "queue.json");

      config = {
        ...config,
        gatewayPort: (ctx.config as Record<string, any>).gateway?.port ?? 18789,
        gatewayToken: (ctx.config as Record<string, any>).gateway?.auth?.token,
        gatewayPassword: (ctx.config as Record<string, any>).gateway?.auth?.password,
      };

      const loaded = await loadQueue(queuePath);

      // Merge: disk entries + any in-memory entries added between register() and start()
      if (loaded.length > 0) {
        const loadedKeys = new Set(loaded.map((e) => e.sessionKey));
        const preStartEntries = queue.filter((e) => !loadedKeys.has(e.sessionKey));
        queue = [...loaded, ...preStartEntries];
        ctx.logger.info(`retry-on-error: loaded ${loaded.length} pending retry(s) from disk`);
      }

      const intervalMs = config.checkIntervalMinutes * 60 * 1000;
      timer = setInterval(() => {
        processTick(ctx.logger).catch((err) => {
          ctx.logger.error(`retry-on-error: tick failed: ${err}`);
        });
      }, intervalMs);

      ctx.logger.info(
        `retry-on-error: service started (window=${config.budgetWindowHours}h, check=${config.checkIntervalMinutes}min, maxAttempts=${config.maxRetryAttempts})`,
      );
    },

    async stop(ctx) {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (queuePath && queue.length > 0) {
        await saveQueue(queuePath, queue);
      }
      ctx.logger.info("retry-on-error: service stopped");
    },
  };

  return { service, addEntry, removeEntry };
}
