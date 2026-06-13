import { config } from '../config.js';
import { buildCliHeaders } from './headers.js';

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

export function sanitizeBody(body) {
  return body;
}

export async function fetchUpstream(body) {
  const isNvidia = isNvidiaModel(body.model);
  const targetUrl = isNvidia ? NVIDIA_UPSTREAM : UPSTREAM;
  const cleanBody = sanitizeBody(body);
  cleanBody.model = resolveModel(body.model);

  if (isNvidia) {
    console.log(`\x1b[35m[nvidia]\x1b[0m model=${cleanBody.model} → ${NVIDIA_UPSTREAM}`);
  }

  return fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${isNvidia ? config.nvidia.apiKey : config.apiKey}`,
      ...(isNvidia ? {} : buildCliHeaders(cleanBody.model)),
    },
    body: JSON.stringify(cleanBody),
  });
}
