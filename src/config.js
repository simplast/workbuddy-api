import "dotenv/config";
import { CodeBuddyProvider } from "./providers/codebuddy.js";
import { NvidiaProvider } from "./providers/nvidia.js";
import { ProviderRegistry } from "./providers/registry.js";

/**
 * Multi-provider configuration.
 *
 * The two base protocols are 'openai' and 'anthropic'. CodeBuddy and NVIDIA
 * are private providers that sit on top of one of these protocols — they
 * only add custom headers, model name aliases, and rate limiting. New
 * private providers should be added as subclasses of OpenAIProvider or
 * AnthropicProvider in src/providers/.
 */
const providers = [];

// ─── codebuddy (default OpenAI protocol provider) ─────────────────────
if (process.env.CODEBUDDY_API_KEY) {
  const aliases = (
    process.env.CODEBUDDY_MODELS ||
    process.env.DEFAULT_MODEL ||
    "default"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const modelMap = Object.fromEntries(
    aliases.map((a) => [a, process.env.CODEBUDDY_TARGET_MODEL || a]),
  );
  providers.push(
    new CodeBuddyProvider({
      name: "codebuddy",
      baseURL: process.env.CODEBUDDY_BASE_URL || "https://www.codebuddy.ai",
      apiKey: process.env.CODEBUDDY_API_KEY,
      models: aliases,
      modelMap,
    }),
  );
}

// ─── nvidia (OpenAI protocol, with rate limiting) ─────────────────────
if (process.env.NVIDIA_API_KEY) {
  const aliases = (process.env.NVIDIA_MODELS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const modelMap = Object.fromEntries(
    aliases.map((a) => [
      a,
      a.includes("/") ? a : process.env.NVIDIA_TARGET_MODEL || "z-ai/glm-5.1",
    ]),
  );
  providers.push(
    new NvidiaProvider({
      name: "nvidia",
      baseURL:
        process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1",
      apiKey: process.env.NVIDIA_API_KEY,
      models: aliases,
      modelMap,
      rpm: parseInt(process.env.NVIDIA_RPM || "40", 10),
      burst: parseInt(process.env.NVIDIA_BURST || "5", 10),
    }),
  );
}

if (providers.length === 0) {
  console.error(
    "\n  ⚠  No provider configured!\n" +
      "  Please set CODEBUDDY_API_KEY or NVIDIA_API_KEY in .env, or pass via environment.\n" +
      "  See .env.example for the full list of supported providers.\n",
  );
  process.exit(1);
}

const defaultProviderName =
  process.env.DEFAULT_PROVIDER ||
  (process.env.CODEBUDDY_API_KEY ? "codebuddy" : providers[0].name);

export const providerRegistry = new ProviderRegistry(
  providers,
  defaultProviderName,
);

export const config = {
  // Local proxy server
  port: parseInt(process.env.PORT || "3456", 10),
  host: process.env.HOST || "127.0.0.1",

  // Backward-compatible fields (used by routes/index before the registry is consulted)
  defaultModel: process.env.DEFAULT_MODEL || "default",
  apiKey: process.env.CODEBUDDY_API_KEY || process.env.NVIDIA_API_KEY || "",
  baseURL: providers[0]?.baseURL || "https://www.codebuddy.ai",

  // Provider registry — the source of truth for upstream routing
  providers: providerRegistry,
};
