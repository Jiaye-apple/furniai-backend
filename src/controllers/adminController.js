/**
 * AdminController — 管理面板API控制器
 * 提供配置查询/更新、用量统计、通道测试、模型获取、任务列表、平台密钥管理等接口
 */
const axios = require('axios')
const jwt = require('jsonwebtoken')
const configManager = require('../services/configManager')
const taskQueue = require('../services/taskQueue')
const FurniaiTask = require('../models/FurniaiTask')
const SkuAiTask = require('../models/SkuAiTask')
const AiCredit = require('../models/AiCredit')
const PlatformKey = require('../models/PlatformKey')
const ApiEndpoint = require('../models/ApiEndpoint')
const jwtCounter = require('../utils/jwtCounter')

// ==================== 辅助函数 ====================

/**
 * Token 脱敏显示
 */
const { maskToken } = require('../utils/mask')

/**
 * 脱敏配置中的敏感字段（返回给前端时使用）
 */
function maskConfig(config) {
    const masked = JSON.parse(JSON.stringify(config))

    // 脱敏通道Key
    if (masked.channelPriority) {
        for (const ch of masked.channelPriority) {
            if (ch.apiKey) ch.apiKey = maskToken(ch.apiKey)
            if (ch.backupKey) ch.backupKey = maskToken(ch.backupKey)
        }
    }

    // 脱敏Google Keys
    if (masked.googleApiKeys) {
        masked.googleApiKeys = masked.googleApiKeys.map(k => maskToken(k))
    }

    // 移除MongoDB内部字段
    delete masked._id
    delete masked.__v
    delete masked.key

    return masked
}

// ==================== 接口: 获取全部配置 ====================

exports.getConfig = async (req, res) => {
    try {
        const config = configManager.get()
        // 永远返回脱敏数据，敏感Key不暴露给前端
        return res.json({ success: true, data: maskConfig(config) })
    } catch (err) {
        console.error('[Admin] getConfig error:', err.message)
        return res.status(500).json({ success: false, message: err.message })
    }
}

// ==================== 接口: 更新配置（热更新） ====================

exports.updateConfig = async (req, res) => {
    try {
        const patch = req.body
        if (!patch || Object.keys(patch).length === 0) {
            return res.status(400).json({ success: false, message: '请求体为空' })
        }

        // 不允许修改的字段
        delete patch._id
        delete patch.__v
        delete patch.key
        delete patch.createdAt
        delete patch.updatedAt

        // 合并通道Key：前端提交的脱敏值（含****）不能覆盖原始值
        if (patch.channelPriority && Array.isArray(patch.channelPriority)) {
            const origChannels = configManager.get().channelPriority || []
            for (const ch of patch.channelPriority) {
                const orig = origChannels.find(o => o.id === ch.id)
                if (!orig) continue
                // apiKey 含 **** 或为空 → 保留原值
                if (!ch.apiKey || ch.apiKey.includes('****')) ch.apiKey = orig.apiKey
                if (!ch.backupKey || ch.backupKey.includes('****')) ch.backupKey = orig.backupKey
            }
        }

        // 合并 Google API Keys：脱敏值不覆盖
        if (patch.googleApiKeys && Array.isArray(patch.googleApiKeys)) {
            const origKeys = configManager.get().googleApiKeys || []
            patch.googleApiKeys = patch.googleApiKeys.map((k, i) => {
                return (k && k.includes('****') && origKeys[i]) ? origKeys[i] : k
            })
        }

        const updated = await configManager.update(patch)
        console.log('[Admin] 配置已更新:', Object.keys(patch).join(', '))
        return res.json({ success: true, data: maskConfig(updated) })
    } catch (err) {
        console.error('[Admin] updateConfig error:', err.message)
        return res.status(500).json({ success: false, message: err.message })
    }
}

// ==================== 接口: 用量统计 ====================

/** 统计数据缓存（避免高频polling反复执行重量级聚合查询） */
let _statsCache = null
let _statsCacheTime = 0
const STATS_CACHE_TTL = 10 * 1000  // 10秒缓存

exports.getStats = async (req, res) => {
    try {
        // 缓存命中：10秒内直接返回
        const now = Date.now()
        if (_statsCache && (now - _statsCacheTime) < STATS_CACHE_TTL) {
            return res.json({ success: true, data: _statsCache })
        }

        // 今日起始时间
        const todayStart = new Date()
        todayStart.setHours(0, 0, 0, 0)

        // 积分统计（聚合所有用户）
        const creditAgg = await AiCredit.aggregate([
            {
                $group: {
                    _id: null,
                    totalConsumed: { $sum: '$totalConsumed' },
                    totalRecharged: { $sum: '$totalRecharged' },
                    totalBalance: { $sum: '$balance' },
                    userCount: { $sum: 1 },
                }
            }
        ])
        const credits = creditAgg[0] || { totalConsumed: 0, totalRecharged: 0, totalBalance: 0, userCount: 0 }

        // 任务统计——同时查询 FurniaiTask 和 SkuAiTask 两个集合
        const facetPipeline = [{
            $facet: {
                total: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
                today: [{ $match: { createdAt: { $gte: todayStart } } }, { $count: 'count' }],
                imageCount: [{ $unwind: '$items' }, { $match: { 'items.status': 'completed' } }, { $count: 'count' }],
                todayImages: [{ $match: { createdAt: { $gte: todayStart } } }, { $unwind: '$items' }, { $match: { 'items.status': 'completed' } }, { $count: 'count' }],
                duration: [
                    { $match: { startedAt: { $ne: null }, completedAt: { $ne: null } } },
                    { $project: { durationMs: { $subtract: ['$completedAt', '$startedAt'] } } },
                    { $group: { _id: null, totalDurationMs: { $sum: '$durationMs' }, avgDurationMs: { $avg: '$durationMs' }, count: { $sum: 1 } } }
                ],
                taskTypeDistribution: [{ $unwind: '$items' }, { $group: { _id: '$items.taskType', count: { $sum: 1 } } }, { $sort: { count: -1 } }],
            }
        }]

        const [furniaiAgg, skuAgg] = await Promise.all([
            FurniaiTask.aggregate(facetPipeline),
            SkuAiTask.aggregate(facetPipeline),
        ])

        const f = furniaiAgg[0] || {}
        const s = skuAgg[0] || {}

        // 合并状态分布
        const statusMap = {}
        for (const item of [...(f.total || []), ...(s.total || [])]) {
            statusMap[item._id] = (statusMap[item._id] || 0) + item.count
        }
        const totalTasks = Object.values(statusMap).reduce((a, b) => a + b, 0)
        const succeededTasks = statusMap['succeeded'] || 0

        // 合并用时
        const fd = (f.duration || [])[0] || { totalDurationMs: 0, count: 0 }
        const sd = (s.duration || [])[0] || { totalDurationMs: 0, count: 0 }
        const totalDurCount = fd.count + sd.count
        const totalDurMs = fd.totalDurationMs + sd.totalDurationMs

        // 合并taskType分布
        const typeMap = {}
        for (const item of [...(f.taskTypeDistribution || []), ...(s.taskTypeDistribution || [])]) {
            typeMap[item._id] = (typeMap[item._id] || 0) + item.count
        }
        const taskTypeDistribution = Object.entries(typeMap).map(([_id, count]) => ({ _id, count })).sort((a, b) => b.count - a.count)

        // 平台密钥统计 + JWT 独立计数器
        const [platformStats, jwtStats] = await Promise.all([
            PlatformKey.find({}, 'name status stats createdAt').lean(),
            jwtCounter.getStats(),
        ])

        const stats = {
            credits: {
                totalConsumed: credits.totalConsumed,
                totalRecharged: credits.totalRecharged,
                totalBalance: credits.totalBalance,
                userCount: credits.userCount,
            },
            tasks: {
                total: totalTasks,
                today: ((f.today || [])[0]?.count || 0) + ((s.today || [])[0]?.count || 0),
                statusDistribution: statusMap,
                successRate: totalTasks > 0 ? Math.round((succeededTasks / totalTasks) * 1000) / 10 : 0,
            },
            images: {
                total: ((f.imageCount || [])[0]?.count || 0) + ((s.imageCount || [])[0]?.count || 0),
                today: ((f.todayImages || [])[0]?.count || 0) + ((s.todayImages || [])[0]?.count || 0),
            },
            duration: {
                totalMs: totalDurMs,
                avgMs: totalDurCount > 0 ? Math.round(totalDurMs / totalDurCount) : 0,
                completedCount: totalDurCount,
            },
            taskTypeDistribution,
            platformStats: platformStats.map(p => ({
                name: p.name,
                status: p.status,
                totalCalls: p.stats?.totalCalls || 0,
                successCalls: p.stats?.successCalls || 0,
                failedCalls: p.stats?.failedCalls || 0,
                totalCredits: p.stats?.totalCredits || 0,
                todayCalls: p.stats?.todayCalls || 0,
                lastCallAt: p.stats?.lastCallAt,
            })),
            // JWT 独立计数器统计（实时计数，与平台密钥分开展示）
            jwtStats,
            queue: (() => {
                const q = taskQueue.getQueueStats()
                // 用 DB 聚合结果修正内存计数，确保准确（服务重启后内存归零但 DB 不变）
                q.running = Math.max(q.running, statusMap['running'] || 0)
                q.pending = Math.max(q.pending, statusMap['pending'] || 0)
                return q
            })(),
        }
        // 写入缓存
        _statsCache = stats
        _statsCacheTime = Date.now()

        return res.json({ success: true, data: stats })
    } catch (err) {
        console.error('[Admin] getStats error:', err.message)
        return res.status(500).json({ success: false, message: err.message })
    }
}

// ==================== 接口: 实时状态（队列/Key池/通道） ====================

exports.getStatus = async (req, res) => {
    try {
        const queue = taskQueue.getQueueStats()

        // 从 DB 查询实际 running/pending 任务数（内存计数器在服务重启后会归零，DB 才是真实来源）
        const [dbRunning, dbPending] = await Promise.all([
            FurniaiTask.countDocuments({ status: 'running' }).then(c1 =>
                SkuAiTask.countDocuments({ status: 'running' }).then(c2 => c1 + c2)
            ),
            FurniaiTask.countDocuments({ status: 'pending' }).then(c1 =>
                SkuAiTask.countDocuments({ status: 'pending' }).then(c2 => c1 + c2)
            ),
        ])
        // 取内存计数与 DB 计数的较大值，确保准确性
        queue.running = Math.max(queue.running, dbRunning)
        queue.pending = Math.max(queue.pending, dbPending)

        // 尝试获取Key池状态
        let keyPoolStats = []
        try {
            const { getInstance } = require('../services/keyPool')
            const pool = getInstance()
            keyPoolStats = pool.getStats()
        } catch (e) {
            // Key池未初始化
        }

        return res.json({
            success: true,
            data: {
                queue,
                keyPool: keyPoolStats,
                config: maskConfig(configManager.get()),
                // 系统信息
                nodeVersion: process.version,
                uptime: Math.floor(process.uptime()),
                memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
            }
        })
    } catch (err) {
        console.error('[Admin] getStatus error:', err.message)
        return res.status(500).json({ success: false, message: err.message })
    }
}

// ==================== 接口: 获取端点可用模型列表 ====================

exports.getModels = async (req, res) => {
    try {
        let { url, apiKey, protocol, channelIndex } = req.body

        if (!url) {
            return res.status(400).json({ success: false, message: '缺少 url 参数' })
        }
        url = url.trim().replace(/\/+$/, '') // 移除尾部多余的斜杠

        // 如果前端没传 apiKey 但传了 channelIndex，从真实配置读取原始 Key
        // （前端拿到的 Key 是脱敏后的，含 ****，无法直接使用）
        let resolvedKey = apiKey || ''
        if (!resolvedKey && channelIndex !== undefined && channelIndex !== null) {
            const idx = parseInt(channelIndex)
            const channels = configManager.get().channelPriority || []
            if (channels[idx] && channels[idx].apiKey) {
                resolvedKey = channels[idx].apiKey
            }
        }

        let modelsUrl = ''
        let headers = { 'Content-Type': 'application/json' }
        let models = []

        if (protocol === 'google') {  // openrouter 走 else 分支（同 openai：GET /v1/models）
            // Google 端点格式：GET /v1beta/models?key=xxx
            // 若 url 自身带有 ?key=，则不再拼接
            modelsUrl = url.includes('?key=') ? `${url.split('?')[0]}/v1beta/models?key=${url.split('key=')[1]}` : `${url}/v1beta/models?key=${resolvedKey}`

            const resp = await axios.get(modelsUrl, { timeout: 15000, validateStatus: () => true })
            if (resp.status === 200 && resp.data?.models) {
                models = resp.data.models.map(m => ({
                    id: m.name?.replace('models/', '') || m.name,
                    name: m.displayName || m.name,
                }))
            } else {
                console.error('[Admin] getModels Google Failed:', resp.status, resp.data)
                throw new Error(resp.data?.error?.message || `HTTP ${resp.status}`)
            }
        } else {
            // OpenAI / Anthropic 格式：GET /v1/models
            modelsUrl = `${url}/v1/models`
            if (resolvedKey) {
                headers['Authorization'] = `Bearer ${resolvedKey}`
            }
            const resp = await axios.get(modelsUrl, { headers, timeout: 15000, validateStatus: () => true })
            if (resp.status === 200 && resp.data?.data) {
                models = resp.data.data.map(m => ({
                    id: m.id,
                    name: m.id,
                }))
            } else {
                console.error(`[Admin] getModels ${protocol} Failed:`, resp.status, resp.data)
                throw new Error(resp.data?.error?.message || `HTTP ${resp.status}`)
            }
        }

        return res.json({ success: true, data: models })
    } catch (err) {
        console.error('[Admin] getModels error:', err.message)
        return res.status(500).json({ success: false, message: `获取模型列表失败: ${err.message}` })
    }
}

// ==================== 接口: 任务列表 (支持分页与详情) ====================

exports.getRecentTasks = async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 20, 100)
        const page = Math.max(parseInt(req.query.page) || 1, 1)
        const skip = (page - 1) * limit

        // 使用 aggregation 跨合并两个集合（furniaitasks 和 skuaitasks），实现准确分页
        const pipeline = [
            {
                $unionWith: {
                    coll: 'skuaitasks'
                }
            },
            {
                $sort: { createdAt: -1 }
            },
            {
                $facet: {
                    metadata: [{ $count: "total" }],
                    data: [
                        { $skip: skip },
                        { $limit: limit },
                        {
                            $project: {
                                _id: 1,
                                requestId: 1,
                                operatorId: 1,
                                source: 1,
                                status: 1,
                                progress: 1,
                                startedAt: 1,
                                completedAt: 1,
                                createdAt: 1,
                                error: 1,
                                retryCount: 1,
                                modelUsed: 1,
                                channel: 1,
                                'options.channel': 1,
                                'options.model': 1,
                                'options.userContext': 1,
                                'options.style': 1,
                                'referenceImages': 1,
                                'items.taskType': 1,
                                'items.status': 1,
                                'items.prompt': 1,
                                'items.imageModel': 1,
                                'items.resultFileId': 1,
                                'items.resultBase64': 1,
                                'items.resultText': 1,
                                'items.error': 1,
                                'items.startedAt': 1,
                                'items.completedAt': 1,
                                'timeline': 1
                            }
                        }
                    ]
                }
            }
        ]

        const result = await FurniaiTask.aggregate(pipeline).allowDiskUse(true)

        const total = result[0]?.metadata?.[0] ? result[0].metadata[0].total : 0
        const allTasks = result[0]?.data || []

        // 格式化输出
        const simplifiedTasks = allTasks.map(t => {
            const items = t.items || []
            // 计算耗时
            let durationMs = null
            if (t.startedAt && t.completedAt) {
                durationMs = new Date(t.completedAt) - new Date(t.startedAt)
            }

            return {
                _id: t._id,
                requestId: t.requestId,
                status: t.status,
                progress: t.progress,
                itemCount: items.length,
                completedCount: items.filter(i => i.status === 'completed').length,
                failedCount: items.filter(i => i.status === 'failed').length,
                taskTypes: [...new Set(items.map(i => i.taskType))],
                channel: t.options?.channel || t.channel || 'auto',
                modelUsed: t.modelUsed || t.options?.model || null,
                platform: t.operatorId?.toString()?.startsWith('platform:') ? t.operatorId.toString().replace('platform:', '') : 'JWT',
                durationMs,
                error: t.error,
                retryCount: t.retryCount,
                createdAt: t.createdAt,
                referenceImages: t.referenceImages || [],
                userContext: t.options?.userContext || '',
                style: t.options?.style || '',
                // 用于前端展开详情
                items: items,
                timeline: t.timeline || [],
            }
        })

        return res.json({
            success: true,
            data: {
                tasks: simplifiedTasks,
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit)
            }
        })
    } catch (err) {
        console.error('[Admin] getRecentTasks error:', err.message)
        return res.status(500).json({ success: false, message: err.message })
    }
}

// ==================== 接口: 批量删除任务 ====================
exports.batchDeleteTasks = async (req, res) => {
    try {
        const { taskIds } = req.body
        if (!Array.isArray(taskIds) || taskIds.length === 0) {
            return res.status(400).json({ success: false, message: '请提供要删除的任务 ID 数组' })
        }

        // 同时在两个集合中删除（任务列表是 $unionWith 合并展示的）
        const [r1, r2] = await Promise.all([
            FurniaiTask.deleteMany({ _id: { $in: taskIds } }),
            SkuAiTask.deleteMany({ _id: { $in: taskIds } }),
        ])
        const deletedCount = (r1.deletedCount || 0) + (r2.deletedCount || 0)

        return res.json({
            success: true,
            message: `成功删除 ${deletedCount} 条任务记录`,
            deletedCount
        })

    } catch (err) {
        console.error('[Admin] batchDeleteTasks error:', err.message)
        return res.status(500).json({ success: false, message: err.message })
    }
}

// ==================== 接口: 重载配置（从DB刷新内存缓存） ====================

exports.reloadConfig = async (req, res) => {
    try {
        await configManager.init()
        console.log('[Admin] 配置已从DB重载')
        return res.json({ success: true, message: '配置已重载' })
    } catch (err) {
        console.error('[Admin] reloadConfig error:', err.message)
        return res.status(500).json({ success: false, message: err.message })
    }
}

// ==================== 登录安全：IP 失败次数 & 永久拉黑（MongoDB持久化） ====================

const BannedIP = require('../models/BannedIP')

/** 记录每个IP的登录失败次数（内存，仅用于计数） */
const loginFailCount = new Map()
/** 每小时清理一次失败计数，防止大量不同IP试探导致内存无限增长 */
setInterval(() => {
    if (loginFailCount.size > 0) {
        console.log(`[Admin] 定时清理登录失败计数: ${loginFailCount.size} 条`)
        loginFailCount.clear()
    }
}, 60 * 60 * 1000)
/** 已拉黑的IP集合（内存缓存，启动时从DB加载） */
const bannedIPsCache = new Set()
/** 连续失败多少次后永久拉黑 */
const MAX_LOGIN_FAILURES = 5
/** 喵提醒推送ID（可通过环境变量覆盖） */
const MIAO_PUSH_ID = process.env.MIAO_PUSH_ID || 'tfDCynD'

/**
 * 启动时从 MongoDB 加载所有已拉黑IP到内存缓存
 * 在 server.js 或 app.js 启动后调用
 */
exports.loadBannedIPs = async () => {
    try {
        const docs = await BannedIP.find({}, { ip: 1 }).lean()
        for (const doc of docs) {
            bannedIPsCache.add(doc.ip)
        }
        if (docs.length > 0) {
            console.log(`[Admin] 已从DB加载 ${docs.length} 个拉黑IP`)
        }
    } catch (err) {
        console.error('[Admin] 加载拉黑IP列表失败:', err.message)
    }
}

/**
 * 获取客户端真实IP（兼容反向代理）
 */
function getClientIP(req) {
    // X-Forwarded-For 可能有多个IP，取第一个（最近的客户端）
    const xff = req.headers['x-forwarded-for']
    if (xff) return xff.split(',')[0].trim()
    return req.ip || req.connection?.remoteAddress || 'unknown'
}

/**
 * 通过喵提醒发送微信通知（异步，不阻塞登录响应）
 */
async function sendMiaoPush(text) {
    try {
        const url = `http://miaotixing.com/trigger?id=${MIAO_PUSH_ID}&text=${encodeURIComponent(text)}`
        await axios.get(url, { timeout: 10000 })
        console.log('[Admin] 喵提醒推送成功')
    } catch (err) {
        console.error('[Admin] 喵提醒推送失败:', err.message)
    }
}

// ==================== 接口: 管理员登录 ====================

exports.login = async (req, res) => {
    try {
        const clientIP = getClientIP(req)

        // 如果IP已被拉黑，静默返回登录失败（不泄露拉黑信息）
        if (bannedIPsCache.has(clientIP)) {
            console.log(`[Admin] 已拉黑IP尝试登录: ${clientIP}`)
            return res.status(401).json({ success: false, message: '账号或密码错误' })
        }

        const { username, password } = req.body

        if (!username || !password) {
            return res.status(400).json({ success: false, message: '请输入账号和密码' })
        }

        // 管理员账号密码（必须通过环境变量配置，不提供默认值）
        const adminUser = process.env.ADMIN_USERNAME
        const adminPass = process.env.ADMIN_PASSWORD
        if (!adminUser || !adminPass) {
            console.error('[Admin] ⛔ 环境变量 ADMIN_USERNAME / ADMIN_PASSWORD 未设置，无法登录')
            return res.status(500).json({ success: false, message: '服务配置异常，请联系管理员' })
        }

        if (username !== adminUser || password !== adminPass) {
            // 累计失败次数
            const fails = (loginFailCount.get(clientIP) || 0) + 1
            loginFailCount.set(clientIP, fails)
            console.log(`[Admin] 登录失败: ${username} | IP: ${clientIP} | 第${fails}次`)

            // 达到上限，永久拉黑
            if (fails >= MAX_LOGIN_FAILURES) {
                // 写入内存缓存
                bannedIPsCache.add(clientIP)
                loginFailCount.delete(clientIP)

                // 持久化到 MongoDB（异步，不阻塞响应）
                BannedIP.create({
                    ip: clientIP,
                    reason: `连续${fails}次登录失败`,
                    lastUsername: username,
                    failCount: fails,
                }).catch(err => console.error('[Admin] 保存拉黑IP到DB失败:', err.message))

                console.log(`[Admin] ⛔ IP已被永久拉黑: ${clientIP}（连续${fails}次登录失败）`)

                // 微信推送通知管理员（异步，不阻塞响应）
                const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
                sendMiaoPush(`⚠️ FurniAI管理后台安全警报\n\nIP: ${clientIP} 已被永久拉黑\n原因: 连续${fails}次登录失败\n最后尝试账号: ${username}\n时间: ${now}`)
            }

            return res.status(401).json({ success: false, message: '账号或密码错误' })
        }

        // 登录成功，清除该IP的失败计数（但不解除拉黑）
        loginFailCount.delete(clientIP)

        // 签发管理员 JWT（30天有效）
        const token = jwt.sign(
            { username, role: 'admin' },
            process.env.JWT_SECRET,
            { expiresIn: '30d' }
        )

        console.log(`[Admin] 管理员登录成功: ${username} | IP: ${clientIP}`)
        return res.json({ success: true, data: { token, username, expiresIn: '30天' } })
    } catch (err) {
        console.error('[Admin] login error:', err.message)
        return res.status(500).json({ success: false, message: err.message })
    }
}

// ==================== 接口: 测试喵提醒推送 ====================

exports.testMiaoPush = async (req, res) => {
    try {
        const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
        const text = req.body?.text || `🔔 FurniAI推送测试\n\n这是一条测试消息，确认喵提醒推送功能正常。\n时间: ${now}`
        await sendMiaoPush(text)
        return res.json({ success: true, message: '推送已发送，请检查微信' })
    } catch (err) {
        console.error('[Admin] testMiaoPush error:', err.message)
        return res.status(500).json({ success: false, message: err.message })
    }
}

// ==================== 平台鉴权密钥管理 ====================

/**
 * 获取所有平台密钥列表
 */
exports.listPlatformKeys = async (req, res) => {
    try {
        const keys = await PlatformKey.find().sort({ createdAt: -1 }).lean()
        // 返回脱敏后的密钥列表，同时暴露 keyMasked/keyFull 供前端切换显示
        const masked = keys.map(k => ({
            ...k,
            keyMasked: maskToken(k.key),  // 脱敏版，前端默认显示
            keyFull: k.key,               // 完整版，前端点击眼睛按钮时显示
            key: maskToken(k.key),        // 兼容保留
        }))
        return res.json({ success: true, data: masked })
    } catch (err) {
        console.error('[Admin] listPlatformKeys error:', err.message)
        return res.status(500).json({ success: false, message: err.message })
    }
}

/**
 * 创建新平台密钥
 */
exports.createPlatformKey = async (req, res) => {
    try {
        const { name, remark, rateLimit, customKey } = req.body
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, message: '平台名称不能为空' })
        }

        // 用户自定义密钥（自动加 pk- 前缀），留空则自动生成
        let key = customKey && customKey.trim()
            ? (customKey.trim().startsWith('pk-') ? customKey.trim() : 'pk-' + customKey.trim())
            : PlatformKey.generateKey()

        // 检查密钥是否重复
        const exists = await PlatformKey.findOne({ key })
        if (exists) {
            return res.status(400).json({ success: false, message: '密钥已存在，请换一个' })
        }

        const doc = await PlatformKey.create({
            name: name.trim(),
            key,
            remark: remark || '',
            rateLimit: parseInt(rateLimit) || 0,
        })

        console.log(`[Admin] 平台密钥已创建: ${name} → ${maskToken(key)}`)
        return res.status(201).json({
            success: true,
            data: {
                _id: doc._id,
                name: doc.name,
                key: doc.key,  // 创建时返回完整密钥
                status: doc.status,
                remark: doc.remark,
                rateLimit: doc.rateLimit,
                createdAt: doc.createdAt,
            },
            message: '平台密钥创建成功，请妥善保管密钥'
        })
    } catch (err) {
        console.error('[Admin] createPlatformKey error:', err.message)
        return res.status(500).json({ success: false, message: err.message })
    }
}

/**
 * 更新平台密钥（名称/状态/备注/限流）
 * 如果修改了名称，会同步更新所有关联任务的 operatorId（大盘显示跟着变）
 */
exports.updatePlatformKey = async (req, res) => {
    try {
        const { id } = req.params
        const { name, status, remark, rateLimit } = req.body

        const doc = await PlatformKey.findById(id)
        if (!doc) return res.status(404).json({ success: false, message: '密钥不存在' })

        // 记录旧名称，用于批量更新关联任务
        const oldName = doc.name

        if (name !== undefined) doc.name = name.trim()
        if (status !== undefined) doc.status = status
        if (remark !== undefined) doc.remark = remark
        if (rateLimit !== undefined) doc.rateLimit = parseInt(rateLimit) || 0

        await doc.save()

        // 平台名称改变时，批量更新 FurniaiTask 的 operatorId（大盘显示跟着变）
        // 注意：SkuAiTask.operatorId 是 ObjectId 类型（存真实用户ID），不存 platform:xxx 字符串，跳过
        if (name !== undefined && name.trim() !== oldName) {
            const oldOperatorId = 'platform:' + oldName
            const newOperatorId = 'platform:' + name.trim()
            const fResult = await FurniaiTask.updateMany(
                { operatorId: oldOperatorId },
                { operatorId: newOperatorId }
            )
            console.log(`[Admin] 平台改名: ${oldName} → ${name.trim()}，已更新 ${fResult.modifiedCount || 0} 条关联任务`)
        }

        console.log(`[Admin] 平台密钥已更新: ${doc.name} (${doc.status})`)
        return res.json({ success: true, data: doc, message: '更新成功' })
    } catch (err) {
        console.error('[Admin] updatePlatformKey error:', err.message)
        return res.status(500).json({ success: false, message: err.message })
    }
}

/**
 * 删除平台密钥
 */
exports.deletePlatformKey = async (req, res) => {
    try {
        const { id } = req.params
        const doc = await PlatformKey.findByIdAndDelete(id)
        if (!doc) return res.status(404).json({ success: false, message: '密钥不存在' })

        console.log(`[Admin] 平台密钥已删除: ${doc.name}`)
        return res.json({ success: true, message: `已删除密钥: ${doc.name}` })
    } catch (err) {
        console.error('[Admin] deletePlatformKey error:', err.message)
        return res.status(500).json({ success: false, message: err.message })
    }
}

/**
 * 重新生成平台密钥（旧密钥立即失效）
 */
exports.regeneratePlatformKey = async (req, res) => {
    try {
        const { id } = req.params
        const doc = await PlatformKey.findById(id)
        if (!doc) return res.status(404).json({ success: false, message: '密钥不存在' })

        const oldKeyMasked = maskToken(doc.key)
        doc.key = PlatformKey.generateKey()
        await doc.save()

        console.log(`[Admin] 平台密钥已重新生成: ${doc.name} (旧: ${oldKeyMasked})`)
        return res.json({
            success: true,
            data: { _id: doc._id, name: doc.name, key: doc.key },
            message: '密钥已重新生成，旧密钥立即失效'
        })
    } catch (err) {
        console.error('[Admin] regeneratePlatformKey error:', err.message)
        return res.status(500).json({ success: false, message: err.message })
    }
}
// ==================== 接口: 流式输出 GridFS 文件（图片预览） ====================
const { pipeline } = require('stream')
const FileService = require('../services/fileService')

exports.serveFile = async (req, res) => {
    try {
        const { fileId } = req.params
        const { stream, mimeType, filename } = await FileService.getFile(fileId)
        res.set('Content-Type', mimeType || 'image/png')
        res.set('Content-Disposition', `inline; filename="${filename}"`)
        res.set('Cache-Control', 'public, max-age=86400') // 缓存1天
        // 使用 pipeline 自动传播错误并正确关闭流
        pipeline(stream, res, (err) => {
            if (err && !res.headersSent) {
                console.error(`[Admin] serveFile stream error: ${err.message}`)
                res.status(500).json({ success: false, message: '文件读取失败' })
            }
        })
    } catch (err) {
        console.error(`[Admin] serveFile error: ${err.message}`)
        return res.status(404).json({ success: false, message: '文件不存在' })
    }
}

// ==================== 接口: 成本核算报表 ====================

// 分析类任务类型（使用 analysisCost 计费）
const ANALYSIS_TASK_TYPES = new Set([
    'analyze', 'material-analyze', 'detect-elements', 'excel-headers', 'excel-row'
])

/**
 * 成本核算报表
 * GET /admin/api/cost-report?startDate=&endDate=
 * 按通道×模型、按平台两个维度聚合，结合配置计算成本/收入/利润
 */
exports.getCostReport = async (req, res) => {
    try {
        const config = configManager.get()
        const creditUnitPrice = config?.creditUnitPrice ?? 0.1
        const modelCosts = config?.modelCosts || {}
        const creditCosts = config?.creditCosts || {}

        // 日期范围（默认配置中的核算起点，或近30天）
        const accountingStartDate = config?.accountingStartDate ? new Date(config.accountingStartDate) : null;
        const endDate = req.query.endDate ? new Date(req.query.endDate + 'T23:59:59+08:00') : new Date()

        let startDate = req.query.startDate
            ? new Date(req.query.startDate + 'T00:00:00+08:00')
            : new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000)

        // 如果没有传入明确的 startDate，且后台配置了核算起点，则以配置的核算起点为准，丢弃之前的历史数据
        if (!req.query.startDate && accountingStartDate && accountingStartDate > startDate) {
            startDate = accountingStartDate;
        }

        // 今日起止（UTC+8）
        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
        const todayStart = new Date(todayStr + 'T00:00:00+08:00')
        const todayEnd = new Date(todayStr + 'T23:59:59+08:00')

        // ========== 聚合1：按 通道×模型×任务类型 分组 ==========
        const byChannelModelAgg = await FurniaiTask.aggregate([
            { $match: { status: 'succeeded', createdAt: { $gte: startDate, $lte: endDate } } },
            { $unwind: '$items' },
            { $match: { 'items.status': 'completed' } },
            {
                $group: {
                    _id: {
                        channel: { $ifNull: ['$options.channel', 'unknown'] },
                        model: { $ifNull: ['$modelUsed', 'unknown'] },
                        taskType: '$items.taskType',
                    },
                    count: { $sum: 1 },
                }
            }
        ])

        // ========== 聚合2：按平台分组统计 ==========
        const byPlatformAgg = await FurniaiTask.aggregate([
            { $match: { status: 'succeeded', createdAt: { $gte: startDate, $lte: endDate } } },
            { $unwind: '$items' },
            { $match: { 'items.status': 'completed' } },
            {
                $group: {
                    _id: '$operatorId',
                    totalCalls: { $sum: 1 },
                    // 按任务类型数组收集，后续在代码中计算积分
                    taskTypes: { $push: '$items.taskType' },
                }
            }
        ])

        // ========== 聚合3：今日成本（同样按通道×模型） ==========
        const todayAgg = await FurniaiTask.aggregate([
            { $match: { status: 'succeeded', createdAt: { $gte: todayStart, $lte: todayEnd } } },
            { $unwind: '$items' },
            { $match: { 'items.status': 'completed' } },
            {
                $group: {
                    _id: {
                        channel: { $ifNull: ['$options.channel', 'unknown'] },
                        model: { $ifNull: ['$modelUsed', 'unknown'] },
                        taskType: '$items.taskType',
                    },
                    count: { $sum: 1 },
                }
            }
        ])

        // ========== 获取通道名称映射 ==========
        const channelPriority = config?.channelPriority || []
        const channelNameMap = {}
        for (const ch of channelPriority) {
            channelNameMap[ch.id] = ch.name || ch.id
        }

        // ========== 代码层计算：按通道×模型聚合成本 ==========
        const channelModelMap = {}  // key: "channel:model"
        let totalCost = 0, totalImages = 0, totalAnalysis = 0, totalRevenue = 0

        for (const row of byChannelModelAgg) {
            const { channel, model, taskType } = row._id
            const isAnalysis = ANALYSIS_TASK_TYPES.has(taskType)
            const costKey = `${channel}:${model}`
            const costConfig = modelCosts[costKey] || { cost: 0 }
            const unitCost = costConfig.cost !== undefined ? costConfig.cost : (costConfig.imageCost || costConfig.analysisCost || 0)
            const rowCost = unitCost * row.count
            // 收入 = 积分 × 积分单价
            const creditPerTask = creditCosts[taskType] || 0
            const rowRevenue = creditPerTask * row.count * creditUnitPrice

            // 汇总到 channelModel 维度
            if (!channelModelMap[costKey]) {
                channelModelMap[costKey] = {
                    channel, model,
                    channelName: channelNameMap[channel] || channel,
                    images: 0, analysis: 0, cost: 0, revenue: 0,
                }
            }
            if (isAnalysis) {
                channelModelMap[costKey].analysis += row.count
                totalAnalysis += row.count
            } else {
                channelModelMap[costKey].images += row.count
                totalImages += row.count
            }
            channelModelMap[costKey].cost += rowCost
            channelModelMap[costKey].revenue += rowRevenue
            totalCost += rowCost
            totalRevenue += rowRevenue
        }

        // 每组补利润
        const byChannelModel = Object.values(channelModelMap).map(item => ({
            ...item,
            cost: Math.round(item.cost * 100) / 100,
            revenue: Math.round(item.revenue * 100) / 100,
            profit: Math.round((item.revenue - item.cost) * 100) / 100,
        }))

        // ========== 代码层计算：今日成本 ==========
        let todayCost = 0
        for (const row of todayAgg) {
            const { channel, model, taskType } = row._id
            const isAnalysis = ANALYSIS_TASK_TYPES.has(taskType)
            const costKey = `${channel}:${model}`
            const costConfig = modelCosts[costKey] || { cost: 0 }
            const unitCost = costConfig.cost !== undefined ? costConfig.cost : (costConfig.imageCost || costConfig.analysisCost || 0)
            todayCost += unitCost * row.count
        }

        // ========== 代码层计算：按平台聚合 ==========
        const byPlatform = byPlatformAgg.map(row => {
            const operatorId = row._id || 'unknown'
            // 计算该平台消耗的积分和收入
            let credits = 0
            for (const tt of row.taskTypes) {
                credits += creditCosts[tt] || 0
            }
            const revenue = Math.round(credits * creditUnitPrice * 100) / 100
            // 平台名从 operatorId 提取（格式 "platform:名称" 或原始值）
            const name = operatorId.startsWith('platform:') ? operatorId.replace('platform:', '') : operatorId
            return {
                name,
                calls: row.totalCalls,
                credits,
                revenue,
            }
        })

        // ========== 汇总 ==========
        totalCost = Math.round(totalCost * 100) / 100
        totalRevenue = Math.round(totalRevenue * 100) / 100
        todayCost = Math.round(todayCost * 100) / 100
        const totalProfit = Math.round((totalRevenue - totalCost) * 100) / 100
        const profitRate = totalRevenue > 0 ? Math.round(totalProfit / totalRevenue * 1000) / 10 : 0

        return res.json({
            success: true,
            data: {
                config: { creditUnitPrice, modelCosts },
                summary: { totalRevenue, totalCost, totalProfit, profitRate, todayCost, totalImages, totalAnalysis },
                byChannelModel,
                byPlatform,
                dateRange: { startDate: startDate.toISOString(), endDate: endDate.toISOString() },
            }
        })
    } catch (err) {
        console.error('[Admin] getCostReport error:', err.message)
        return res.status(500).json({ success: false, message: '成本核算报表加载失败: ' + err.message })
    }
}

// ==================== API 接口管理 ====================

/**
 * 系统内置接口列表（硬编码，不可编辑/删除）
 * 按模块分组，展示所有对外暴露的 API 接口
 */
const BUILTIN_ENDPOINTS = [
    // ── Furniai 生图模块 ──
    { module: 'Furniai 生图', name: '获取配置', method: 'GET', path: '/api/ai/furniai/config', description: '获取AI生图模块公开配置', auth: '公开' },
    { module: 'Furniai 生图', name: '图片分析', method: 'POST', path: '/api/ai/furniai/analyze', description: '分析家具图片，识别类型和特征', auth: '平台密钥', promptId: 'analyze' },
    { module: 'Furniai 生图', name: '深度分析', method: 'POST', path: '/api/ai/furniai/deep-analyze', description: '深度分析家具图片（材质/工艺/卖点/场景匹配等）', auth: '平台密钥', promptId: 'deep-analyze' },
    { module: 'Furniai 生图', name: '家具部件检测', method: 'POST', path: '/api/ai/furniai/detect-elements', description: '检测图片中的家具部件和元素', auth: '平台密钥', promptId: 'detect-elements' },
    { module: 'Furniai 生图', name: '材质分析', method: 'POST', path: '/api/ai/furniai/material/analyze', description: '分析家具材质信息', auth: '平台密钥', promptId: 'material-analyze' },
    { module: 'Furniai 生图', name: '白底图生成', method: 'POST', path: '/api/ai/furniai/generate', description: '生成纯白背景产品图（taskType=white-bg）', auth: '平台密钥', promptId: 'white-bg' },
    { module: 'Furniai 生图', name: '场景图生成', method: 'POST', path: '/api/ai/furniai/generate', description: '生成家具在真实场景中的效果图（taskType=scene）', auth: '平台密钥', promptId: 'scene' },
    { module: 'Furniai 生图', name: '多视图・正面', method: 'POST', path: '/api/ai/furniai/generate', description: '生成产品正面视角照片（taskType=multi-view:front）', auth: '平台密钥', promptId: 'multi-view-front' },
    { module: 'Furniai 生图', name: '多视图・45°', method: 'POST', path: '/api/ai/furniai/generate', description: '生成产品45°角视角照片（taskType=multi-view:angle-45）', auth: '平台密钥', promptId: 'multi-view-angle45' },
    { module: 'Furniai 生图', name: '多视图・侧面', method: 'POST', path: '/api/ai/furniai/generate', description: '生成产品侧面视角照片（taskType=multi-view:side）', auth: '平台密钥', promptId: 'multi-view-side' },
    { module: 'Furniai 生图', name: '多视图・背面', method: 'POST', path: '/api/ai/furniai/generate', description: '生成产品背面视角照片（taskType=multi-view:back）', auth: '平台密钥', promptId: 'multi-view-back' },
    { module: 'Furniai 生图', name: '多视图・材质特写', method: 'POST', path: '/api/ai/furniai/generate', description: '材质纹理微距拍摄（taskType=multi-view:detail-texture）', auth: '平台密钥', promptId: 'multi-view-texture' },
    { module: 'Furniai 生图', name: '多视图・工艺特写', method: 'POST', path: '/api/ai/furniai/generate', description: '工艺细节微距拍摄（taskType=multi-view:detail-craft）', auth: '平台密钥', promptId: 'multi-view-craft' },
    { module: 'Furniai 生图', name: '多视图・拼图', method: 'POST', path: '/api/ai/furniai/generate', description: '4-6视角合成产品目录图（taskType=multi-view:collage）', auth: '平台密钥', promptId: 'multi-view-collage' },
    { module: 'Furniai 生图', name: '尺寸标注图', method: 'POST', path: '/api/ai/furniai/generate', description: '生成带尺寸标注线的技术图（taskType=dimensions）', auth: '平台密钥', promptId: 'dimensions' },
    { module: 'Furniai 生图', name: '六视图', method: 'POST', path: '/api/ai/furniai/generate', description: '生成前/后/左/右/上/下六面视图（taskType=six-views）', auth: '平台密钥', promptId: 'six-views' },
    { module: 'Furniai 生图', name: '剖面图', method: 'POST', path: '/api/ai/furniai/generate', description: '生成内部结构剖面/爆炸图（taskType=cross-section）', auth: '平台密钥', promptId: 'cross-section' },
    { module: 'Furniai 生图', name: '三视图', method: 'POST', path: '/api/ai/furniai/generate', description: '生成正/侧/俯三视图布局（taskType=cad-views）', auth: '平台密钥', promptId: 'cad-views' },
    { module: 'Furniai 生图', name: '比例尺图', method: 'POST', path: '/api/ai/furniai/generate', description: '生成精确比例尺寸技术图（taskType=scale-drawing）', auth: '平台密钥', promptId: 'scale-drawing' },
    { module: 'Furniai 生图', name: '双图融合・默认', method: 'POST', path: '/api/ai/furniai/fuse', description: '通用智能融合两张图片（fusionMode=default）', auth: '平台密钥', promptId: 'fusion-default' },
    { module: 'Furniai 生图', name: '双图融合・严格放置', method: 'POST', path: '/api/ai/furniai/fuse', description: '保持透视角度不变的产品放置（fusionMode=strict）', auth: '平台密钥', promptId: 'fusion-strict' },
    { module: 'Furniai 生图', name: '双图融合・智能提取', method: 'POST', path: '/api/ai/furniai/fuse', description: '提取产品并自然放入场景（fusionMode=extract）', auth: '平台密钥', promptId: 'fusion-extract' },
    { module: 'Furniai 生图', name: '双图融合・风格迁移', method: 'POST', path: '/api/ai/furniai/fuse', description: '将第一张图的品质风格应用到第二张（fusionMode=quality）', auth: '平台密钥', promptId: 'fusion-quality' },
    { module: 'Furniai 生图', name: '材质贴图替换', method: 'POST', path: '/api/ai/furniai/material/apply', description: '将指定材质应用到家具图片上', auth: '平台密钥', promptId: 'material-apply' },
    { module: 'Furniai 生图', name: 'AI 修图・带参考图', method: 'POST', path: '/api/ai/furniai/edit', description: '根据参考图和指令修改图片', auth: '平台密钥', promptId: 'edit-with-ref' },
    { module: 'Furniai 生图', name: 'AI 修图・无参考图', method: 'POST', path: '/api/ai/furniai/edit', description: '仅根据文字指令修改图片', auth: '平台密钥', promptId: 'edit-no-ref' },
    { module: 'Furniai 生图', name: 'Excel 表头分析', method: 'POST', path: '/api/ai/furniai/excel/analyze-headers', description: '分析 Excel 表头结构', auth: '平台密钥', promptId: 'excel-headers' },
    { module: 'Furniai 生图', name: 'Excel 行解析', method: 'POST', path: '/api/ai/furniai/excel/parse-row', description: '解析 Excel 单行数据', auth: '平台密钥', promptId: 'excel-row' },
    { module: 'Furniai 生图', name: '执行计划优化', method: 'POST', path: '/api/ai/furniai/refine-plan', description: '优化生图执行计划', auth: '平台密钥', promptId: 'execution-plan' },
    { module: 'Furniai 生图', name: '单元素分割', method: 'POST', path: '/api/ai/furniai/segment-element', description: '从图片中分割出单个元素', auth: '平台密钥', promptId: 'segment-element' },
    { module: 'Furniai 生图', name: '电商卖点生成', method: 'POST', path: '/api/ai/furniai/selling-points', description: '根据家具图片生成电商卖点文案', auth: '平台密钥', promptId: 'selling-points' },
    { module: 'Furniai 生图', name: '画布描述提取', method: 'POST', path: '/api/ai/furniai/canvas-prompt', description: '从画布内容提取文字描述', auth: '平台密钥', promptId: 'canvas-prompt' },
    { module: 'Furniai 生图', name: '批量任务提交', method: 'POST', path: '/api/ai/furniai/batch/submit', description: '提交批量生图任务（白底图/场景图等）', auth: '平台密钥', promptId: 'white-bg / scene' },
    { module: 'Furniai 生图', name: '批量任务列表', method: 'GET', path: '/api/ai/furniai/batch', description: '查询批量任务列表', auth: '平台密钥' },
    { module: 'Furniai 生图', name: '批量任务详情', method: 'GET', path: '/api/ai/furniai/batch/:taskId', description: '查询指定批量任务状态', auth: '平台密钥' },
    { module: 'Furniai 生图', name: '批量任务重试', method: 'POST', path: '/api/ai/furniai/batch/:taskId/retry', description: '重试失败的批量任务', auth: '平台密钥' },
    { module: 'Furniai 生图', name: '批量任务取消', method: 'POST', path: '/api/ai/furniai/batch/:taskId/cancel', description: '取消批量任务', auth: '平台密钥' },

    // ── 小程序 AI 模块 ──
    { module: '小程序 AI', name: '风格选项', method: 'GET', path: '/api/ai/miniapp/config/styles', description: '获取可用风格列表', auth: '公开' },
    { module: '小程序 AI', name: '空间选项', method: 'GET', path: '/api/ai/miniapp/config/spaces', description: '获取可用空间类型列表', auth: '公开' },
    { module: '小程序 AI', name: '面料选项', method: 'GET', path: '/api/ai/miniapp/config/fabrics', description: '获取可用面料列表', auth: '公开' },
    { module: '小程序 AI', name: '颜色选项', method: 'GET', path: '/api/ai/miniapp/config/colors', description: '获取可用颜色列表', auth: '公开' },
    { module: '小程序 AI', name: '场景模板列表', method: 'GET', path: '/api/ai/miniapp/scene-templates', description: '获取场景模板列表', auth: '公开' },
    { module: '小程序 AI', name: '素材列表', method: 'GET', path: '/api/ai/miniapp/materials', description: '获取用户素材列表', auth: '平台密钥' },
    { module: '小程序 AI', name: '保存素材', method: 'POST', path: '/api/ai/miniapp/materials', description: '保存一个素材', auth: '平台密钥' },
    { module: '小程序 AI', name: '批量删除素材', method: 'DELETE', path: '/api/ai/miniapp/materials/batch', description: '批量删除素材', auth: '平台密钥' },
    { module: '小程序 AI', name: '删除素材', method: 'DELETE', path: '/api/ai/miniapp/materials/:id', description: '删除指定素材', auth: '平台密钥' },
    { module: '小程序 AI', name: '图片分析', method: 'POST', path: '/api/ai/miniapp/analyze', description: '小程序端图片分析', auth: '平台密钥' },
    { module: '小程序 AI', name: '生成图片', method: 'POST', path: '/api/ai/miniapp/generate', description: '小程序端生成图片', auth: '平台密钥' },
    { module: '小程序 AI', name: '上传图片', method: 'POST', path: '/api/ai/miniapp/upload-image', description: '上传图片文件（multipart/form-data）', auth: '平台密钥' },
    { module: '小程序 AI', name: '积分查询', method: 'GET', path: '/api/ai/miniapp/credits', description: '查询当前用户积分余额', auth: '平台密钥' },
    { module: '小程序 AI', name: '积分历史', method: 'GET', path: '/api/ai/miniapp/credits/history', description: '查询积分变动历史', auth: '平台密钥' },
    { module: '小程序 AI', name: '创建场景模板', method: 'POST', path: '/api/ai/miniapp/scene-templates', description: '创建新场景模板', auth: '平台密钥' },
    { module: '小程序 AI', name: '更新场景模板', method: 'PUT', path: '/api/ai/miniapp/scene-templates/:id', description: '更新指定场景模板', auth: '平台密钥' },
    { module: '小程序 AI', name: '删除场景模板', method: 'DELETE', path: '/api/ai/miniapp/scene-templates/:id', description: '删除指定场景模板', auth: '平台密钥' },
    { module: '小程序 AI', name: '使用到商品', method: 'POST', path: '/api/ai/miniapp/use-in-product', description: '将生成结果应用到商品', auth: '平台密钥' },

    // ── SKU 批量生图模块 ──
    { module: 'SKU 批量生图', name: '提交批量生图', method: 'POST', path: '/api/ai/sku-ai/submit', description: '提交 SKU 批量生图任务', auth: '平台密钥' },
    { module: 'SKU 批量生图', name: '查询单个任务', method: 'GET', path: '/api/ai/sku-ai/tasks/:taskId', description: '查询指定 SKU 批量任务', auth: '平台密钥' },
    { module: 'SKU 批量生图', name: '任务列表', method: 'GET', path: '/api/ai/sku-ai/tasks', description: '获取 SKU 批量任务列表', auth: '平台密钥' },
    { module: 'SKU 批量生图', name: '队列状态', method: 'GET', path: '/api/ai/sku-ai/queue-stats', description: '获取队列运行状态统计', auth: '平台密钥' },
    { module: 'SKU 批量生图', name: '重试失败任务', method: 'POST', path: '/api/ai/sku-ai/tasks/:taskId/retry', description: '重试整个失败任务', auth: '平台密钥' },
    { module: 'SKU 批量生图', name: '重试子项', method: 'POST', path: '/api/ai/sku-ai/tasks/:taskId/items/:itemId/retry', description: '重试单个失败子项', auth: '平台密钥' },

    // ── 代理透传模块 ──
    { module: '代理透传', name: 'AI 代理透传', method: 'ALL', path: '/proxy/*', description: '通用 AI 接口透传代理，支持通道降级和统计', auth: '平台密钥' },

    // ── 健康检查 ──
    { module: '系统', name: '健康检查', method: 'GET', path: '/health', description: '服务健康状态检查（版本/队列/Gemini）', auth: '公开' },
]

/**
 * 获取所有 API 接口列表（内置 + 用户自定义）
 */
exports.listApiEndpoints = async (req, res) => {
    try {
        const custom = await ApiEndpoint.find().sort({ createdAt: -1 }).lean()
        return res.json({
            success: true,
            data: {
                builtin: BUILTIN_ENDPOINTS,
                custom: custom,
            }
        })
    } catch (err) {
        console.error('[Admin] listApiEndpoints error:', err.message)
        return res.status(500).json({ success: false, message: err.message })
    }
}

/**
 * 手动创建 API 接口
 */
exports.createApiEndpoint = async (req, res) => {
    try {
        const { name, slug, description, prompt, referenceImages, channelId, model, promptParams } = req.body
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, message: '接口名称不能为空' })
        }

        // slug 自动生成或校验唯一性
        const finalSlug = (slug && slug.trim()) || ApiEndpoint.generateSlug(name.trim())
        const exists = await ApiEndpoint.findOne({ slug: finalSlug })
        if (exists) {
            return res.status(400).json({ success: false, message: `slug "${finalSlug}" 已被占用，请换一个` })
        }

        const doc = await ApiEndpoint.create({
            name: name.trim(),
            slug: finalSlug,
            description: description || '',
            prompt: prompt || '',
            referenceImages: referenceImages || [],
            channelId: channelId || 'auto',
            model: model || '',
            promptParams: Array.isArray(promptParams) ? promptParams : [],
        })

        console.log(`[Admin] API接口已创建: ${doc.name} (${doc.slug})`)
        return res.status(201).json({ success: true, data: doc, message: '接口创建成功' })
    } catch (err) {
        console.error('[Admin] createApiEndpoint error:', err.message)
        return res.status(500).json({ success: false, message: err.message })
    }
}

/**
 * 从任务记录提炼为 API 接口（核心功能）
 * 读取任务的 prompt、referenceImages、options，填充到 ApiEndpoint 中
 */
exports.extractApiEndpoint = async (req, res) => {
    try {
        const { taskId, name, slug, description, prompt, channelId, model, promptParams } = req.body
        if (!taskId) {
            return res.status(400).json({ success: false, message: '缺少 taskId 参数' })
        }

        // 查找任务（同时查两个集合）
        let task = await FurniaiTask.findById(taskId).lean()
        if (!task) {
            task = await SkuAiTask.findById(taskId).lean()
        }
        if (!task) {
            return res.status(404).json({ success: false, message: '任务不存在' })
        }

        // 提取第一个 completed 的 item 的 prompt（或合并所有 prompt）
        const items = task.items || []
        const completedItems = items.filter(i => i.status === 'completed')
        // 优先取第一个已完成 item 的 prompt
        const extractedPrompt = completedItems[0]?.prompt || task.options?.userContext || ''

        // 生成名称和 slug
        const finalName = (name && name.trim()) || `接口-${new Date().toLocaleDateString('en-CA')}`
        const finalSlug = (slug && slug.trim()) || ApiEndpoint.generateSlug(finalName)

        // 检查 slug 唯一性
        const exists = await ApiEndpoint.findOne({ slug: finalSlug })
        if (exists) {
            return res.status(400).json({ success: false, message: `slug "${finalSlug}" 已被占用，请换一个` })
        }

        const doc = await ApiEndpoint.create({
            name: finalName,
            slug: finalSlug,
            description: description || `从任务 ${task.requestId || taskId} 提炼`,
            prompt: (prompt !== undefined && prompt !== null) ? prompt : extractedPrompt,
            referenceImages: task.referenceImages || [],
            channelId: channelId || 'auto',
            model: model || '',
            promptParams: Array.isArray(promptParams) ? promptParams : [],
            sourceTaskId: taskId,
        })

        console.log(`[Admin] 从任务提炼API接口: ${doc.name} (${doc.slug}) ← 任务 ${taskId}`)
        return res.status(201).json({
            success: true,
            data: doc,
            message: '接口提炼成功',
            // 返回提炼的原始数据，供前端预览/编辑
            extracted: {
                prompt: extractedPrompt,
                referenceImageCount: (task.referenceImages || []).length,
                channel: task.options?.channel || 'auto',
                model: task.modelUsed || '',
                taskStatus: task.status,
            }
        })
    } catch (err) {
        console.error('[Admin] extractApiEndpoint error:', err.message)
        return res.status(500).json({ success: false, message: err.message })
    }
}

/**
 * 更新 API 接口（编辑提示词/配置/文档）
 */
exports.updateApiEndpoint = async (req, res) => {
    try {
        const { id } = req.params
        const { name, slug, description, status, prompt, referenceImages, channelId, model, promptParams } = req.body

        const doc = await ApiEndpoint.findById(id)
        if (!doc) return res.status(404).json({ success: false, message: '接口不存在' })

        // 如果修改了 slug，检查唯一性
        if (slug !== undefined && slug.trim() !== doc.slug) {
            const exists = await ApiEndpoint.findOne({ slug: slug.trim() })
            if (exists) {
                return res.status(400).json({ success: false, message: `slug "${slug.trim()}" 已被占用` })
            }
            doc.slug = slug.trim()
        }

        if (name !== undefined) doc.name = name.trim()
        if (description !== undefined) doc.description = description
        if (status !== undefined) doc.status = status
        if (prompt !== undefined) doc.prompt = prompt
        if (referenceImages !== undefined) doc.referenceImages = referenceImages
        if (channelId !== undefined) doc.channelId = channelId
        if (model !== undefined) doc.model = model
        if (promptParams !== undefined) doc.promptParams = Array.isArray(promptParams) ? promptParams : []

        await doc.save()

        console.log(`[Admin] API接口已更新: ${doc.name} (${doc.slug})`)
        return res.json({ success: true, data: doc, message: '更新成功' })
    } catch (err) {
        console.error('[Admin] updateApiEndpoint error:', err.message)
        return res.status(500).json({ success: false, message: err.message })
    }
}

/**
 * 删除 API 接口
 */
exports.deleteApiEndpoint = async (req, res) => {
    try {
        const { id } = req.params
        const doc = await ApiEndpoint.findByIdAndDelete(id)
        if (!doc) return res.status(404).json({ success: false, message: '接口不存在' })

        console.log(`[Admin] API接口已删除: ${doc.name} (${doc.slug})`)
        return res.json({ success: true, message: `已删除接口: ${doc.name}` })
    } catch (err) {
        console.error('[Admin] deleteApiEndpoint error:', err.message)
        return res.status(500).json({ success: false, message: err.message })
    }
}

/**
 * 获取接口对接文档（自动生成）
 * 根据接口配置动态生成调用地址、参数说明、示例代码
 */
exports.getApiEndpointDoc = async (req, res) => {
    try {
        const { id } = req.params
        const doc = await ApiEndpoint.findById(id)
        if (!doc) return res.status(404).json({ success: false, message: '接口不存在' })

        // 从请求中获取 baseUrl（优先用 X-Forwarded-Proto + Host，兼容反代）
        const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https'
        const host = req.headers['x-forwarded-host'] || req.headers['host'] || ''
        const baseUrl = req.query.baseUrl || `${proto}://${host}`

        const generatedDoc = doc.generateDoc(baseUrl)
        return res.json({ success: true, data: generatedDoc })
    } catch (err) {
        console.error('[Admin] getApiEndpointDoc error:', err.message)
        return res.status(500).json({ success: false, message: err.message })
    }
}
