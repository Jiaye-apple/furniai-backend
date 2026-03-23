/**
 * 参考图分析结果 LRU 缓存
 * 基于 fileId 缓存 analyzeWithText 的结果，避免对同一张参考图重复调用 API
 * capacity 和 ttl 从 configManager 动态读取，前端修改后实时生效
 */

const configManager = require('./configManager')

class AnalysisCache {
  constructor() {
    /** @type {Map<string, { value: any, expiresAt: number }>} */
    this._cache = new Map()
  }

  // 动态读取容量（前端改了立即生效）
  get capacity() { return configManager.get('analysisCacheSize') || 200 }
  // 动态读取 TTL（前端改了立即生效）
  get ttl() { return configManager.get('analysisCacheTTLMs') || 3600000 }

  /**
   * Get cached analysis result by fileId.
   * Returns undefined on miss or expiry. Promotes entry on hit (LRU).
   */
  get(fileId) {
    const entry = this._cache.get(fileId)
    if (!entry) return undefined
    if (Date.now() > entry.expiresAt) {
      this._cache.delete(fileId)
      return undefined
    }
    // LRU: delete and re-insert to move to end (most recently used)
    this._cache.delete(fileId)
    this._cache.set(fileId, entry)
    return entry.value
  }

  /**
   * Store analysis result for a fileId.
   */
  set(fileId, analysis) {
    // If key exists, delete first so re-insert moves it to end
    if (this._cache.has(fileId)) {
      this._cache.delete(fileId)
    }
    // Evict least recently used if at capacity（动态读取 capacity）
    if (this._cache.size >= this.capacity) {
      const oldestKey = this._cache.keys().next().value
      this._cache.delete(oldestKey)
    }
    this._cache.set(fileId, {
      value: analysis,
      expiresAt: Date.now() + this.ttl,
    })
  }

  /**
   * Check if a non-expired entry exists for fileId.
   */
  has(fileId) {
    const entry = this._cache.get(fileId)
    if (!entry) return false
    if (Date.now() > entry.expiresAt) {
      this._cache.delete(fileId)
      return false
    }
    return true
  }

  /** Current number of (non-expired) entries */
  get size() {
    return this._cache.size
  }

  /** Clear all entries */
  clear() {
    this._cache.clear()
  }
}

// Singleton instance
const analysisCache = new AnalysisCache()

module.exports = { AnalysisCache, analysisCache }

