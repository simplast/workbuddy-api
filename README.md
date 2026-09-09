# workbuddy-api

[中文文档](./README.zh-CN.md)

Local proxy that connects OpenAI-compatible clients (Vercel AI SDK, any `POST /v1/chat/completions` client) to CodeBuddy.

## Quick Start

Requires Node.js ≥ 18.

```bash
npm install
cp .env.example .env   # edit .env to add your CODEBUDDY_API_KEY
npm run dev            # http://127.0.0.1:3456
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions API (thinking effort passed through) |
| `GET` | `/v1/models` | Model list with reasoning effort levels (from WorkBuddy product config) |
| `GET` | `/v1/models/pi-catalog` | Ready-to-use Pi provider config (`?provider=name`) |
| `GET` | `/health` | Health check |

## Usage

```js
import { createOpenAI } from "@ai-sdk/openai";

const local = createOpenAI({
  baseURL: "http://127.0.0.1:3456/v1",
  apiKey: "dummy", // proxy injects the real token
});

const result = await local.chat("default").generate("Hello");
```

## Provider

CodeBuddy is the sole upstream:

| Provider | Protocol | Notes |
|----------|----------|-------|
| **CodeBuddy** | OpenAI `/v2/chat/completions` | CLI request-header fingerprinting, prompt replacement |

## Environment Variables

`CODEBUDDY_API_KEY` is required.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CODEBUDDY_API_KEY` | Yes | — | Enable CodeBuddy provider |
| `CODEBUDDY_BASE_URL` | No | `https://www.codebuddy.ai` | Also: `https://copilot.tencent.com` (internal) |
| `CODEBUDDY_MODELS` | No | `default` | Comma-separated model aliases |
| `CODEBUDDY_TARGET_MODEL` | No | (same as alias) | Real upstream model name |
| `CODEBUDDY_CLI_VERSION` | No | `2.110.0` | Override auto-detected version |
| `DEFAULT_MODEL` | No | (none) | Default model when request omits it |
| `PORT` | No | `3456` | |
| `HOST` | No | `127.0.0.1` | |

## Architecture

```
POST /v1/chat/completions
  └─ handleChatCompletions() → handleCodeBuddyRequest()  (full adaptation stack)
      ├─ fetchUpstream(body)
      │   ├─ provider.resolveURL()    → /v2/chat/completions
      │   ├─ provider.buildHeaders()  → CLI fingerprint headers
      │   └─ provider.preRequest()    → model alias → real name
      ├─ stream:true  → SSE field cleaning + pipe to client
      └─ stream:false → aggregate SSE → single JSON response
```

- **CodeBuddy path**: prompt replacement, content filtering, forced streaming, SSE field cleaning, CLI fingerprint headers

See [Request Paths](docs/request-paths.md) and [Design Decisions](docs/design-decisions.md) for details.

## Model List

Model list is loaded from CodeBuddy CLI's local cache at `~/.codebuddy/local_storage/`, refreshed every 60 seconds. No separate API call needed.

## License

MIT
