import express from "express";
import http from "http";
import https from "https";
import fs from "fs";
import { config } from "./config.js";
import { getModels } from "./models.js";
import { upstreamURLFor } from "./lib/upstream.js";
import { handleChatCompletions } from "./routes/openai.js";

const app = express();
app.use(express.json({ limit: "5mb" }));

// Pi 的思考档位枚举（packages/ai/src/types.ts 的 ThinkingLevel，加 off）。
// 与 CodeBuddy 客户端 i18n 里的 efforts 一致：minimal/low/medium/high/xhigh/max。
const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

// 健康检查
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    defaultProvider: config.providers.defaultProviderName,
    upstream: upstreamURLFor(config.defaultModel),
    defaultModel: config.defaultModel,
  });
});

// 列出可用模型
app.get("/v1/models", (_req, res) => {
  const models = getModels();
  res.json({
    object: "list",
    data: models.map((m) => ({
      id: m.id,
      object: "model",
      created: Date.now(),
      owned_by: "codebuddy",
      name: m.name,
      credits: m.credits,
      description: m.description,
      description_zh: m.descriptionZh,
      max_input_tokens: m.maxInputTokens,
      max_output_tokens: m.maxOutputTokens,
      supports_images: m.supportsImages,
      supports_tool_call: m.supportsToolCall,
      supports_reasoning: m.supportsReasoning,
      supported_efforts: m.supportedEfforts,
      default_effort: m.defaultEffort,
      can_disable_thinking: m.canDisableThinking,
    })),
  });
});

// 供下游 Agent CLI（如 Pi）直接使用的模型目录片段。
// 把上游的档位口径原样映射成 Pi 的 thinkingLevelMap，避免两边各写一份导致漂移。
// 用法：pi models.json 里 providers.<name>.models 填这段，或 ?provider=name 取整份配置。
app.get("/v1/models/pi-catalog", (req, res) => {
  const models = getModels();
  const baseURL = `${req.protocol}://${req.get("host")}/v1`;
  const entries = models.map((m) => {
    // Pi 档位 → 上游档位值。上游未声明 supportedEfforts 时只保留开关（不写 map）。
    const thinkingLevelMap = m.supportedEfforts
      ? Object.fromEntries(
          PI_THINKING_LEVELS.map((level) => [
            level,
            m.supportedEfforts.includes(level) ? level : null,
          ]),
        )
      : undefined;

    return {
      id: m.id,
      name: m.name || m.id,
      reasoning: !!m.supportsReasoning,
      ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
      input: m.supportsImages ? ["text", "image"] : ["text"],
      contextWindow: m.maxInputTokens || 128000,
      maxTokens: m.maxOutputTokens || 16384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  });

  if (req.query.provider) {
    const providerName = String(req.query.provider);
    return res.json({
      providers: {
        [providerName]: {
          name: providerName,
          baseUrl: baseURL,
          api: "openai-completions",
          // Proxy 不校验 key，随意占位；需要真实值时用 ?apiKey= 传入。
          apiKey: String(req.query.apiKey || "proxy-injected"),
          compat: { supportsStore: false, supportsReasoningEffort: true },
          models: entries,
        },
      },
    });
  }

  res.json(entries);
});

// OpenAI-compatible chat completions
app.post("/v1/chat/completions", handleChatCompletions);

// 405 for known paths with wrong method, 404 for unknown
app.use((req, res) => {
  const knownPaths = ["/v1/chat/completions"];
  if (knownPaths.includes(req.path) && req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res
      .status(405)
      .json({
        error: { message: `Method ${req.method} not allowed on ${req.path}` },
      });
  }
  res
    .status(404)
    .json({
      error: {
        message: "Use POST /v1/chat/completions, or GET /v1/models",
      },
    });
});

// ─── Start ──────────────────────────────────────────────────────────────────
function startServer() {
  const providers = config.providers
    .list()
    .map((p) => p.name)
    .join(", ");

  http.createServer(app).listen(config.port, config.host, () => {
    console.log(`
  ✦ workbuddy-api proxy running

  OpenAI:    http://${config.host}:${config.port}/v1/chat/completions`);

    if (config.httpsEnabled) {
      try {
        const privateKey = fs.readFileSync(config.httpsKeyPath, "utf8");
        const certificate = fs.readFileSync(config.httpsCertPath, "utf8");
        const credentials = { key: privateKey, cert: certificate };
        https.createServer(credentials, app).listen(config.httpsPort, config.host, () => {
          console.log(`
  HTTPS:     https://${config.host}:${config.httpsPort}/v1/chat/completions`);
        });
      } catch (err) {
        console.error(`
  ✗ Failed to start HTTPS server: ${err.message}
  Check that ${config.httpsKeyPath} and ${config.httpsCertPath} exist.
  You can generate self-signed certificates with:
    node scripts/gen-cert.js
  `);
      }
    }

    console.log(`
  Providers: ${providers} (default: ${config.providers.defaultProviderName})
  Default:   ${config.defaultModel}
  `);
  });
}

startServer();
