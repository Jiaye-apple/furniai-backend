/**
 * 简单计数信号量 — 用于限制并发执行数量
 * 独立模块，避免 geminiClient ↔ taskQueue 循环依赖
 *
 * acquire() 返回 Promise，有空闲槽位时立即 resolve，否则排队等待
 * release() 释放一个槽位，唤醒下一个等待者
 */
class Semaphore {
    constructor(max) {
        this._max = max
        this._current = 0
        this._waiters = []
    }

    acquire() {
        if (this._current < this._max) {
            this._current++
            return Promise.resolve()
        }
        return new Promise(resolve => {
            this._waiters.push(resolve)
        })
    }

    release() {
        if (this._waiters.length > 0) {
            // 槽位直接转移给下一个等待者，不递减
            const next = this._waiters.shift()
            next()
        } else {
            this._current--
        }
    }
}

module.exports = { Semaphore }
