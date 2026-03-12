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

const { service, addEntry, removeEntry } = createRetryService();

const plugin = {
  id: "ratelimit-retry",
  name: "Ratelimit Retry",
  description: "Automatically retry agent conversations that fail due to provider rate limits",

  register(api: OpenClawPluginApi) {
    const cfg = {
      ...DEFAULT_CONFIG,
      ...(api.pluginConfig as PluginConfig),
    };

    api.on("agent_end", (event, ctx) => {
      const error = (event as Record<string, unknown>).error as string | undefined;
      const success = (event as Record<string, unknown>).success as boolean | undefined;
      const sessionKey = (ctx as Record<string, unknown>).sessionKey as string | undefined;
      if (!sessionKey) return;

      // On success, remove from retry queue (if present)
      if (success || !error) {
        removeEntry(sessionKey);
        return;
      }

      // Ignore non-retriable errors
      if (!isRetriableError(error)) {
        api.logger.debug?.(`ratelimit-retry: non-retriable error on ${sessionKey}: ${error.slice(0, 100)}`);
        return;
      }

      api.logger.info(`ratelimit-retry: queuing retry for ${sessionKey} (error: ${error.slice(0, 100)})`);

      const resolvedConfig = {
        ...cfg,
        gatewayPort: (api.config as Record<string, any>).gateway?.port ?? 18789,
        gatewayToken: (api.config as Record<string, any>).gateway?.auth?.token,
        gatewayPassword: (api.config as Record<string, any>).gateway?.auth?.password,
      };

      addEntry(sessionKey, error, resolvedConfig, api.logger as any);
    });

    api.registerService(service);

    api.logger.info("ratelimit-retry: plugin registered");
  },
};

export default plugin;
