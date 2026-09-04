import "dotenv/config";
import { CodeBuddyProvider } from "./providers/codebuddy.js";
import { ProviderRegistry } from "./providers/registry.js";

/**
 * CodeBuddy-only configuration.
 *
 * CodeBuddy is the sole upstream — an OpenAI-protocol provider with CLI
 * request-header fingerprinting and prompt replacement. The registry is
 * retained so model aliases still resolve through the same dispatch layer.
 */
const providers = [];

// ─── codebuddy (only provider) ────────────────────────────────────────
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

if (providers.length === 0) {
  console.error(
    "\n  ⚠  No provider configured!\n" +
      "  Please set CODEBUDDY_API_KEY in .env, or pass via environment.\n" +
      "  See .env.example for the full list of supported env vars.\n",
  );
  process.exit(1);
}

const defaultProviderName = "codebuddy";

export const providerRegistry = new ProviderRegistry(
  providers,
  defaultProviderName,
);

export const config = {
  // Local proxy server
  port: parseInt(process.env.PORT || "3456", 10),
  host: process.env.HOST || "127.0.0.1",

  // HTTPS configuration
  httpsEnabled: process.env.HTTPS_ENABLED === "1",
  httpsPort: parseInt(process.env.HTTPS_PORT || "3457", 10),
  httpsKeyPath: process.env.HTTPS_KEY_PATH || "certs/localhost.key",
  httpsCertPath: process.env.HTTPS_CERT_PATH || "certs/localhost.crt",

  // Defaults used when the request omits a model
  defaultModel: process.env.DEFAULT_MODEL || "default",
  apiKey: process.env.CODEBUDDY_API_KEY || "",
  baseURL: providers[0]?.baseURL || "https://www.codebuddy.ai",

  // Provider registry — the source of truth for upstream routing
  providers: providerRegistry,
};
