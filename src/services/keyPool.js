/**
 * FurnIAI — Gemini Key Pool
 * 多 Key 池化调度器：管理多个 Gemini API Key，每个 Key 绑定独立 TokenBucket，
 * 通过 Round-Robin 轮询分配请求，支持健康状态检测与自动故障转移。
 *
 * 仅影响 Google 官方 REST 通道（callGoogleAPI），G3Pro 代理通道保持不变。
 */

const { TokenBucket } = require('./tokenBucket')

// ==================== Key 脱敏 ====================

/**
 * 对 API Key 进行脱敏处理。
 * - Key 长度 >= 12：显示前 8 位 + "****" + 后 4 位
 * - Key 长度 < 12：显示前 4 位 + "****"
 *
 * @param {string} key - 原始 API Key
 * @returns {string} 脱敏后的 Key
 */
function maskKey(key) {
  if (key.length < 12) {
    return key.slice(0, 4) + '****'
  }
  return key.slice(0, 8) + '****' + key.slice(-4)
}

// ==================== KeyEntry ====================

/**
 * KeyPool 中的单个 Key 条目。
 * 每个 KeyEntry 绑定独立 TokenBucket 实例，维护健康状态和统计信息。
 */
class KeyEntry {
  /**
   * @param {string} apiKey - 原始 API Key
   * @param {Object} [tokenBucketConfig] - TokenBucket 配置
   * @param {number} [tokenBucketConfig.capacity=5]
   * @param {number} [tokenBucketConfig.refillRate=1]
   * @param {number} [tokenBucketConfig.refillInterval=1000]
   * @param {Object} [healthConfig] - 健康状态管理配置
   * @param {number} [healthConfig.cooldownThreshold=3]
   * @param {number} [healthConfig.cooldownWindowMs=60000]
   * @param {number} [healthConfig.cooldownDurationMs=60000]
   */
  constructor(
    apiKey,
    tokenBucketConfig = { capacity: 5, refillRate: 1, refillInterval: 1000 },
    healthConfig = {}
  ) {
    this.key = apiKey
    this.maskedKey = maskKey(apiKey)
    this.tokenBucket = new TokenBucket(tokenBucketConfig)
    this.status = 'healthy' // 'healthy' | 'cooldown' | 'exhausted'
    this.error429Timestamps = []
    this.totalRequests = 0
    this.error429Count = 0
    this.cooldownTimer = null
    this.cooldownEndTime = null
    this.exhaustedResetTime = null

    // Health config with defaults
    this._cooldownThreshold = healthConfig.cooldownThreshold ?? 3
    this._cooldownWindowMs = healthConfig.cooldownWindowMs ?? 60000
    this._cooldownDurationMs = healthConfig.cooldownDurationMs ?? 60000
  }

  /**
   * 报告 API 调用结果，更新健康状态。
   *
   * - 429 响应：记录到滑动窗口，超阈值触发 cooldown
   * - 配额耗尽（"exhausted your capacity"）：标记 exhausted，设置恢复定时器
   * - 状态变化时输出脱敏日志
   *
   * @param {number} statusCode - HTTP 状态码
   * @param {*} responseBody - 响应体（字符串或对象）
   */
  reportResult(statusCode, responseBody) {
    this.totalRequests++

    // --- 检查配额耗尽（优先级高于 429 处理） ---
    if (this._isExhausted(responseBody)) {
      this._handleExhausted(responseBody)
      return
    }

    // --- 处理 429 ---
    if (statusCode === 429) {
      this._handle429()
    }
  }

  /**
   * 检查响应体是否包含配额耗尽信息。
   * @param {*} responseBody
   * @returns {boolean}
   * @private
   */
  _isExhausted(responseBody) {
    if (!responseBody) return false
    const text = typeof responseBody === 'string'
      ? responseBody
      : JSON.stringify(responseBody)
    return text.includes('exhausted your capacity')
  }

  /**
   * 处理配额耗尽：标记 exhausted，解析重置时间，设置恢复定时器。
   * @param {*} responseBody
   * @private
   */
  _handleExhausted(responseBody) {
    const prevStatus = this.status

    // 清除已有的 cooldown 定时器（如果从 cooldown 转为 exhausted）
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer)
      this.cooldownTimer = null
      this.cooldownEndTime = null
    }

    this.status = 'exhausted'

    // 尝试从响应体解析重置时间，默认 60 分钟
    const resetMs = this._parseResetTime(responseBody)
    this.exhaustedResetTime = new Date(Date.now() + resetMs)

    this.cooldownTimer = setTimeout(() => {
      this.status = 'healthy'
      this.cooldownTimer = null
      this.exhaustedResetTime = null
      console.log(`[FurnIAI KeyPool] Key ${this.maskedKey} recovered from exhausted → healthy`)
    }, resetMs)

    if (prevStatus !== 'exhausted') {
      console.log(
        `[FurnIAI KeyPool] Key ${this.maskedKey} status: ${prevStatus} → exhausted` +
        ` (reset in ${Math.round(resetMs / 1000)}s)`
      )
    }
  }

  /**
   * 从响应体中解析配额重置时间。
   * 尝试匹配常见的重置时间格式，失败则返回默认 60 分钟。
   * @param {*} responseBody
   * @returns {number} 重置等待毫秒数
   * @private
   */
  _parseResetTime(responseBody) {
    const DEFAULT_RESET_MS = 60 * 60 * 1000 // 60 minutes

    try {
      const text = typeof responseBody === 'string'
        ? responseBody
        : JSON.stringify(responseBody)

      // 匹配秒数格式，如 "retry after 3600s" 或 "retryDelay": "3600s"（限定 retry/delay 上下文，避免误匹配）
      const secondsMatch = text.match(/(?:retry|delay|after)\D*(\d+)\s*s(?:ec(?:ond)?s?)?/i)
      if (secondsMatch) {
        const seconds = parseInt(secondsMatch[1], 10)
        if (seconds > 0 && seconds < 86400) {
          return seconds * 1000
        }
      }
    } catch {
      // 解析失败，使用默认值
    }

    return DEFAULT_RESET_MS
  }

  /**
   * 处理 429 响应：记录到滑动窗口，超阈值触发 cooldown。
   * @private
   */
  _handle429() {
    this.error429Count++

    const now = Date.now()
    this.error429Timestamps.push(now)

    // 清理滑动窗口外的旧时间戳
    const windowStart = now - this._cooldownWindowMs
    this.error429Timestamps = this.error429Timestamps.filter(ts => ts > windowStart)

    // 检查是否超过阈值
    if (this.error429Timestamps.length > this._cooldownThreshold && this.status === 'healthy') {
      this._enterCooldown()
    }
  }

  /**
   * 进入 cooldown 状态，启动恢复定时器。
   * @private
   */
  _enterCooldown() {
    this.status = 'cooldown'
    this.cooldownEndTime = new Date(Date.now() + this._cooldownDurationMs)

    // 清除已有定时器（防止重复）
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer)
    }

    this.cooldownTimer = setTimeout(() => {
      this.status = 'healthy'
      this.cooldownTimer = null
      this.cooldownEndTime = null
      this.error429Timestamps = []
      console.log(`[FurnIAI KeyPool] Key ${this.maskedKey} recovered from cooldown → healthy`)
    }, this._cooldownDurationMs)

    console.log(
      `[FurnIAI KeyPool] Key ${this.maskedKey} status: healthy → cooldown` +
      ` (429 count: ${this.error429Timestamps.length} in ${this._cooldownWindowMs / 1000}s window,` +
      ` recovery in ${this._cooldownDurationMs / 1000}s)`
    )
  }
}



// ==================== KeyPool ====================

/**
 * 多 Key 池化调度器。
 * 管理多个 KeyEntry，通过 Round-Robin 轮询分配请求，
 * 支持健康状态检测、令牌检查和自动等待。
 */
class KeyPool {
  /**
   * @param {Object} options
   * @param {string[]} options.keys - API Key 数组
   * @param {Object} [options.tokenBucketConfig] - TokenBucket 配置
   * @param {number} [options.cooldownThreshold=3] - 触发冷却的 429 次数阈值
   * @param {number} [options.cooldownWindowMs=60000] - 429 计数滑动窗口 ms
   * @param {number} [options.cooldownDurationMs=60000] - 冷却持续时间 ms
   */
  constructor(options) {
    const {
      keys,
      tokenBucketConfig = { capacity: 5, refillRate: 1, refillInterval: 1000 },
      cooldownThreshold = 3,
      cooldownWindowMs = 60000,
      cooldownDurationMs = 60000,
    } = options

    if (!keys || keys.length === 0) {
      throw new Error('[FurnIAI KeyPool] Cannot create KeyPool with zero keys.')
    }

    this.cooldownThreshold = cooldownThreshold
    this.cooldownWindowMs = cooldownWindowMs
    this.cooldownDurationMs = cooldownDurationMs
    this.tokenBucketConfig = tokenBucketConfig

    this.entries = keys.map(k => new KeyEntry(k, tokenBucketConfig, {
      cooldownThreshold,
      cooldownWindowMs,
      cooldownDurationMs,
    }))
    this._currentIndex = 0
  }

  /**
   * 获取一个可用的 KeyEntry（Round-Robin + 健康检查 + 令牌获取）。
   *
   * 调度逻辑：
   * 1. Round-Robin 轮询，跳过 cooldown/exhausted 状态的 Key
   * 2. 对 healthy 状态的 Key，检查 TokenBucket 是否有可用令牌
   * 3. 有令牌 → 消耗令牌并返回
   * 4. 所有 healthy Key 均无令牌 → 等待最先补充的 TokenBucket
   * 5. 所有 Key 均 cooldown/exhausted → 等待最先恢复的 Key
   *
   * @returns {Promise<{ key: string, tokenBucket: TokenBucket, reportResult: Function }>}
   */
  async acquireKey() {
    while (true) {
      // --- 第一轮：寻找有令牌的 healthy Key ---
      const healthyWithTokens = this._findHealthyKeyWithTokens()
      if (healthyWithTokens) {
        return this._buildResult(healthyWithTokens)
      }

      // --- 检查是否有 healthy Key（但无令牌） ---
      const healthyEntries = this.entries.filter(e => e.status === 'healthy')

      if (healthyEntries.length > 0) {
        // 所有 healthy Key 无令牌 → 等待最先补充的 TokenBucket
        const waitMs = this._shortestTokenWait(healthyEntries)
        await new Promise(r => setTimeout(r, waitMs))
        continue
      }

      // --- 所有 Key 均 cooldown/exhausted → 等待最先恢复的 Key ---
      const waitMs = this._shortestRecoveryWait()
      if (waitMs > 0) {
        await new Promise(r => setTimeout(r, waitMs))
      } else {
        // 安全兜底：至少等 100ms 避免忙循环
        await new Promise(r => setTimeout(r, 100))
      }
    }
  }

  /**
   * Round-Robin 轮询寻找有令牌的 healthy Key。
   * @returns {KeyEntry|null}
   * @private
   */
  _findHealthyKeyWithTokens() {
    const len = this.entries.length
    for (let i = 0; i < len; i++) {
      const idx = (this._currentIndex + i) % len
      const entry = this.entries[idx]

      if (entry.status !== 'healthy') continue

      // 先 refill 再检查令牌
      entry.tokenBucket.refill()
      if (entry.tokenBucket.tokens > 0) {
        entry.tokenBucket.tokens -= 1
        this._currentIndex = (idx + 1) % len
        return entry
      }
    }
    return null
  }

  /**
   * 计算 healthy Key 中最短的令牌等待时间。
   * @param {KeyEntry[]} healthyEntries
   * @returns {number} 等待毫秒数
   * @private
   */
  _shortestTokenWait(healthyEntries) {
    let minWait = Infinity
    for (const entry of healthyEntries) {
      const tb = entry.tokenBucket
      const elapsed = Date.now() - tb.lastRefill
      const remaining = tb.refillInterval - elapsed
      const wait = Math.max(remaining, 0)
      if (wait < minWait) {
        minWait = wait
      }
    }
    // 至少等 1ms 避免忙循环
    return Math.max(minWait, 1)
  }

  /**
   * 计算 cooldown/exhausted Key 中最短的恢复等待时间。
   * @returns {number} 等待毫秒数
   * @private
   */
  _shortestRecoveryWait() {
    const now = Date.now()
    let minWait = Infinity

    for (const entry of this.entries) {
      if (entry.status === 'cooldown' && entry.cooldownEndTime) {
        const wait = entry.cooldownEndTime.getTime() - now
        if (wait < minWait) minWait = wait
      } else if (entry.status === 'exhausted' && entry.exhaustedResetTime) {
        const wait = entry.exhaustedResetTime.getTime() - now
        if (wait < minWait) minWait = wait
      }
    }

    return minWait === Infinity ? 100 : Math.max(minWait, 1)
  }

  /**
   * 构建 acquireKey 返回对象。
   * @param {KeyEntry} entry
   * @returns {{ key: string, tokenBucket: TokenBucket, reportResult: Function }}
   * @private
   */
  _buildResult(entry) {
    return {
      key: entry.key,
      tokenBucket: entry.tokenBucket,
      reportResult: entry.reportResult.bind(entry),
    }
  }

  /**
   * 获取 Key 总数。
   * @returns {number}
   */
  getKeyCount() {
    return this.entries.length
  }

  /**
   * 获取 healthy 状态的 Key 数量。
   * @returns {number}
   */
  getHealthyKeyCount() {
    return this.entries.filter(e => e.status === 'healthy').length
  }

  /**
   * 获取所有 KeyEntry 的脱敏统计信息。
   * 每个条目包含 maskedKey、status、error429Count、totalRequests 和当前可用令牌数。
   *
   * @returns {Array<{ maskedKey: string, status: string, error429Count: number, totalRequests: number, availableTokens: number }>}
   */
  getStats() {
    return this.entries.map(entry => {
      entry.tokenBucket.refill()
      return {
        maskedKey: entry.maskedKey,
        status: entry.status,
        error429Count: entry.error429Count,
        totalRequests: entry.totalRequests,
        availableTokens: Math.floor(entry.tokenBucket.tokens),
      }
    })
  }

}

// ==================== Key 解析 ====================

/**
 * 从环境变量解析 Google API Key 列表。
 * 优先级：FURNIAI_GEMINI_API_KEYS > FURNIAI_GEMINI_API_KEY
 *
 * 注意：G3PRO_API_KEY 是 G3Pro 代理通道的密钥，不能放入 Google KeyPool，
 * 否则调用 Google 官方 REST API 会 401 失败。
 *
 * - FURNIAI_GEMINI_API_KEYS 为逗号分隔的多 Key 字符串
 * - 解析时 trim 并过滤空字符串
 * - 无有效 Key 时返回空数组（调用方应优雅降级到其他通道）
 *
 * @returns {string[]} 有效的 API Key 数组
 */
function parseKeys() {
  const multiKeys = process.env.FURNIAI_GEMINI_API_KEYS
  const singleKey = process.env.FURNIAI_GEMINI_API_KEY

  let raw = ''
  if (multiKeys) {
    raw = multiKeys
  } else if (singleKey) {
    raw = singleKey
  }

  const keys = raw
    .split(',')
    .map(k => k.trim())
    .filter(k => k.length > 0)

  if (keys.length === 0) {
    console.warn(
      '[FurnIAI KeyPool] 未找到 Google API Key（FURNIAI_GEMINI_API_KEYS / FURNIAI_GEMINI_API_KEY 未配置），Google 通道不可用'
    )
    return []
  }

  console.log(`[FurnIAI KeyPool] Loaded ${keys.length} API key(s)`)

  return keys
}

// ==================== 单例 ====================

let _instance = null

/**
 * 获取 KeyPool 单例实例。
 * 首次调用时通过 parseKeys() 加载 Key 并创建 KeyPool，后续调用返回缓存实例。
 *
 * @returns {KeyPool}
 */
function getInstance() {
  if (!_instance) {
    const keys = parseKeys()
    // 没有 Google API Key 时返回 null，调用方应降级到其他通道
    if (keys.length === 0) return null
    _instance = new KeyPool({ keys })
  }
  return _instance
}

// ==================== Exports ====================

module.exports = {
  parseKeys,
  maskKey,
  KeyEntry,
  KeyPool,
  getInstance,
}
