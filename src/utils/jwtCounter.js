/**
 * JWT 调用计数器 — 独立于平台密钥的实时调用统计
 * 
 * 使用 MongoDB 原子操作 $inc 确保并发安全
 * 存储在 jwtcallstats 集合的单个文档中
 */
const mongoose = require('mongoose')

const COLLECTION = 'jwtcallstats'
const DOC_ID = 'jwt_global'

// 获取 UTC+8 时区今日日期字符串 YYYY-MM-DD
function getTodayCST() {
    const now = new Date()
    const cst = new Date(now.getTime() + 8 * 60 * 60 * 1000)
    return cst.toISOString().slice(0, 10)
}

/**
 * 记录一次成功调用（单条聚合管道 update，原子操作，无竞态）
 */
async function recordSuccess() {
    const today = getTodayCST()
    const col = mongoose.connection.db.collection(COLLECTION)
    // 使用聚合管道 update：单次原子操作判断日期是否切换并更新计数
    await col.updateOne(
        { _id: DOC_ID },
        [{
            $set: {
                totalCalls: { $add: [{ $ifNull: ['$totalCalls', 0] }, 1] },
                successCalls: { $add: [{ $ifNull: ['$successCalls', 0] }, 1] },
                // 日期匹配 → todayCalls + 1；日期不匹配 → 重置为 1
                todayCalls: {
                    $cond: {
                        if: { $eq: ['$todayDate', today] },
                        then: { $add: [{ $ifNull: ['$todayCalls', 0] }, 1] },
                        else: 1
                    }
                },
                todayDate: today,
                lastCallAt: new Date(),
            }
        }],
        { upsert: true }
    )
}

/**
 * 记录一次失败调用（单条聚合管道 update，原子操作，无竞态）
 */
async function recordFailure() {
    const today = getTodayCST()
    const col = mongoose.connection.db.collection(COLLECTION)
    await col.updateOne(
        { _id: DOC_ID },
        [{
            $set: {
                totalCalls: { $add: [{ $ifNull: ['$totalCalls', 0] }, 1] },
                failedCalls: { $add: [{ $ifNull: ['$failedCalls', 0] }, 1] },
                todayCalls: {
                    $cond: {
                        if: { $eq: ['$todayDate', today] },
                        then: { $add: [{ $ifNull: ['$todayCalls', 0] }, 1] },
                        else: 1
                    }
                },
                todayDate: today,
                lastCallAt: new Date(),
            }
        }],
        { upsert: true }
    )
}

/**
 * 读取 JWT 调用统计
 */
async function getStats() {
    const col = mongoose.connection.db.collection(COLLECTION)
    const doc = await col.findOne({ _id: DOC_ID })
    if (!doc) return { totalCalls: 0, todayCalls: 0, successCalls: 0, failedCalls: 0 }
    const today = getTodayCST()
    return {
        totalCalls: doc.totalCalls || 0,
        // 日期不匹配时今日计数归零
        todayCalls: doc.todayDate === today ? (doc.todayCalls || 0) : 0,
        successCalls: doc.successCalls || 0,
        failedCalls: doc.failedCalls || 0,
        lastCallAt: doc.lastCallAt || null,
    }
}

module.exports = { recordSuccess, recordFailure, getStats }
