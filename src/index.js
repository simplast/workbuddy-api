import express from "express";
import http from "http";
import https from "https";
import fs from "fs";
import { config } from "./config.js";
import { getModels } from "./models.js";
import { upstreamURLFor } from "./lib/upstream.js";
import { handleChatCompletions } from "./routes/openai.js";

const app = express();

// 请求体上限按 base64 图片的体积定，纯文本根本用不到这么多；不超过 8mb 也不是拍脑袋——
// 它被内存卡住。
//
// 下限：下游（Pi）把每张图压到 512 KiB base64 才放进历史，8mb 能装下约 15 张，
// 足够一次带图的请求；5mb 会在第二张未压缩的截图（3–4 MB base64）就 413。
//
// 上限：解析、bodyHash 序列化、fetch 再序列化各留一份副本，实测 14.7 MB 的 body
// 让 RSS 从 73 MB 冲到 283 MB（≈ body 的 14 倍），而服务以 --max-old-space-size=256
// 运行。 8mb 的峰值约 185 MB，留得下余量；要再抬限必须先抬堆上限，两者是同一个决定。
const MAX_BODY = "8mb";

app.use(express.json({ limit: MAX_BODY }));

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
      off_effort: m.offEffort,
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
    //
    // off 必须给一个真实的 provider 值：Pi 对 null 的处理是「不发 reasoning_effort」，
    // 而上游收不到参数就照自己的默认档跑（hy4/hy3 默认 high），于是「关思考」实际
    // 只是「按 high 思考」——一句话问候 30 秒的根源。
    const thinkingLevelMap = m.supportedEfforts
      ? Object.fromEntries(
          PI_THINKING_LEVELS.map((level) => [
            level,
            level === "off"
              ? m.offEffort ?? null
              : m.supportedEfforts.includes(level)
                ? level
                : null,
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

// ─── body-parser errors ─────────────────────────────────────────────────────
// Express 默认把这些错误渲染成 HTML 错误页，下游 agent 只能看到一坨
// "413 <!DOCTYPE html>…"，和上游故障、网络故障混在一起没法分辨。改回 OpenAI 的
// JSON 形状，把可操作的信息（上限、该压图）直接写进 message。
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;

  if (status === 413) {
    return res.status(413).json({
      error: {
        type: "payload_too_large",
        message:
          `Request body exceeds the proxy limit of ${MAX_BODY}. ` +
          "Images travel as base64, so compress or drop them before retrying.",
      },
    });
  }

  if (err.type === "entity.parse.failed") {
    return res.status(400).json({
      error: { type: "invalid_json", message: "Request body is not valid JSON." },
    });
  }

  console.error("[unhandled]", err);
  res.status(status).json({
    error: { type: "proxy_error", message: err.message || "Internal proxy error" },
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
