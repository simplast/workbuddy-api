/**
 * Provider base class.
 *
 * All upstream providers speak one of two wire protocols:
 *   - 'openai'    — POST /chat/completions (OpenAI Chat Completions API)
 *   - 'anthropic' — POST /messages (Anthropic Messages API)
 *
 * "Private" providers (e.g. CodeBuddy, NVIDIA) are patches on top of one of
 * these protocols — they add custom headers, field rewrites, or rate-limit
 * hooks, but never invent a third wire format. Add a new private provider
 * by extending `OpenAIProvider` or `AnthropicProvider` and overriding the
 * relevant hooks.
 *
 * Public hooks (override in subclasses to add provider-specific behavior):
 *   - resolveURL()              → returns the full upstream URL
 *   - buildHeaders(body)        → returns the headers object for the request
 *   - preRequest(body)          → mutate request body before sending (sync)
 *   - async preRequestAsync()   → async hook (e.g. acquire rate-limit token)
 *   - postResponse(response)    → observe response status (sync)
 *   - onSuccess() / on429()     → rate-limit feedback
 */
export class Provider {
  /**
   * @param {object} opts
   * @param {string} opts.name           - unique provider name (used for logging)
   * @param {'openai'|'anthropic'} opts.protocol
   * @param {string} opts.baseURL
   * @param {string} opts.apiKey
   * @param {string[]} [opts.models]     - aliases that route to this provider
   * @param {object}   [opts.modelMap]   - alias → real upstream model name
   * @param {string}   [opts.label]      - human-readable label for logs
   */
  constructor({
    name,
    protocol,
    baseURL,
    apiKey,
    models = [],
    modelMap = {},
    label,
  }) {
    if (!["openai", "anthropic"].includes(protocol)) {
      throw new Error(
        `Provider "${name}" has invalid protocol "${protocol}" (expected 'openai' or 'anthropic')`,
      );
    }
    this.name = name;
    this.protocol = protocol;
    this.baseURL = baseURL.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.models = models;
    this.modelMap = modelMap;
    this.label = label || name;
  }

  /** Override in subclasses to return a non-standard URL path. */
  resolveURL() {
    return this.protocol === "anthropic"
      ? `${this.baseURL}/v1/messages`
      : `${this.baseURL}/v1/chat/completions`;
  }

  /** Default headers: Authorization + Content-Type. Override to add custom headers. */
  buildHeaders(/* body */) {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  /**
   * Map a client-facing model alias to the upstream's real model name.
   * Subclasses with model-name rewrites should override this.
   */
  resolveModel(alias) {
    return this.modelMap[alias] || alias;
  }

  /**
   * Sync hook: mutate the request body before sending.
   * Default: just rewrite the model name.
   */
  preRequest(body) {
    return { ...body, model: this.resolveModel(body.model) };
  }

  /** Async hook: e.g. wait for a rate-limit token. Default: no-op. */
  async preRequestAsync(/* body */) {}

  /**
   * Observe the response so subclasses can update internal state
   * (rate limit, circuit breaker, etc.). Default: no-op.
   */
  postResponse(/* response */) {}

  /** Convenience: did this request succeed? */
  onSuccess() {
    this.postResponse({ ok: true });
  }

  /** Convenience: did we hit a rate limit? */
  on429() {
    this.postResponse({ ok: false, status: 429 });
  }
}

/** OpenAI-protocol provider (default). */
export class OpenAIProvider extends Provider {
  constructor(opts) {
    super({ ...opts, protocol: "openai" });
  }
}

/** Anthropic-protocol provider. */
export class AnthropicProvider extends Provider {
  constructor(opts) {
    super({ ...opts, protocol: "anthropic" });
  }
}
