/**
 * Upstream request dispatcher.
 *
 * Resolves the right provider for the request's model and delegates URL,
 * headers, body rewrites, and rate-limiting to it. The two base protocols
 * (openai / anthropic) are handled by the provider classes themselves;
 * private patches (CLI fingerprint, rate limit) sit on top.
 */
import { providerRegistry } from '../config.js';

/**
 * Find the provider that should serve a given model alias.
 * @param {string} model
 */
export function providerFor(model) {
  return providerRegistry.resolveForModel(model);
}

/**
 * Fetch from upstream.
 *
 * @param {object} body - the request body (in OpenAI format)
 * @returns {Promise<Response>}
 */
export async function fetchUpstream(body) {
  const provider = providerFor(body.model);

  // Provider-defined async preflight (e.g. acquire rate-limit token)
  await provider.preRequestAsync(body);

  // Provider-defined body rewrites (model name alias, field cleanup, etc.)
  const finalBody = provider.preRequest(body);

  const response = await fetch(provider.resolveURL(), {
    method: 'POST',
    headers: provider.buildHeaders(finalBody),
    body: JSON.stringify(finalBody),
  });

  // Provider-defined post-response hooks (rate-limit feedback, circuit breaker, ...)
  if (response.status === 429) {
    provider.on429();
  } else if (response.ok) {
    provider.onSuccess();
  } else {
    provider.postResponse(response);
  }

  return response;
}

/**
 * Build the upstream URL for a model (used by /health for diagnostics).
 */
export function upstreamURLFor(model) {
  return providerFor(model).resolveURL();
}
