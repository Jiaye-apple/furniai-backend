const FurniaiTask = require('../models/FurniaiTask')
const SkuAiTask = require('../models/SkuAiTask')
const taskQueue = require('./taskQueue')
const adminController = require('../controllers/adminController')
const PlatformKey = require('../models/PlatformKey')

/**
 * 通用遗留任务重调度函数（私有模块级）
 * 服务重启时将遗留的 running/queued 任务重新入队或修正状态
 */
async function redispatchTasks(tasks, Model, taskType, taskQueue, now) {
    if (!tasks || tasks.length === 0) return

    const bulkOps = []

    for (const t of tasks) {
        // 跳过 proxy/api 路由创建的任务
        if (t.source === 'api') {
            bulkOps.push({
                updateOne: {
                    filter: { _id: t._id },
                    update: { $set: { status: 'failed', error: '服务重启时 proxy 任务中断（前端已收到响应）', completedAt: now, updatedAt: now } }
                }
            })
            taskQueue.pushTimeline(t._id, taskType, 'auto_fix', `服务重启：proxy 遗留任务标记为 failed（前端已独立收到响应）`)
            continue
        }

        const processableItems = (t.items || []).filter(i => i.status !== 'skipped')
        const completedItems = processableItems.filter(i => i.status === 'completed' || i.status === 'succeeded')
        if (completedItems.length === processableItems.length) {
            console.log(`[FurnIAI] 遗留任务 ${t._id} 所有子项均已处理（或跳过），修正状态为 succeeded`)
            // 补充可能在中断前未写入的任务级字段（channel、model）
            const fixFields = { status: 'succeeded', progress: 100, completedAt: now, updatedAt: now }
            // 从 options.channel / modelUsed 检查是否已有值，没有则尝试从已有配置回填
            if (!t.options?.channel || t.options.channel === 'auto') {
                const configManager = require('./configManager')
                const activeChannels = configManager.get('channelPriority')?.filter(c => c.enabled) || []
                const primaryCh = activeChannels[0]
                if (primaryCh) {
                    fixFields['options.channel'] = primaryCh.name
                    if (!t.modelUsed) fixFields.modelUsed = primaryCh.imageModel || null
                }
            }
            bulkOps.push({
                updateOne: {
                    filter: { _id: t._id },
                    update: { $set: fixFields }
                }
            })
            taskQueue.pushTimeline(t._id, taskType, 'auto_fix', `服务重启检测：所有需要处理的子项皆已完毕，修正状态为 succeeded（原状态: ${t.status}）`)
            continue
        }

        const itemUpdates = {}
        if (t.items) {
            t.items.forEach((item, idx) => {
                if (item.status === 'processing') {
                    itemUpdates[`items.${idx}.status`] = 'pending'
                    itemUpdates[`items.${idx}.startedAt`] = null
                }
            })
        }
        bulkOps.push({
            updateOne: {
                filter: { _id: t._id },
                update: { $set: { status: 'queued', updatedAt: now, ...itemUpdates } }
            }
        })
        taskQueue.pushTimeline(t._id, taskType, 'redispatch', `服务重启后自动重新入队调度（原状态: ${t.status}）`)
        taskQueue.enqueue(t._id, taskType)
    }

    if (bulkOps.length > 0) {
        await Model.bulkWrite(bulkOps)
    }
}

/**
 * 执行所有一次性启动校验、补偿与初始化任务
 */
async function runInitializations() {
    // 1. 启动自检：将遗留的 running/queued 任务重新入队调度
    // ⚠️ 开发模式下跳过，避免本地实例抢走线上正在处理的任务
    if (process.env.NODE_ENV !== 'production') {
        console.log('[FurnIAI] ⏭️ 开发模式：跳过遗留任务重调度（避免与线上冲突）')
    } else try {
        const now = new Date()
        const [stuckFurniai, stuckSku] = await Promise.all([
            FurniaiTask.find({ status: { $in: ['running', 'queued'] } }, '_id status items source').lean(),
            SkuAiTask.find({ status: { $in: ['running', 'queued'] } }, '_id status items source').lean(),
        ])
        const total = stuckFurniai.length + stuckSku.length

        if (total > 0) {
            console.log(`[FurnIAI] 🔄 发现 ${total} 个遗留任务（running/queued），正在重新入队调度...`)
            await redispatchTasks(stuckFurniai, FurniaiTask, 'furniai', taskQueue, now)
            await redispatchTasks(stuckSku, SkuAiTask, 'skuai', taskQueue, now)
            console.log(`[FurnIAI] ✅ ${total} 个遗留任务已重新入队（furniai: ${stuckFurniai.length}, skuai: ${stuckSku.length}）`)
        }
    } catch (e) {
        console.error('[FurnIAI] 遗留任务重新调度失败:', e.message)
    }

    // 2. 从DB加载已拉黑IP到内存缓存
    try {
        await adminController.loadBannedIPs()
    } catch (e) {
        console.error('[FurnIAI] 已拉黑IP加载失败:', e.message)
    }

    // 3. 自动初始化"商城接口"平台密钥
    try {
        const existing = await PlatformKey.findOne({ name: '商城接口' })
        if (!existing) {
            const [fAgg, sAgg] = await Promise.all([
                FurniaiTask.aggregate([{
                    $facet: {
                        ok: [{ $unwind: '$items' }, { $match: { 'items.status': 'completed' } }, { $count: 'c' }],
                        fail: [{ $unwind: '$items' }, { $match: { 'items.status': 'failed' } }, { $count: 'c' }],
                    }
                }]),
                SkuAiTask.aggregate([{
                    $facet: {
                        ok: [{ $unwind: '$items' }, { $match: { 'items.status': 'completed' } }, { $count: 'c' }],
                        fail: [{ $unwind: '$items' }, { $match: { 'items.status': 'failed' } }, { $count: 'c' }],
                    }
                }])
            ])
            const successCalls = ((fAgg[0]?.ok || [])[0]?.c || 0) + ((sAgg[0]?.ok || [])[0]?.c || 0)
            const failedCalls = ((fAgg[0]?.fail || [])[0]?.c || 0) + ((sAgg[0]?.fail || [])[0]?.c || 0)
            const doc = await PlatformKey.create({
                name: '商城接口',
                key: PlatformKey.generateKey(),
                status: 'active',
                remark: '小迪严选商城后端 (xiaodiyanxuan.com) — 历史数据已自动回填',
                stats: {
                    totalCalls: successCalls + failedCalls,
                    successCalls, failedCalls,
                    totalCredits: successCalls * 20,
                    todayCalls: 0, todayDate: '', lastCallAt: new Date(),
                }
            })
            console.log(`[FurnIAI] ✅ 商城接口密钥已自动创建: ${doc.key.slice(0, 12)}... (历史: ${successCalls} 成功, ${failedCalls} 失败)`)
        }
    } catch (e) {
        console.error('[FurnIAI] 商城接口密钥初始化失败:', e.message)
    }
}

module.exports = {
    runInitializations
}
