/**
 * Rate limiter for NVIDIA API requests.
 * NVIDIA free tier has strict rate limits (e.g., 40 rpm).
 * This module provides thread-safe rate limiting with:
 * - Token bucket algorithm for normal rate control
 * - Exponential backoff when 429 is received
 */

import { config } from '../config.js';

const DEFAULT_RPM = 40;
const DEFAULT_BURST = 5;
const MIN_BACKOFF_MS = 60000;      // 最小退避时间 1 分钟
const MAX_BACKOFF_MS = 30 * 60000;  // 最大退避时间 30 分钟
const BACKOFF_MULTIPLIER = 2;       // 指数退避倍数

class RateLimiter {
  constructor({ rpm = DEFAULT_RPM, burst = DEFAULT_BURST } = {}) {
    this.rpm = rpm;
    this.burst = burst;
    this.tokens = burst;
    this.lastRefillTime = Date.now();
    this.refillInterval = 60000 / rpm;
    
    // 429 退避相关
    this.backoffUntil = 0;           // 退避截止时间戳
    this.backoffMultiplier = 1;      // 当前退避倍数
    this.consecutive429Count = 0;    // 连续 429 次数
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
    
    // 检查是否在 429 退避期内
    if (this.backoffUntil > now) {
      const waitTime = this.backoffUntil - now;
      console.log(`\x1b[33m[rate-limit]\x1b[0m Waiting ${Math.round(waitTime / 1000)}s due to previous 429...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    // 令牌桶等待
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
    const now = Date.now();
    this.consecutive429Count++;
    
    // 计算退避时间（指数退避）
    const backoffMs = Math.min(
      MIN_BACKOFF_MS * Math.pow(BACKOFF_MULTIPLIER, this.consecutive429Count - 1),
      MAX_BACKOFF_MS
    );
    
    this.backoffUntil = now + backoffMs;
    this.backoffMultiplier = Math.min(this.backoffMultiplier * BACKOFF_MULTIPLIER, 16);
    
    console.log(`\x1b[31m[rate-limit]\x1b[0m 429 received! Cooling down for ${Math.round(backoffMs / 60000)} minutes (count=${this.consecutive429Count})`);
  }

  onSuccess() {
    // 请求成功，重置退避状态
    this.consecutive429Count = 0;
    this.backoffMultiplier = 1;
  }

  getStats() {
    return {
      tokens: this.tokens,
      burst: this.burst,
      rpm: this.rpm,
      consecutive429Count: this.consecutive429Count,
      backoffRemainingMs: Math.max(0, this.backoffUntil - Date.now()),
    };
  }
}

const nvidiaRateLimit = config.nvidia.rateLimit || {};
const nvidiaLimiter = new RateLimiter({
  rpm: nvidiaRateLimit.rpm || DEFAULT_RPM,
  burst: nvidiaRateLimit.burst || DEFAULT_BURST,
});

console.log(`  [rate-limit] NVIDIA RPM: ${nvidiaLimiter.rpm}, burst: ${nvidiaLimiter.burst}`);

export { RateLimiter, nvidiaLimiter };
