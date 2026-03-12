# retry-on-error

An OpenClaw plugin that automatically retries agent conversations killed by provider rate limits.

## Problem

When your LLM provider hits a rate limit or budget cap (HTTP 429), every running agent task dies mid-conversation. Nothing resumes them. If you close the dashboard, those conversations are gone. You have to manually find and re-trigger each one after the budget resets.

## Solution

This plugin hooks into OpenClaw's `agent_end` event, detects retriable errors (429s, rate limits, budget exhaustion), and parks the failed session in a persistent queue on disk. A background service waits for the provider's budget window to reset, then sends `chat.send` to the original session -- resuming the conversation with its full transcript context, as if the user had typed a message.

## How It Works

```
Agent run fails (429)
  |
  v
agent_end hook fires
  |-- Non-retriable error? --> ignore
  |-- Retriable error?     --> queue to disk
                                 |
                                 v
                  Background timer (every 5 min)
                    |
                    |-- Budget window not reset? --> wait
                    |-- Budget window reset?     --> chat.send to session
                                                       |
                                                       |--> Success: remove from queue
                                                       |--> 429 again: agent_end fires
                                                            --> re-queued automatically
```

The retry uses `chat.send` with the original `sessionKey`, which means the gateway loads the complete JSONL transcript and the agent resumes with full context. This is equivalent to the user typing a message in the chat.

The model is **fire-and-forget with re-detection**: `chat.send` returns an immediate ack (`{ ok, runId, status: "started" }`), not the final result. If the retried run fails again with a 429, the `agent_end` hook fires again and the session is re-queued with an incremented attempt counter. This loop continues until the retry succeeds or `maxRetryAttempts` is reached.

## Installation

Copy the plugin to your OpenClaw extensions directory:

```bash
cp -r openclaw-plugin-retry-on-error ~/.openclaw/extensions/retry-on-error
```

Enable it in OpenClaw config:

```bash
openclaw config set plugins.retry-on-error.budgetWindowHours 5
openclaw config set plugins.retry-on-error.maxRetryAttempts 3
```

No `npm install` needed. The plugin has zero runtime dependencies.

### Complete example

```yaml
# ~/.openclaw/config.yaml
plugins:
  retry-on-error:
    budgetWindowHours: 5
    maxRetryAttempts: 3
    checkIntervalMinutes: 5
    retryMessage: "Continue where you left off. The previous attempt failed due to a rate limit that has now reset."
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `budgetWindowHours` | `number` | `5` | Budget reset window in hours, aligned to UTC clock boundaries |
| `maxRetryAttempts` | `number` | `3` | Max retries per session before abandoning |
| `checkIntervalMinutes` | `number` | `5` | How often the background service checks for pending retries |
| `retryMessage` | `string` | `"Continue where you left off..."` | Message sent to the session to resume the conversation |

## How the Retry Timing Works

LiteLLM (used by CheapestInference and other providers) resets budget counters on fixed UTC-aligned windows. With a 5-hour window, the boundaries are:

```
00:00  05:00  10:00  15:00  20:00  (next day) 00:00
  |------|------|------|------|------|
```

When an error is queued, the plugin calculates the next boundary after the current time and adds a **1-minute margin** (retries at `HH:01:00` instead of `HH:00:00`) to avoid racing the provider's reset.

**When 24 is not evenly divisible by `windowHours`**: the math still works. If `windowHours` is 7, boundaries fall at 0, 7, 14, 21, and the next one would be 28 -- which overflows to 04:00 the next day. The plugin handles day overflow correctly.

## Error Classification

Non-retriable patterns are checked first. If an error matches a non-retriable pattern, it is never retried, even if it also matches a retriable pattern.

### Retriable (queued for retry)

| Pattern | Catches |
|---------|---------|
| `429` | `"Error code: 429 - ..."` |
| `rate limit`, `rate_limit` | `"RateLimitError: ..."` |
| `too many requests` | HTTP 429 reason phrases |
| `budget` | `"Budget exceeded for ..."` |
| `quota exceeded` | Provider quota messages |
| `resource exhausted` | gRPC-style exhaustion errors |
| `tokens per minute`, `tpm` | TPM limit messages |

### Non-retriable (ignored)

| Pattern | Reason |
|---------|--------|
| `401`, `403`, `invalid api key`, `unauthorized` | Auth errors -- fix your credentials |
| `invalid request`, `malformed` | Bad request format -- won't succeed on retry |
| `404`, `model not found` | Model doesn't exist |
| `context length`, `prompt too large` | Context overflow -- message is too long |
| `402`, `insufficient credits` | Billing issue -- requires user action |

## Edge Cases

- **Server restarts**: the queue is persisted to `{stateDir}/retry-on-error/queue.json` (typically `~/.openclaw/retry-on-error/queue.json`) and reloaded on startup.
- **Same session errors multiple times**: deduplicated by `sessionKey`. The existing entry is updated with incremented attempts and a recalculated `retryAfter`.
- **Retry fails with 429 again**: `agent_end` fires again, re-queuing with incremented attempts. Natural loop until success or `maxRetryAttempts`.
- **Gateway unreachable during retry**: connection error is caught, entry's `retryAfter` is pushed to the next budget window to avoid hammering a down gateway every tick.
- **Max attempts exceeded**: entry is removed from queue and a warning is logged.
- **Sub-agent sessions**: handled identically -- `sessionKey` format `agent:X:subagent:Y` works the same way.
- **Timer fires during active retry**: a `retryInProgress` guard prevents overlapping batches.
- **Queue file corrupted**: JSON parse errors are caught; service starts with an empty queue and logs a warning.
- **Queue overflow**: capped at 100 entries. Oldest entries are evicted when full.
- **Atomic writes**: queue is written to a `.tmp` file first, then renamed, to prevent corruption on crashes.

## Limitations

- **Fire-and-forget window**: after `chat.send` returns its ack, there is a brief period where the retried run is in progress. If it fails with 429 again immediately, there is a small window before the `agent_end` hook fires and re-queues it. This is by design -- the re-detection loop handles it.
- **`chat.send` requires a non-empty message**: the retry always sends the configured `retryMessage`. It cannot send an empty message to silently resume.
- **No partial-run recovery**: the plugin resumes the conversation from the last completed turn. It does not replay partial streaming output that was interrupted.
- **Single-instance only**: the queue is a local JSON file with no locking. Running multiple OpenClaw instances sharing the same `~/.openclaw/` directory is not supported.
- **No backpressure on the provider**: the plugin retries all ready sessions in sequence. If you have many queued sessions, they all fire at the start of the next window.

## License

[MIT](LICENSE)

## Contributing

Contributions are welcome. Please open an issue first to discuss what you would like to change.

To work on the plugin:

```bash
git clone https://github.com/cheapestinference/openclaw-plugin-retry-on-error
cd openclaw-plugin-retry-on-error
# No build step. OpenClaw loads .ts files directly via Jiti.
```
