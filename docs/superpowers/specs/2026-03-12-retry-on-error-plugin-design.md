# OpenClaw Plugin: retry-on-error

## Problem

When the inference provider (CheapestInference via LiteLLM) returns 429 rate limit errors due to budget exhaustion (5-hour rolling window), all running agent tasks and conversations stop. When the budget resets, nothing resumes automatically. Users must manually re-trigger each conversation, and if the dashboard is closed, there is no way to resume at all.

## Solution

An OpenClaw plugin (`retry-on-error`) that:

1. Detects retriable provider errors via the `agent_end` hook
2. Parks failed sessions in a persistent queue on disk
3. Runs a background service that retries parked sessions when the budget window resets
4. Uses WebSocket `chat.send` to the local gateway to resume conversations with their full transcript context

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

The `agent_end` hook receives `{ messages, success, error, durationMs }`.

**Retriable errors** (added to queue):
- HTTP 429
- "rate limit" / "rate_limit"
- "budget" / "quota exceeded" / "too many requests"
- "resource_exhausted" / "resource has been exhausted"

**Non-retriable errors** (ignored):
- Auth errors (401, 403, "invalid api key", "unauthorized")
- Format errors ("invalid request", "malformed")
- Model not found (404)
- Context overflow ("context length", "prompt too large")
- Billing errors (402, "insufficient credits") — these require user action

#### 2. Persistent Queue (`~/.openclaw/retry-on-error/queue.json`)

```json
[
  {
    "sessionKey": "agent:myagent:main",
    "errorTime": 1710000000000,
    "retryAfter": 1710018000000,
    "errorMessage": "API rate limit reached",
    "retryMessage": "Continue where you left off. The previous attempt failed due to a rate limit that has now reset.",
    "attempts": 0,
    "maxAttempts": 3
  }
]
```

**Deduplication**: Only one entry per `sessionKey`. If the same session errors again, the existing entry is updated (not duplicated).

**Retry time calculation**: Computes the next 5-hour budget window boundary aligned to midnight (00:00, 05:00, 10:00, 15:00, 20:00) plus 1 minute margin.

```
function nextResetTime(now, windowHours):
  currentHour = now.getUTCHours()
  nextBoundary = currentHour + windowHours - (currentHour % windowHours)
  if currentHour % windowHours == 0 and minutes == 0:
    nextBoundary = currentHour + windowHours
  // Handle day overflow (nextBoundary >= 24)
  return date at nextBoundary:01:00 UTC
```

#### 3. Background Service (`registerService`)

**`start()`**:
1. Load `queue.json` from disk (recovers state after restarts)
2. Start interval timer (every `checkIntervalMinutes`, default 5 minutes)
3. On each tick:
   - Filter queue items where `retryAfter < Date.now()`
   - If items ready: open ephemeral WebSocket to `ws://127.0.0.1:{gatewayPort}`
   - Send `chat.send` RPC for each ready session
   - On success: remove from queue, log
   - On 429 again: increment `attempts`, recalculate `retryAfter` to next window
   - On `attempts >= maxAttempts`: remove from queue, log as abandoned
   - Save updated `queue.json` to disk

**`stop()`**:
1. Clear interval timer
2. Close WebSocket connection if open
3. Save queue to disk

#### 4. Minimal WebSocket Client

Ephemeral connection — only opens when there are retries to process:

1. `new WebSocket("ws://127.0.0.1:{gatewayPort}")`
2. Wait for `connect.challenge` event
3. Send `connect` frame (localhost, no auth required for local connections)
4. For each retry: send `{ type: "req", method: "chat.send", params: { sessionKey, message, idempotencyKey } }`
5. Wait for `{ type: "res", ok: true }` response
6. Close connection after all retries processed

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
| Server restarts | `start()` reloads `queue.json` — retries survive |
| Multiple errors same session | Deduplicate by `sessionKey` (keep most recent) |
| Retry also fails with 429 | Increment attempts, recalculate to next 5h window |
| Gateway unreachable during retry | Catch WS error, retry on next timer tick |
| `attempts >= maxAttempts` | Remove from queue, log warning |
| 24 not divisible by windowHours | Handle day overflow in nextResetTime (hour >= 24 wraps to next day) |
| Sub-agent session error | Same treatment — sessionKey format `agent:X:subagent:Y` is handled identically |

### Why WebSocket `chat.send` (not `/hooks` endpoint)

The `/hooks` endpoint creates "isolated agent turns" (cron-like). Using `chat.send` with the original `sessionKey` is equivalent to a user sending a message manually — the gateway loads the complete JSONL transcript and the agent resumes with full context. This is the correct behavior for conversation resumption.

### Dependencies

None. The plugin uses only:
- Node.js built-in `WebSocket` (available in Node 22+)
- Node.js `fs/promises` for queue persistence
- `openclaw/plugin-sdk` types (devDependency only, resolved at runtime via Jiti)

### Installation

```bash
# Copy to global extensions directory
cp -r retry-on-error ~/.openclaw/extensions/

# Enable in OpenClaw config
openclaw config set plugins.retry-on-error.budgetWindowHours 5
openclaw config set plugins.retry-on-error.maxRetryAttempts 3
```

No `npm install` needed (zero runtime dependencies).
