# workbuddy-api

Local proxy that connects OpenAI-compatible clients (Vercel AI SDK, any `POST /v1/chat/completions` client) to CodeBuddy and other AI providers. Also supports the Anthropic Messages API format.

## Quick Start

```bash
npm install
cp .env.example .env   # edit .env to add your API key(s)
npm run dev            # http://127.0.0.1:3456
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions API |
| `POST` | `/v1/messages` | Anthropic Messages API |
| `GET` | `/v1/models` | Model list (from CodeBuddy CLI cache) |
| `GET` | `/health` | Health check |

## Usage

```js
import { createOpenAI } from "@ai-sdk/openai";

const local = createOpenAI({
  baseURL: "http://127.0.0.1:3456/v1",
  apiKey: "dummy", // proxy injects the real token
});

const result = await local.chat("default-model").generate("Hello");
```

## Providers

Two provider types, one protocol each:

| Provider | Protocol | Notes |
|----------|----------|-------|
| **CodeBuddy** | OpenAI `/v2/chat/completions` | CLI request-header fingerprinting, prompt replacement |
| **NVIDIA** | OpenAI `/v1/chat/completions` | Token-bucket rate limiting, 429 backoff |

Add a new provider by subclassing `OpenAIProvider` or `AnthropicProvider` in `src/providers/`. See [Provider Guide](docs/provider-guide.md).

## Environment Variables

At least one provider API key is required.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CODEBUDDY_API_KEY` | At least one | — | Enable CodeBuddy provider |
| `NVIDIA_API_KEY` | At least one | — | Enable NVIDIA provider |
| `CODEBUDDY_BASE_URL` | No | `https://www.codebuddy.ai` | Also: `https://copilot.tencent.com` (internal) |
| `CODEBUDDY_MODELS` | No | `default-model` | Comma-separated model aliases |
| `CODEBUDDY_TARGET_MODEL` | No | — | Real upstream model name |
| `CODEBUDDY_CLI_VERSION` | No | `2.110.0` | Override auto-detected version |
| `NVIDIA_BASE_URL` | No | `https://integrate.api.nvidia.com/v1` | |
| `NVIDIA_MODELS` | No | — | Comma-separated model aliases |
| `NVIDIA_TARGET_MODEL` | No | `z-ai/glm-5.1` | |
| `NVIDIA_RPM` | No | `40` | Requests per minute |
| `NVIDIA_BURST` | No | `5` | Token bucket burst capacity |
| `DEFAULT_PROVIDER` | No | First configured | Fallback when model not claimed |
| `DEFAULT_MODEL` | No | — | |
| `PORT` | No | `3456` | |
| `HOST` | No | `127.0.0.1` | |

## Architecture

```
POST /v1/chat/completions
  ├─ handleChatCompletions()
  │   ├─ providerFor(model)  →  select provider
  │   ├─ isCodeBuddy?
  │   │   ├─ YES → handleCodeBuddyRequest()  (full adaptation stack)
  │   │   └─ NO  → handlePassthroughRequest() (pure passthrough)
  │   └─ fetchUpstream(body)
  │       ├─ provider.resolveURL()
  │       ├─ provider.buildHeaders()
  │       └─ provider.preRequest()  (model alias → real name)
  │
  POST /v1/messages
    └─ handleMessages() → pure byte-level passthrough
```

- **CodeBuddy path**: prompt replacement, content filtering, forced streaming, SSE field cleaning, CLI fingerprint headers
- **Passthrough path**: original body → upstream → raw bytes → client
- **Anthropic path**: protocol declared by route path, no format conversion

See [Request Paths](docs/request-paths.md) and [Design Decisions](docs/design-decisions.md) for details.

## Model List

Model list is loaded from CodeBuddy CLI's local cache at `~/.codebuddy/local_storage/`, refreshed every 60 seconds. No separate API call needed.

## License

MIT
