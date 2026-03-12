# OpenClaw Plugin: retry-on-error

## Problem

When the inference provider (CheapestInference via LiteLLM) returns 429 rate limit errors due to budget exhaustion (5-hour fixed window), all running agent tasks and conversations stop. When the budget resets, nothing resumes automatically. Users must manually re-trigger each conversation, and if the dashboard is closed, there is no way to resume at all.

## Solution

An OpenClaw plugin (`retry-on-error`) that:

1. Detects retriable provider errors via the `agent_end` hook
2. Parks failed sessions in a persistent queue on disk
3. Runs a background service that retries parked sessions when the budget window resets
4. Uses OpenClaw's internal `GatewayClient` to send `chat.send` to the local gateway, resuming conversations with their full transcript context

## Architecture

### Plugin Structure

```
~/.openclaw/extensions/retry-on-error/
├── openclaw.plugin.json    # Plugin manifest
├── package.json            # NPM metadata
├── index.ts                # Entry point: registers hook + service
└── src/
    └── service.ts          # Background retry service
```

### Components

#### 1. Error Detection (hook: `agent_end`)

The `agent_end` hook receives `{ messages, success, error, durationMs }` with `PluginHookAgentContext` which includes `sessionKey`.

The `error` field is a **plain string** (not an HTTP status code). Error strings from the CheapestInference/LiteLLM stack arrive in formats like `"Error code: 429 - ..."` or `"RateLimitError: ..."`.

**Retriable error patterns** (string matching, case-insensitive):
- `"429"` (catches `"Error code: 429"`)
- `"rate limit"` / `"rate_limit"` / `"too many requests"`
- `"budget"` / `"quota exceeded"`
- `"resource_exhausted"` / `"resource has been exhausted"`

**Non-retriable errors** (ignored):
- Auth errors ("invalid api key", "unauthorized", "401", "403")
- Format errors ("invalid request", "malformed")
- Model not found ("404", "model not found")
- Context overflow ("context length", "prompt too large")
- Billing errors ("402", "insufficient credits") — require user action

#### 2. Persistent Queue

Path: `path.join(ctx.stateDir, 'retry-on-error', 'queue.json')` (resolves to `~/.openclaw/retry-on-error/queue.json`).

```json
[
  {
    "sessionKey": "agent:myagent:main",
    "errorTime": 1710000000000,
    "retryAfter": 1710018000000,
    "errorMessage": "Error code: 429 - rate limit exceeded",
    "attempts": 0
  }
]
```

**Deduplication**: Only one entry per `sessionKey`. If the same session errors again, the existing entry is updated with incremented `attempts` and recalculated `retryAfter`.

**Retry time calculation**: Computes the next 5-hour budget window boundary aligned to midnight (00:00, 05:00, 10:00, 15:00, 20:00 UTC) plus 1 minute margin. LiteLLM uses UTC-aligned boundaries per its `get_next_standardized_reset_time()` implementation.

```
function nextResetTime(now, windowHours):
  currentHour = now.getUTCHours()
  nextBoundary = currentHour + windowHours - (currentHour % windowHours)
  if currentHour % windowHours == 0 and minutes == 0:
    nextBoundary = currentHour + windowHours
  // Handle day overflow (nextBoundary >= 24)
  return date at nextBoundary:01:00 UTC
```

**Atomic writes**: Write to a temp file, then rename (atomic rename) to prevent corruption on crashes.

**Max queue size**: Capped at 100 entries. Oldest entries evicted when full.

#### 3. Background Service (`registerService`)

**`start(ctx)`**:
1. Read gateway port: `ctx.config.gateway?.port ?? 18789`
2. Capture actual port via `gateway_start` hook if available
3. Load `queue.json` from `ctx.stateDir` (recovers state after restarts)
4. Start interval timer (every `checkIntervalMinutes`, default 5 minutes)
5. On each tick (guarded by `retryInProgress` flag to prevent overlapping batches):
   - Filter queue items where `retryAfter < Date.now()`
   - If items ready: connect `GatewayClient` to local gateway
   - Send `chat.send` for each ready session (fire-and-forget, see Response Model)
   - On ack success: remove from queue, log
   - On connection/send error: leave in queue, retry on next tick
   - Save updated `queue.json` to disk (atomic write)

**`stop(ctx)`**:
1. Clear interval timer
2. Disconnect `GatewayClient` if connected
3. Save queue to disk

#### 4. Gateway Client (authentication)

Uses OpenClaw's internal `GatewayClient` class instead of a custom WebSocket implementation. This handles:
- `connect.challenge` handshake
- Device identity authentication (`loadOrCreateDeviceIdentity`, `buildDeviceAuthPayloadV3`)
- Reconnection with exponential backoff
- Protocol negotiation

The `GatewayClient` is imported from `openclaw` internals (resolved via Jiti at runtime). Connection is ephemeral: opens when retries are pending, closes after processing.

Auth token can alternatively be read from `ctx.config.gateway?.auth?.token` if device identity is not available.

#### 5. Response Model (fire-and-forget with re-detection)

`chat.send` returns an immediate ack `{ ok: true, runId, status: "started" }`, NOT the final result. The plugin does NOT wait for the agent run to complete.

**If the retry succeeds**: The agent processes the message normally. No further action needed.

**If the retry fails again with 429**: The `agent_end` hook fires again with the same `sessionKey`. The deduplication logic updates the existing queue entry: increments `attempts`, recalculates `retryAfter` to the next 5h window. This natural loop continues until the retry succeeds or `attempts >= maxRetryAttempts`.

**Idempotency key generation**: Each retry uses `retry:${sessionKey}:${Date.now()}` to prevent replay/deduplication conflicts with previous messages.

### Configuration

Plugin config in OpenClaw settings:

```yaml
plugins:
  retry-on-error:
    budgetWindowHours: 5          # Budget reset window (hours)
    maxRetryAttempts: 3           # Max retries per session before abandoning
    checkIntervalMinutes: 5       # How often to check for pending retries
    retryMessage: "Continue where you left off. The previous attempt failed due to a rate limit that has now reset."
```

Config schema (in `openclaw.plugin.json`):

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
        "description": "Budget reset window in hours"
      },
      "maxRetryAttempts": {
        "type": "number",
        "default": 3,
        "description": "Maximum retry attempts per session"
      },
      "checkIntervalMinutes": {
        "type": "number",
        "default": 5,
        "description": "Interval between retry checks in minutes"
      },
      "retryMessage": {
        "type": "string",
        "default": "Continue where you left off. The previous attempt failed due to a rate limit that has now reset.",
        "description": "Message sent to resume the conversation"
      }
    }
  }
}
```

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| Server restarts | `start()` reloads `queue.json` from disk |
| Multiple errors same session | Deduplicate by `sessionKey` (update existing entry) |
| Retry also fails with 429 | `agent_end` hook fires again → re-queues with incremented attempts |
| Gateway unreachable during retry | Catch connection error, leave in queue for next tick |
| `attempts >= maxRetryAttempts` | Remove from queue, log warning |
| 24 not divisible by windowHours | Handle day overflow (hour >= 24 wraps to next day) |
| Sub-agent session error | Same treatment — sessionKey format `agent:X:subagent:Y` handled identically |
| Timer fires during active retry | `retryInProgress` guard prevents overlapping batches |
| Queue file corrupted | Catch JSON parse error, start with empty queue, log warning |
| Queue exceeds 100 entries | Evict oldest entries |

### Why `chat.send` (not `/hooks` endpoint)

The `/hooks` endpoint creates "isolated agent turns" (cron-like). Using `chat.send` with the original `sessionKey` is equivalent to a user sending a message manually — the gateway loads the complete JSONL transcript and the agent resumes with full context. This is the correct behavior for conversation resumption.

### Dependencies

Runtime: None (zero runtime dependencies).

Dev/type-only:
- `openclaw` — devDependency for types, resolved at runtime via Jiti alias
- `GatewayClient` — imported from `openclaw` internals at runtime

### Installation

```bash
# Copy to global extensions directory
cp -r retry-on-error ~/.openclaw/extensions/

# Enable in OpenClaw config
openclaw config set plugins.retry-on-error.budgetWindowHours 5
openclaw config set plugins.retry-on-error.maxRetryAttempts 3
```

No `npm install` needed (zero runtime dependencies).
