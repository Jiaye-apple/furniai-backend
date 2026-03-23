/**
 * BannedIP — 被拉黑的IP模型
 * 登录失败5次后永久拉黑，持久化到MongoDB
 */
const mongoose = require('mongoose')

const BannedIPSchema = new mongoose.Schema({
    // 被拉黑的IP地址
    ip: { type: String, required: true, unique: true, index: true },
    // 拉黑原因
    reason: { type: String, default: '登录失败次数过多' },
    // 最后一次尝试登录的用户名
    lastUsername: { type: String, default: '' },
    // 累计失败次数（拉黑时的次数）
    failCount: { type: Number, default: 5 },
    // 拉黑时间
    bannedAt: { type: Date, default: Date.now },
})

module.exports = mongoose.model('BannedIP', BannedIPSchema)
