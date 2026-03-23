/**
 * FurnIAI — TokenBucket 令牌桶限流器
 * 独立模块，避免 geminiClient ↔ keyPool 循环依赖。
 */

class TokenBucket {
  /**
   * @param {object} opts
   * @param {number} opts.capacity     桶容量（默认 5）
   * @param {number} opts.refillRate   每次补充令牌数（默认 1）
   * @param {number} opts.refillInterval 补充间隔 ms（默认 1000）
   */
  constructor({ capacity = 5, refillRate = 1, refillInterval = 1000 } = {}) {
    this.capacity = capacity
    this.tokens = capacity
    this.refillRate = refillRate
    this.refillInterval = refillInterval
    this.originalRefillInterval = refillInterval
    this.lastRefill = Date.now()
    // 自适应限流：429 错误追踪
    this._error429Timestamps = []
    this._adaptiveWindowMs = 60000 // 60 秒滑动窗口
  }

  /** 补充令牌（根据经过的时间） */
  refill() {
    const now = Date.now()
    const elapsed = now - this.lastRefill
    const newTokens = Math.floor(elapsed / this.refillInterval) * this.refillRate
    if (newTokens > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + newTokens)
      this.lastRefill = now
    }
  }

  /**
   * 获取一个令牌，无令牌时等待补充
   * @returns {Promise<void>}
   */
  async acquire() {
    while (true) {
      this.refill()
      if (this.tokens > 0) {
        this.tokens -= 1
        return
      }
      // 等待一个补充周期后重试
      await new Promise(r => setTimeout(r, this.refillInterval))
    }
  }

  /**
   * 自适应限流回调：根据 API 响应状态码动态调整 refillInterval
   * - 429 错误 > 3 次/60s → refillInterval *= 1.5（放慢）
   * - 60s 内无 429 错误 → refillInterval 逐步恢复（* 0.8，不低于原始值）
   * @param {number} statusCode HTTP 状态码
   */
  onApiResponse(statusCode) {
    const now = Date.now()

    if (statusCode === 429) {
      this._error429Timestamps.push(now)
    }

    // 清理滑动窗口外的旧记录
    this._error429Timestamps = this._error429Timestamps.filter(
      ts => now - ts < this._adaptiveWindowMs
    )

    const recentCount = this._error429Timestamps.length

    if (recentCount > 3) {
      // 429 频率过高，放慢补充速度（上限为原始值的 10 倍，防止无限膨胀）
      this.refillInterval = Math.min(
        Math.round(this.refillInterval * 1.5),
        this.originalRefillInterval * 10
      )
    } else if (recentCount === 0) {
      // 无 429 错误，逐步恢复
      this.refillInterval = Math.max(
        this.originalRefillInterval,
        Math.round(this.refillInterval * 0.8)
      )
    }
  }
}

module.exports = { TokenBucket }
