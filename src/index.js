import express from 'express';
import { config } from './config.js';
import { getModels } from './models.js';
import { upstreamURLFor } from './lib/upstream.js';
import { handleChatCompletions } from './routes/openai.js';
import { handleMessages } from './routes/anthropic.js';

const app = express();
app.use(express.json({ limit: '50mb' }));

// 健康检查
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    defaultProvider: config.providers.defaultProviderName,
    upstream: upstreamURLFor(config.defaultModel),
    defaultModel: config.defaultModel,
  });
});

// 列出可用模型
app.get('/v1/models', (_req, res) => {
  const models = getModels();
  res.json({
    object: 'list',
    data: models.map((m) => ({
      id: m.id,
      object: 'model',
      created: Date.now(),
      owned_by: 'codebuddy',
      name: m.name,
      credits: m.credits,
      supportsImages: m.supportsImages,
      supportsReasoning: m.supportsReasoning,
    })),
  });
});

// OpenAI-compatible chat completions
app.post('/v1/chat/completions', handleChatCompletions);

// Anthropic Messages API
app.post('/v1/messages', handleMessages);

// 405 for known paths with wrong method, 404 for unknown
app.use((req, res) => {
  const knownPaths = ['/v1/chat/completions', '/v1/messages'];
  if (knownPaths.includes(req.path) && req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: { message: `Method ${req.method} not allowed on ${req.path}` } });
  }
  res.status(404).json({ error: { message: 'Use POST /v1/chat/completions, POST /v1/messages, or GET /v1/models' } });
});

// ─── Start ──────────────────────────────────────────────────────────────────
app.listen(config.port, config.host, () => {
  const providers = config.providers.list().map((p) => p.name).join(', ');
  console.log(`
  ✦ workbuddy-api proxy running

  OpenAI:    http://${config.host}:${config.port}/v1/chat/completions
  Anthropic: http://${config.host}:${config.port}/v1/messages
  Providers: ${providers} (default: ${config.providers.defaultProviderName})
  Default:   ${config.defaultModel}
  `);
});
