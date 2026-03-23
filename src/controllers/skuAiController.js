const SkuAiTask = require('../models/SkuAiTask')
const taskQueue = require('../services/taskQueue')
// Ensure skuai handler is registered with taskQueue
require('../services/skuAiProcessor')
const { successResponse, errorResponse, paginatedResponse } = require('../utils/response')

// 基础类型列表（保留所有旧类型以兼容）
const VALID_BASE_TYPES = [
  'whiteBg', 'effect', 'dimension', 'multiAngle',
  'crossSection', 'sixViews', 'scaleDrawing', 'video',
]

// 有效子类型映射
const VALID_SUBTYPES = {
  whiteBg: ['front', 'angle-45', 'side', 'back', 'detail-texture', 'detail-craft', 'collage', 'original-hd'],
  effect: ['auto', 'modern', 'new-chinese', 'european', 'wabi-sabi', 'industrial', 'nordic', 'vintage', 'dark-wabi'],
}

/**
 * 校验任务类型是否有效
 * 支持基础类型（如 'whiteBg'）和 baseType:subType 格式（如 'whiteBg:front'）
 */
function isValidTaskType(type) {
  if (VALID_BASE_TYPES.includes(type)) return true
  const [base, sub] = type.split(':')
  if (!VALID_BASE_TYPES.includes(base)) return false
  if (!sub) return true
  const validSubs = VALID_SUBTYPES[base]
  return validSubs ? validSubs.includes(sub) : false
}

// ==================== 接口 ====================

/**
 * 提交批量生图任务
 * POST /api/ai/sku-ai/submit
 */
exports.submitTask = async (req, res) => {
  try {
    const {
      requestId,
      productId,
      skuId,
      skuCode,
      referenceImages,
      taskTypes,
      options = {},
    } = req.body

    // 参数校验
    if (!productId) return res.status(400).json(errorResponse('缺少 productId'))
    if (!skuId) return res.status(400).json(errorResponse('缺少 skuId'))
    if (!referenceImages || !Array.isArray(referenceImages) || referenceImages.length === 0) {
      return res.status(400).json(errorResponse('请上传至少一张参考图'))
    }
    if (!taskTypes || !Array.isArray(taskTypes) || taskTypes.length === 0) {
      return res.status(400).json(errorResponse('请选择至少一种生成类型'))
    }

    // 校验 taskTypes（支持 baseType:subType 格式）
    const invalidTypes = taskTypes.filter(t => !isValidTaskType(t))
    if (invalidTypes.length > 0) {
      return res.status(400).json(errorResponse(`无效的生成类型: ${invalidTypes.join(', ')}`))
    }

    // 幂等检查：10分钟内相同 requestId 返回已有任务
    if (requestId) {
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000)
      const existing = await SkuAiTask.findOne({
        requestId,
        createdAt: { $gte: tenMinAgo },
      })
      if (existing) {
        console.log(`[SkuAI] 幂等命中: requestId=${requestId}, taskId=${existing._id}`)
        return res.json(successResponse({
          taskId: existing._id,
          status: existing.status,
          progress: existing.progress,
          duplicate: true,
        }, '任务已存在（幂等）'))
      }
    }

    // 构建子项
    const items = taskTypes.map(type => ({
      taskType: type,
      status: type === 'video' ? 'skipped' : 'pending',
      error: type === 'video' ? '视频生成暂不支持' : null,
    }))

    // ⚡ 预生成 ObjectId 并注册到 taskQueue 活跃集合
    // 这是为了堵住 Change Stream 竞态窗口：create 写入 DB 后 MongoDB 立即发射 insert 事件，
    // 如果此时 activeTasks 中还没有这个 taskId，Change Stream 会误判为"外部写入"并触发二次调度，
    // 导致 API 被重复调用（浪费费用）且第二次执行的失败结果覆盖第一次的成功状态。
    const mongoose = require('mongoose')
    const preGeneratedId = new mongoose.Types.ObjectId()
    taskQueue.markActive(String(preGeneratedId))

    // 读取当前活跃通道，在任务创建时就写入通道和模型（管理面板立即可见）
    const configManager = require('../services/configManager')
    const activeChannels = configManager.get('channelPriority')?.filter(c => c.enabled) || []
    const primaryCh = activeChannels[0]
    const initialChannel = primaryCh?.name || 'auto'
    const initialModel = primaryCh?.imageModel || null

    // 创建任务（如有平台密钥则关联，供子任务完成后异步更新统计）
    const task = await SkuAiTask.create({
      _id: preGeneratedId,
      requestId: requestId || `auto_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      productId,
      skuId,
      skuCode: skuCode || '',
      operatorId: req.user._id || req.userId,
      source: 'admin_sku',
      referenceImages,
      taskTypes,
      options: {
        style: options.style || '',
        userContext: options.userContext || '',
        enableHD: options.enableHD || false,
        lang: options.lang || 'zh',
        channel: initialChannel,
      },
      modelUsed: initialModel,
      items,
      platformKeyId: req.platformKey?._id || null,
    })

    console.log(`[SkuAI] 任务创建: taskId=${task._id}, skuCode=${skuCode}, types=${taskTypes.join(',')}`)

    // 任务创建即写入 timeline（确保最早的日志从这里开始）
    // 获取客户端 IP
    const xff = req.headers?.['x-forwarded-for']
    const clientIP = xff ? xff.split(',')[0].trim() : (req.ip || req.connection?.remoteAddress || '未知')
    const authType = req.platformKey ? `平台密钥[${req.platformKey.name}]` : 'JWT'
    const apiPath = req.originalUrl || req.url || '未知'
    taskQueue.pushTimeline(task._id, 'skuai', 'received', `API 收到任务请求 | 接口=${apiPath} | 认证=${authType} | IP=${clientIP} | requestId=${task.requestId} | 类型=${taskTypes.join(',')} | 参考图=${referenceImages.length}张 | 通道=${initialChannel} | 模型=${initialModel || '-'}`)

    // 通过统一队列调度（不阻塞响应）
    taskQueue.enqueue(task._id, 'skuai')

    // 获取队列位置和预估等待时间
    const queueInfo = taskQueue.getQueuePosition(task._id)

    return res.status(201).json(successResponse({
      taskId: task._id,
      status: 'queued',
      progress: 0,
      totalItems: items.length,
      queuePosition: queueInfo.position,
      estimatedWait: queueInfo.estimatedWait,
    }, '任务已提交'))
  } catch (err) {
    console.error('[SkuAI] submitTask error:', err)
    return res.status(500).json(errorResponse('提交任务失败: ' + err.message))
  }
}

/**
 * 查询单个任务状态
 * GET /api/ai/sku-ai/tasks/:taskId
 */
exports.getTask = async (req, res) => {
  try {
    const { taskId } = req.params
    const task = await SkuAiTask.findById(taskId).lean()

    if (!task) {
      return res.status(404).json(errorResponse('任务不存在'))
    }

    // 当任务状态为 queued 时，返回队列位置和预估等待时间
    let queuePosition = undefined
    let estimatedWait = undefined
    if (task.status === 'queued') {
      const queueInfo = taskQueue.getQueuePosition(task._id)
      queuePosition = queueInfo.position
      estimatedWait = queueInfo.estimatedWait
    }

    return res.json(successResponse({
      taskId: task._id,
      requestId: task.requestId,
      productId: task.productId,
      skuId: task.skuId,
      skuCode: task.skuCode,
      status: task.status,
      progress: task.progress,
      queuePosition,
      estimatedWait,
      items: task.items.map(item => ({
        id: item._id,
        taskType: item.taskType,
        status: item.status,
        resultFileId: item.resultFileId,
        error: item.error,
      })),
      error: task.error,
      createdAt: task.createdAt,
      completedAt: task.completedAt,
    }))
  } catch (err) {
    console.error('[SkuAI] getTask error:', err)
    return res.status(500).json(errorResponse('查询任务失败'))
  }
}

/**
 * 获取用户任务列表
 * GET /api/ai/sku-ai/tasks?productId=&page=1&pageSize=20
 */
exports.listTasks = async (req, res) => {
  try {
    const { productId, page = 1, pageSize = 20 } = req.query
    const query = { operatorId: req.user._id || req.userId }
    if (productId) query.productId = productId

    const total = await SkuAiTask.countDocuments(query)
    const tasks = await SkuAiTask.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(parseInt(pageSize))
      .lean()

    const taskList = tasks.map(t => ({
      taskId: t._id,
      skuCode: t.skuCode,
      status: t.status,
      progress: t.progress,
      taskTypes: t.taskTypes,
      itemsSummary: {
        total: t.items.length,
        completed: t.items.filter(i => i.status === 'completed').length,
        failed: t.items.filter(i => i.status === 'failed').length,
        skipped: t.items.filter(i => i.status === 'skipped').length,
      },
      createdAt: t.createdAt,
      completedAt: t.completedAt,
    }))

    return res.json(paginatedResponse(taskList, total, page, pageSize))
  } catch (err) {
    console.error('[SkuAI] listTasks error:', err)
    return res.status(500).json(errorResponse('查询任务列表失败'))
  }
}

/**
 * 重试失败的子任务
 * POST /api/ai/sku-ai/tasks/:taskId/retry
 */
exports.retryTask = async (req, res) => {
  try {
    const { taskId } = req.params
    const task = await SkuAiTask.findById(taskId)

    if (!task) {
      return res.status(404).json(errorResponse('任务不存在'))
    }

    // 只能重试已完成（有失败子项）或失败的任务
    if (task.status !== 'succeeded' && task.status !== 'failed') {
      return res.status(400).json(errorResponse(`任务状态为 ${task.status}，无法重试`))
    }

    // 找出失败的子项并重置
    let resetCount = 0
    for (const item of task.items) {
      if (item.status === 'failed') {
        item.status = 'pending'
        item.error = null
        item.resultFileId = null
        item.startedAt = null
        item.completedAt = null
        resetCount++
      }
    }

    if (resetCount === 0) {
      return res.status(400).json(errorResponse('没有需要重试的失败子项'))
    }

    await SkuAiTask.updateOne({ _id: taskId }, {
      $set: {
        status: 'queued',
        progress: 0,
        error: null,
        completedAt: null,
        retryCount: task.retryCount + 1,
        updatedAt: new Date()
      }
    });
    task.retryCount += 1;

    console.log(`[SkuAI] 任务重试: taskId=${taskId}, resetItems=${resetCount}, retryCount=${task.retryCount}`)

    // 重试事件写入 timeline
    taskQueue.pushTimeline(task._id, 'skuai', 'retry', `任务重试（第${task.retryCount}次）| 重置 ${resetCount} 个失败子项`)

    // 通过统一队列调度
    taskQueue.enqueue(task._id, 'skuai')

    // 获取队列位置和预估等待时间
    const queueInfo = taskQueue.getQueuePosition(task._id)

    return res.json(successResponse({
      taskId: task._id,
      status: 'queued',
      resetItems: resetCount,
      retryCount: task.retryCount,
      queuePosition: queueInfo.position,
      estimatedWait: queueInfo.estimatedWait,
    }, '重试已提交'))
  } catch (err) {
    console.error('[SkuAI] retryTask error:', err)
    return res.status(500).json(errorResponse('重试失败'))
  }
}

/**
 * 重试单个失败子项
 * POST /api/ai/sku-ai/tasks/:taskId/items/:itemId/retry
 */
exports.retryTaskItem = async (req, res) => {
  try {
    const { taskId, itemId } = req.params
    const task = await SkuAiTask.findById(taskId)

    if (!task) {
      return res.status(404).json(errorResponse('任务不存在'))
    }

    // 找到指定子项
    const item = task.items.id(itemId)
    if (!item) {
      return res.status(404).json(errorResponse('子项不存在'))
    }

    // 只能重试失败的子项
    if (item.status !== 'failed') {
      return res.status(400).json(errorResponse(`子项状态为 ${item.status}，仅失败子项可重试`))
    }

    // 重置该子项
    item.status = 'pending'
    item.error = null
    item.resultFileId = null
    item.startedAt = null
    item.completedAt = null
    if (typeof item.retryCount === 'number') {
      item.retryCount += 1
    }

    // 如果任务已经完成（succeeded/failed），需要重新入队
    if (task.status === 'succeeded' || task.status === 'failed') {
      task.status = 'queued'
      task.error = null
      task.completedAt = null
    }

    // 重新计算进度
    const totalItems = task.items.length
    const doneItems = task.items.filter(i => i.status === 'completed' || i.status === 'failed' || i.status === 'skipped').length
    task.progress = Math.round((doneItems / totalItems) * 100)
    task.updatedAt = new Date()
    await task.save()

    console.log(`[SkuAI] 子项重试: taskId=${taskId}, itemId=${itemId}, taskType=${item.taskType}`)

    // 子项重试事件写入 timeline
    taskQueue.pushTimeline(task._id, 'skuai', 'retry', `子项重试: [${item.taskType}] itemId=${itemId}`)

    // 通过统一队列调度
    taskQueue.enqueue(task._id, 'skuai')

    return res.json(successResponse({
      taskId: task._id,
      itemId: item._id,
      status: 'queued',
      message: '子项重试已提交',
    }))
  } catch (err) {
    console.error('[SkuAI] retryTaskItem error:', err)
    return res.status(500).json(errorResponse('子项重试失败: ' + err.message))
  }
}

/**
 * 获取队列状态统计
 * GET /api/ai/sku-ai/queue-stats
 */
exports.getQueueStats = async (req, res) => {
  try {
    const stats = taskQueue.getQueueStats()
    return res.json(successResponse(stats))
  } catch (err) {
    console.error('[SkuAI] getQueueStats error:', err)
    return res.status(500).json(errorResponse('获取队列状态失败'))
  }
}

// Export validation utilities for testing
exports.isValidTaskType = isValidTaskType
exports.VALID_BASE_TYPES = VALID_BASE_TYPES
exports.VALID_SUBTYPES = VALID_SUBTYPES
