import express from 'express';
import { config } from './config.js';
import { getModels } from './models.js';
import { UPSTREAM } from './lib/upstream.js';
import { handleChatCompletions } from './routes/openai.js';
import { handleMessages } from './routes/anthropic.js';

const app = express();
app.use(express.json({ limit: '50mb' }));

// 健康检查
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', upstream: UPSTREAM, defaultModel: config.defaultModel });
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

// 404 fallback
app.use((_req, res) => {
  res.status(404).json({ error: { message: 'Use POST /v1/chat/completions, POST /v1/messages, or GET /v1/models' } });
});

// ─── Start ──────────────────────────────────────────────────────────────────
app.listen(config.port, config.host, () => {
  console.log(`
  ✦ workbuddy-api proxy running

  OpenAI:    http://${config.host}:${config.port}/v1/chat/completions
  Anthropic: http://${config.host}:${config.port}/v1/messages
  Upstream:  ${UPSTREAM}
  Default:   ${config.defaultModel}
  `);
});
