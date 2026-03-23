/**
 * FurnIAI — 平台鉴权密钥模型
 * 用于管理外部平台对接 AI 生图服务的 API Key
 */
const mongoose = require('mongoose')
const crypto = require('crypto')

const platformKeySchema = new mongoose.Schema({
    // 平台名称（用户自定义，如"商城"、"小程序"）
    name: { type: String, required: true, trim: true },
    // 密钥值（pk- 前缀 + 随机字符串，唯一索引）
    key: { type: String, required: true, unique: true, index: true },
    // 状态：active 启用 / disabled 禁用
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
    // 每分钟请求上限（0 = 不限制）
    rateLimit: { type: Number, default: 0 },
    // 备注说明
    remark: { type: String, default: '' },
    // 是否为 JWT 调用的默认统计密钥（全局仅一个为 true，JWT 调用自动归入此密钥统计）
    isJwtDefault: { type: Boolean, default: false },

    // ========== 统计信息 ==========
    stats: {
        totalCalls: { type: Number, default: 0 },       // 总调用次数
        successCalls: { type: Number, default: 0 },      // 成功次数
        failedCalls: { type: Number, default: 0 },       // 失败次数
        totalCredits: { type: Number, default: 0 },      // 总消耗积分
        todayCalls: { type: Number, default: 0 },        // 今日调用次数
        todayDate: { type: String, default: '' },        // 今日日期标记（YYYY-MM-DD）
        lastCallAt: { type: Date, default: null },       // 最后调用时间
    },
}, {
    timestamps: true,  // 自动 createdAt / updatedAt
})

// 添加唯一过滤索引：全局尽允许一条记录的 isJwtDefault 为 true
platformKeySchema.index(
    { isJwtDefault: 1 },
    { unique: true, partialFilterExpression: { isJwtDefault: true } }
)

/**
 * 生成 pk- 前缀的随机密钥
 */
platformKeySchema.statics.generateKey = function () {
    return 'pk-' + crypto.randomBytes(24).toString('hex')
}

/**
 * 获取 UTC+8 时区的今日日期字符串 YYYY-MM-DD
 */
function getTodayCST() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
}

/**
 * 内部方法：安全更新统计数据（处理跨日并发原子锁逻辑）
 * @param {boolean} isSuccess - 是否成功
 * @param {number} credits - 本次消耗积分
 */
platformKeySchema.methods._updateStats = async function (isSuccess, credits = 0) {
    const today = getTodayCST()
    const Model = this.constructor

    // 动态构建基本增量
    const baseInc = {
        'stats.totalCalls': 1,
        [isSuccess ? 'stats.successCalls' : 'stats.failedCalls']: 1
    }
    if (isSuccess && credits > 0) {
        baseInc['stats.totalCredits'] = credits
    }

    // 1. 同日状态直接递增 (覆盖 99% 的最频繁请求场景)
    const r = await Model.updateOne(
        { _id: this._id, 'stats.todayDate': today },
        {
            $inc: { ...baseInc, 'stats.todayCalls': 1 },
            $set: { 'stats.lastCallAt': new Date() }
        }
    )

    if (r.matchedCount === 0) {
        // 2. 跨日锁逻辑：增加 $ne 防抢判断。谁第一个跨日，由谁来负责重置
        const resetRes = await Model.updateOne(
            { _id: this._id, 'stats.todayDate': { $ne: today } },
            {
                $inc: baseInc,
                $set: { 'stats.todayCalls': 1, 'stats.todayDate': today, 'stats.lastCallAt': new Date() }
            }
        )
        // 3. 锁争夺失败：极小概率被并发抢占，退化为单纯累加
        if (resetRes.matchedCount === 0) {
            await Model.updateOne(
                { _id: this._id },
                {
                    $inc: { ...baseInc, 'stats.todayCalls': 1 },
                    $set: { 'stats.lastCallAt': new Date() }
                }
            )
        }
    }
}

/**
 * 记录一次成功调用
 * @param {number} credits - 本次消耗的积分
 */
platformKeySchema.methods.recordSuccess = function (credits = 0) {
    return this._updateStats(true, credits)
}

/**
 * 记录一次失败调用（原子操作，并发安全）
 */
platformKeySchema.methods.recordFailure = function () {
    return this._updateStats(false, 0)
}

module.exports = mongoose.model('PlatformKey', platformKeySchema)
