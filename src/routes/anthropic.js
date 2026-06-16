import { config } from '../config.js';
import { fetchUpstream, providerFor } from '../lib/upstream.js';
import { logRequest } from '../lib/logger.js';
import { makeRequestId, dumpRequest } from '../lib/debug.js';

/**
 * POST /v1/messages — Anthropic Messages API endpoint
 *
 * Pure passthrough: the request path defines the protocol, and the body is
 * forwarded verbatim (with only model-name alias resolution applied by the
 * provider layer). The upstream response is piped byte-for-byte back to the
 * client. No Anthropic↔OpenAI format conversions are performed.
 *
 * The provider's protocol field is NOT checked here — the route path IS the
 * protocol declaration. If a model is misconfigured to route to an
 * OpenAI-protocol provider, the upstream will naturally return an error.
 */
export async function handleMessages(req, res) {
  const startTime = Date.now();
  const body = req.body;
  const model = body.model || config.defaultModel;

  const requestId = makeRequestId();
  dumpRequest('anthropic', requestId, body);

  const wantStream = body.stream === true;

  let upstream;
  try {
    upstream = await fetchUpstream({ ...body, model });
  } catch (err) {
    console.error('[anthropic fetch error]', err?.message || err);
    return res.status(502).json({ type: 'error', error: { type: 'api_error', message: err?.message || 'Upstream fetch failed' } });
  }

  if (!upstream.ok) {
    const errText = await upstream.text();
    return res.status(upstream.status).setHeader('content-type', 'application/json').send(errText);
  }

  if (wantStream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
  } else {
    res.setHeader('Content-Type', 'application/json');
  }

  res.on('close', () => {
    if (res.writableEnded) return;
    try { upstream.body.cancel?.(); } catch {}
  });

  try {
    const reader = upstream.body.getReader();
    const TIMEOUT = 120_000;
    let lastDataTime = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastDataTime > TIMEOUT) {
        console.error('[anthropic timeout]');
        try { reader.cancel(); } catch {}
        clearInterval(watchdog);
      }
    }, 10_000);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lastDataTime = Date.now();
      res.write(value);
    }
    clearInterval(watchdog);
  } catch (e) {
    console.error('[anthropic pipe error]', e.message);
  }

  res.end();
  logRequest({ model, startTime });
}
