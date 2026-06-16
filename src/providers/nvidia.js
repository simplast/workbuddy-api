/**
 * NVIDIA provider — OpenAI protocol with per-provider rate limiting.
 *
 * NVIDIA's free tier has a strict RPM limit (typically 40). We layer a
 * token-bucket limiter on top of a standard OpenAI request, and apply
 * exponential backoff on 429 responses.
 */
import { OpenAIProvider } from './base.js';

const DEFAULT_RPM = 40;
const DEFAULT_BURST = 5;
const MIN_BACKOFF_MS = 60_000;        // 1 minute
const MAX_BACKOFF_MS = 30 * 60_000;   // 30 minutes
const BACKOFF_MULTIPLIER = 2;

/**
 * Token-bucket rate limiter with 429-triggered exponential backoff.
 * Not async-safe across processes (in-memory only) — fine for a single
 * proxy process.
 */
class RateLimiter {
  constructor({ rpm = DEFAULT_RPM, burst = DEFAULT_BURST } = {}) {
    this.rpm = rpm;
    this.burst = burst;
    this.tokens = burst;
    this.lastRefillTime = Date.now();
    this.refillInterval = 60_000 / rpm;

    this.backoffUntil = 0;
    this.backoffMultiplier = 1;
    this.consecutive429Count = 0;
  }

  refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefillTime;
    const newTokens = Math.floor(elapsed / this.refillInterval);
    if (newTokens > 0) {
      this.tokens = Math.min(this.tokens + newTokens, this.burst);
      this.lastRefillTime = now;
    }
  }

  async acquire() {
    const now = Date.now();
    if (this.backoffUntil > now) {
      const waitTime = this.backoffUntil - now;
      console.log(`\x1b[33m[rate-limit]\x1b[0m Waiting ${Math.round(waitTime / 1000)}s due to previous 429...`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
    return new Promise((resolve) => {
      const tryAcquire = () => {
        this.refill();
        if (this.tokens > 0) {
          this.tokens--;
          resolve();
          return;
        }
        const waitTime = Math.max(this.refillInterval, 100);
        setTimeout(tryAcquire, waitTime);
      };
      tryAcquire();
    });
  }

  on429() {
    this.consecutive429Count++;
    const backoffMs = Math.min(
      MIN_BACKOFF_MS * Math.pow(BACKOFF_MULTIPLIER, this.consecutive429Count - 1),
      MAX_BACKOFF_MS,
    );
    this.backoffUntil = Date.now() + backoffMs;
    this.backoffMultiplier = Math.min(this.backoffMultiplier * BACKOFF_MULTIPLIER, 16);
    console.log(`\x1b[31m[rate-limit]\x1b[0m 429 received! Cooling down for ${Math.round(backoffMs / 60_000)} minutes (count=${this.consecutive429Count})`);
  }

  onSuccess() {
    this.consecutive429Count = 0;
    this.backoffMultiplier = 1;
  }
}

export class NvidiaProvider extends OpenAIProvider {
  /**
   * @param {object} opts
   * @param {number} [opts.rpm=40]   - requests per minute
   * @param {number} [opts.burst=5]  - token bucket size
   */
  constructor(opts) {
    super({ ...opts, label: opts.label || 'nvidia' });
    this.limiter = new RateLimiter({ rpm: opts.rpm, burst: opts.burst });
    console.log(`  [nvidia] RPM: ${this.limiter.rpm}, burst: ${this.limiter.burst}`);
  }

  /** Wait for a token before sending. */
  async preRequestAsync() {
    await this.limiter.acquire();
    console.log(`\x1b[35m[nvidia]\x1b[0m model=${this.label} → ${this.resolveURL()}`);
  }

  on429() {
    this.limiter.on429();
  }

  onSuccess() {
    this.limiter.onSuccess();
  }
}
