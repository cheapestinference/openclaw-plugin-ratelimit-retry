# retry-on-error Plugin Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an OpenClaw plugin that automatically retries agent conversations that fail due to provider rate limits (429), resuming them when the budget window resets.

**Architecture:** OpenClaw plugin with an `agent_end` hook for error detection, a persistent JSON queue on disk, and a background service that periodically checks for retries and sends `chat.send` via WebSocket to the local gateway. Uses Node.js built-in WebSocket (Node 22+) with token auth.

**Tech Stack:** TypeScript (ESM via Jiti), OpenClaw Plugin SDK, Node.js built-in WebSocket, fs/promises

**Spec:** `docs/superpowers/specs/2026-03-12-retry-on-error-plugin-design.md`

---

## Chunk 1: Project scaffolding and plugin manifest

### Task 1: Create plugin manifest and package.json

**Files:**
- Create: `openclaw.plugin.json`
- Create: `package.json`

- [ ] **Step 1: Create openclaw.plugin.json**

```json
{
  "id": "retry-on-error",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "budgetWindowHours": {
        "type": "number",
        "default": 5,
        "description": "Budget reset window in hours (aligned to UTC clock boundaries)"
      },
      "maxRetryAttempts": {
        "type": "number",
        "default": 3,
        "description": "Maximum retry attempts per session before abandoning"
      },
      "checkIntervalMinutes": {
        "type": "number",
        "default": 5,
        "description": "How often to check for pending retries (minutes)"
      },
      "retryMessage": {
        "type": "string",
        "default": "Continue where you left off. The previous attempt failed due to a rate limit that has now reset.",
        "description": "Message sent to the session to resume the conversation"
      }
    }
  }
}
```

- [ ] **Step 2: Create package.json**

```json
{
  "name": "@openclaw/retry-on-error",
  "version": "1.0.0",
  "description": "Automatically retry agent conversations that fail due to provider rate limits",
  "type": "module",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/cheapestinference/openclaw-plugin-retry-on-error"
  },
  "keywords": ["openclaw", "plugin", "retry", "rate-limit", "429"],
  "openclaw": {
    "extensions": ["./index.ts"]
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add openclaw.plugin.json package.json
git commit -m "feat: add plugin manifest and package.json"
```

---

## Chunk 2: Core implementation

### Task 2: Create the retry service

**Files:**
- Create: `src/service.ts`

This is the main module. Contains:
- Error pattern matching (`isRetriableError`)
- Queue management (`loadQueue`, `saveQueue`)
- Next reset time calculation (`nextResetTime`)
- Minimal WebSocket client for `chat.send` (`sendRetryMessage`)
- Background service lifecycle (`createRetryService`)

- [ ] **Step 1: Create `src/service.ts` with error detection**

```typescript
import { writeFile, readFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
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
  /429/i,
  /rate[_ ]?limit/i,
  /too many requests/i,
  /budget/i,
  /quota[_ ]?exceeded/i,
  /resource[_ ]?(exhausted|has been exhausted)/i,
  /tokens? per minute/i,
  /\btpm\b/i,
];

const NON_RETRIABLE_PATTERNS = [
  /40[1-3]/i,
  /invalid api key/i,
  /unauthorized/i,
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
  const currentHour = now.getUTCHours();
  const currentMinute = now.getUTCMinutes();
  const currentSecond = now.getUTCSeconds();

  let nextBoundary = currentHour + windowHours - (currentHour % windowHours);

  // If exactly on boundary, push to next window
  if (currentHour % windowHours === 0 && currentMinute === 0 && currentSecond === 0) {
    nextBoundary = currentHour + windowHours;
  }

  const result = new Date(now);
  result.setUTCSeconds(0, 0);

  if (nextBoundary >= 24) {
    // Overflows to next day
    result.setUTCDate(result.getUTCDate() + 1);
    result.setUTCHours(nextBoundary - 24, 1, 0, 0); // +1 minute margin
  } else {
    result.setUTCHours(nextBoundary, 1, 0, 0); // +1 minute margin
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
  const dir = queuePath.substring(0, queuePath.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });
  const tmpPath = queuePath + ".tmp";
  await writeFile(tmpPath, JSON.stringify(queue, null, 2), "utf-8");
  await rename(tmpPath, queuePath);
}

function addToQueue(queue: QueueEntry[], entry: QueueEntry): QueueEntry[] {
  // Deduplicate by sessionKey
  const filtered = queue.filter((e) => e.sessionKey !== entry.sessionKey);
  filtered.push(entry);
  // Cap at MAX_QUEUE_SIZE, evict oldest
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
  return new Promise((resolve) => {
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
    });

    ws.addEventListener("message", (event) => {
      try {
        const frame = JSON.parse(String(event.data));

        // Handle connect.challenge → send connect
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

          // Add auth
          if (token) {
            (connectFrame.params as Record<string, unknown>).auth = { token };
          } else if (password) {
            (connectFrame.params as Record<string, unknown>).auth = { password };
          }

          ws.send(JSON.stringify(connectFrame));
          return;
        }

        // Handle connect response (HelloOk) → send chat.send
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

        // Handle chat.send response → done
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

export function createRetryService(
  addEntry: (sessionKey: string, errorMessage: string, config: RetryConfig) => void,
): {
  service: OpenClawPluginService;
  getAddEntry: () => typeof addEntry;
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

  const addEntryImpl = (sessionKey: string, errorMessage: string, cfg: RetryConfig) => {
    config = cfg;
    const now = new Date();
    const existing = queue.find((e) => e.sessionKey === sessionKey);
    const attempts = existing ? existing.attempts + 1 : 0;

    if (attempts >= config.maxRetryAttempts) {
      queue = queue.filter((e) => e.sessionKey !== sessionKey);
      saveQueue(queuePath, queue).catch(() => {});
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
    saveQueue(queuePath, queue).catch(() => {});
  };

  // Replace the external addEntry with the internal one
  addEntry = addEntryImpl;

  const processTick = async (logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }) => {
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
          // Remove from queue — if it fails again, agent_end will re-queue
          queue = queue.filter((e) => e.sessionKey !== entry.sessionKey);
          logger.info(`retry-on-error: sent retry to ${entry.sessionKey}`);
        } else {
          logger.warn(`retry-on-error: failed to send retry to ${entry.sessionKey}: ${result.error}`);
          // Leave in queue for next tick
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

      queue = await loadQueue(queuePath);

      if (queue.length > 0) {
        ctx.logger.info(`retry-on-error: loaded ${queue.length} pending retry(s) from disk`);
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

  return { service, getAddEntry: () => addEntryImpl };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/service.ts
git commit -m "feat: add retry service with error detection, queue, and WS client"
```

### Task 3: Create the plugin entry point

**Files:**
- Create: `index.ts`

- [ ] **Step 1: Create `index.ts`**

```typescript
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createRetryService, isRetriableError } from "./src/service.js";

interface PluginConfig {
  budgetWindowHours?: number;
  maxRetryAttempts?: number;
  checkIntervalMinutes?: number;
  retryMessage?: string;
}

const DEFAULT_CONFIG: Required<PluginConfig> = {
  budgetWindowHours: 5,
  maxRetryAttempts: 3,
  checkIntervalMinutes: 5,
  retryMessage: "Continue where you left off. The previous attempt failed due to a rate limit that has now reset.",
};

// Placeholder that gets replaced when service starts
let addEntry: (sessionKey: string, errorMessage: string, config: any) => void = () => {};

const { service, getAddEntry } = createRetryService(addEntry);

const plugin = {
  id: "retry-on-error",
  name: "Retry on Error",
  description: "Automatically retry agent conversations that fail due to provider rate limits",

  register(api: OpenClawPluginApi) {
    const cfg = {
      ...DEFAULT_CONFIG,
      ...(api.pluginConfig as PluginConfig),
    };

    // Register the agent_end hook
    api.on("agent_end", (event, ctx) => {
      const error = (event as Record<string, unknown>).error as string | undefined;
      const success = (event as Record<string, unknown>).success as boolean | undefined;

      // Only process failures
      if (success || !error) return;

      // Only process retriable errors
      if (!isRetriableError(error)) {
        api.logger.debug?.(`retry-on-error: non-retriable error on ${ctx.sessionKey}: ${error.slice(0, 100)}`);
        return;
      }

      const sessionKey = (ctx as Record<string, unknown>).sessionKey as string | undefined;
      if (!sessionKey) return;

      api.logger.info(`retry-on-error: queuing retry for ${sessionKey} (error: ${error.slice(0, 100)})`);

      const resolvedConfig = {
        ...cfg,
        gatewayPort: (api.config as Record<string, any>).gateway?.port ?? 18789,
        gatewayToken: (api.config as Record<string, any>).gateway?.auth?.token,
        gatewayPassword: (api.config as Record<string, any>).gateway?.auth?.password,
      };

      getAddEntry()(sessionKey, error, resolvedConfig);
    });

    // Register the background service
    api.registerService(service);

    api.logger.info("retry-on-error: plugin registered");
  },
};

export default plugin;
```

- [ ] **Step 2: Commit**

```bash
git add index.ts
git commit -m "feat: add plugin entry point with agent_end hook"
```

---

## Chunk 3: README and repository setup

### Task 4: Create production README

**Files:**
- Create: `README.md`
- Create: `LICENSE`
- Create: `.gitignore`

- [ ] **Step 1: Create README.md**

Full production README with:
- Clear problem statement
- Installation instructions
- Configuration reference
- How it works (architecture diagram)
- Edge cases and limitations
- Contributing section

- [ ] **Step 2: Create LICENSE (MIT)**

- [ ] **Step 3: Create .gitignore**

```
node_modules/
*.tmp
```

- [ ] **Step 4: Commit**

```bash
git add README.md LICENSE .gitignore
git commit -m "docs: add production README, LICENSE, and .gitignore"
```

### Task 5: Create GitHub repository and push

- [ ] **Step 1: Create private repo on GitHub**

```bash
gh repo create cheapestinference/openclaw-plugin-retry-on-error --private --source=. --push
```

- [ ] **Step 2: Verify**

```bash
gh repo view cheapestinference/openclaw-plugin-retry-on-error
```
