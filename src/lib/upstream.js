import { config } from '../config.js';
import { buildCliHeaders } from './headers.js';
import { nvidiaLimiter } from './rate-limit.js';

export const UPSTREAM = `${config.baseURL}/v2/chat/completions`;
export const NVIDIA_UPSTREAM = `${config.nvidia.baseURL}/chat/completions`;

export function isNvidiaModel(model) {
  return config.nvidia.models.includes(model);
}

export function resolveModel(model) {
  if (isNvidiaModel(model) && config.nvidia.modelMap[model]) {
    return config.nvidia.modelMap[model];
  }
  return model;
}

// Reserved for future request body sanitization (e.g. stripping unsupported fields).
// Currently a pass-through; do NOT remove — fetchUpstream depends on the return value.
export function sanitizeBody(body) {
  return body;
}

export async function fetchUpstream(body) {
  const isNvidia = isNvidiaModel(body.model);
  const targetUrl = isNvidia ? NVIDIA_UPSTREAM : UPSTREAM;
  const cleanBody = sanitizeBody(body);
  cleanBody.model = resolveModel(body.model);

  if (isNvidia) {
    // Apply rate limiting for NVIDIA API
    await nvidiaLimiter.acquire();
    console.log(`\x1b[35m[nvidia]\x1b[0m model=${cleanBody.model} → ${NVIDIA_UPSTREAM}`);
  }

  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${isNvidia ? config.nvidia.apiKey : config.apiKey}`,
      ...(isNvidia ? {} : buildCliHeaders(cleanBody.model)),
    },
    body: JSON.stringify(cleanBody),
  });

  // Handle 429 for NVIDIA API
  if (isNvidia && response.status === 429) {
    nvidiaLimiter.on429();
  } else if (isNvidia && response.ok) {
    nvidiaLimiter.onSuccess();
  }

  return response;
}
