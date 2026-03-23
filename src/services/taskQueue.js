/**
 * FurnIAI — Unified Task Queue
 * 统一调度中心：内存并发控制 + MongoDB 持久化，支持 FurniaiTask 和 SkuAiTask 两种任务类型
 */
const FurniaiTask = require('../models/FurniaiTask')
const SkuAiTask = require('../models/SkuAiTask')
const geminiClient = require('./geminiClient')
const promptBuilder = require('./promptBuilder')
const imageProcessor = require('./imageProcessor')
const configManager = require('./configManager')
const jwtCounter = require('../utils/jwtCounter')
const PlatformKey = require('../models/PlatformKey')

const { getInstance: getKeyPoolInstance } = require('./keyPool')

// 任务超时时间（从 configManager 动态读取，默认 600000ms = 10分钟）
function getTaskTimeout() { return configManager.get('taskTimeoutMs') || 600000 }

// ── KeyPool 懒加载 ──────────────────────────────────────
let _keyPool = null
function getKeyPool() {
  if (!_keyPool) {
    try { _keyPool = getKeyPoolInstance() } catch (e) { return null }
  }
  return _keyPool
}

// ── 动态并发参数 ──────────────────────────────────────
// 优先级：1. 管理面板系统设置(DB) → 2. 环境变量 → 3. 动态计算
function getMaxConcurrency() {
  // 优先读取管理面板中系统设置保存的值
  const dbVal = configManager.get('concurrentMax')
  if (dbVal && dbVal > 0) return dbVal

  // 其次读环境变量
  const envVal = process.env.FURNIAI_MAX_CONCURRENCY
  if (envVal) return parseInt(envVal, 10) || 4

  // 最后动态计算
  const pool = getKeyPool()
  const keyCount = pool ? pool.getHealthyKeyCount() : 1
  let base = Math.min(keyCount * 2, 8)
  if ((process.env.FURNIAI_CONCURRENT_API_KEY || '').trim().length >= 8) {
    base += parseInt(process.env.FURNIAI_CONCURRENT_MAX_CONCURRENCY, 10) || 4
  }
  return base
}

function getSubItemConcurrency() {
  const envVal = process.env.FURNIAI_SUB_ITEM_CONCURRENCY
  if (envVal) return parseInt(envVal, 10) || 2
  // concurrent 通道不依赖 KeyPool，直接用并发配置
  const channel = process.env.FURNIAI_CHANNEL || 'auto'
  if (channel === 'concurrent') {
    return parseInt(process.env.FURNIAI_CONCURRENT_MAX_CONCURRENCY, 10) || 4
  }
  const pool = getKeyPool()
  const keyCount = pool ? pool.getHealthyKeyCount() : 1
  return Math.min(keyCount * 2, 6)
}
let runningCount = 0
const pendingQueue = [] // { taskId, taskType } 队列
// 内存中活跃任务 ID 集合（排队中 + 执行中），防止轮询机制重复拾取正在运行的任务
const activeTasks = new Set()

// 任务耗时统计（用于预估等待时间，参数从 configManager 动态读取）
const taskDurations = [] // 最近完成任务的耗时（ms）
function getMaxDurationSamples() { return configManager.get('maxDurationSamples') || 20 }
function getDefaultAvgDuration() { return configManager.get('defaultAvgDurationMs') || 60000 }

// 可注入的处理函数注册表
const taskHandlers = {}

// ── 参考图预处理缓存（参数从 configManager 动态读取） ──────────────────────────────────────
// key: fileId (string), value: { base64: string, timestamp: number }
const _imagePreprocessCache = new Map()
function getImagePreprocessTTL() { return configManager.get('imagePreprocessTTLMs') || 1800000 }
function getImagePreprocessMaxSize() { return configManager.get('imagePreprocessMaxSize') || 100 }

const { Semaphore } = require('../utils/semaphore')

/**
 * 注册任务处理函数
 * @param {string} taskType - 任务类型 'furniai' | 'skuai'
 * @param {Function} handler - async function(taskId): void
 */
function registerHandler(taskType, handler) {
  taskHandlers[taskType] = handler
}

/**
 * 向任务 timeline 追加一条日志（原子 $push，不阻塞主流程）
 * 使用原生 MongoDB driver 绕过 Mongoose strict mode，确保写入不被静默拦截
 * @param {string} taskId - 任务 ID
 * @param {string} taskType - 'furniai' | 'skuai'
 * @param {string} phase - 阶段标识
 * @param {string} msg - 人类可读描述
 */
function pushTimeline(taskId, taskType, phase, msg) {
  const collName = taskType === 'skuai' ? 'skuaitasks' : 'furniaitasks'
  const mongoose = require('mongoose')
  try {
    const objectId = typeof taskId === 'string' ? new mongoose.Types.ObjectId(taskId) : taskId
    mongoose.connection.db.collection(collName).updateOne(
      { _id: objectId },
      { $push: { timeline: { ts: new Date(), phase, msg } } }
    ).then(r => {
      if (r.matchedCount === 0) {
        console.warn(`[Timeline] 未匹配到文档: ${collName}/${taskId}`)
      }
    }).catch(e => console.warn(`[Timeline] 写入失败: ${e.message}`))
  } catch (e) {
    console.warn(`[Timeline] pushTimeline 异常: ${e.message}`)
  }
}

/**
 * 格式化错误为完整的可读字符串（含 stack、HTTP 状态码、响应体等）
 * @param {Error} err
 * @returns {string}
 */
function _formatError(err) {
  if (!err) return '未知错误'
  let parts = [err.message || String(err)]
  // axios 错误：包含 HTTP 状态码和响应体
  if (err.response) {
    parts.push(`HTTP ${err.response.status}`)
    const body = err.response.data
    if (body) {
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body)
      // 截取前 500 字符，避免日志过长
      parts.push(`响应: ${bodyStr.slice(0, 500)}`)
    }
  }
  // 错误代码（如 ECONNREFUSED、ETIMEDOUT 等）
  if (err.code) parts.push(`[${err.code}]`)
  // 错误堆栈（取前 5 行）
  if (err.stack) {
    const stackLines = err.stack.split('\n').slice(1, 6).map(l => l.trim()).join(' ← ')
    parts.push(`堆栈: ${stackLines}`)
  }
  return parts.join(' | ')
}

// ── 参考图预处理 ──────────────────────────────────────────

/**
 * 从预处理缓存中获取已加载的 base64 数据
 * @param {string} fileId
 * @returns {string|null} 纯 base64 或 null（未命中/已过期）
 */
function getPreprocessedImage(fileId) {
  const key = String(fileId)
  const entry = _imagePreprocessCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.timestamp > getImagePreprocessTTL()) {
    _imagePreprocessCache.delete(key)
    return null
  }
  // 命中时 delete + re-set，将该条目移到 Map 末尾，实现真正 LRU
  _imagePreprocessCache.delete(key)
  _imagePreprocessCache.set(key, entry)
  return entry.base64
}

/**
 * 异步预处理参考图：加载 base64 并归一化，结果存入内存缓存。
 * 失败时静默忽略（不阻塞入队），任务执行时回退到同步加载。
 * @param {string} fileId - GridFS fileId 或其他图片标识
 */
function _preprocessReferenceImage(fileId) {
  const key = String(fileId)
  // 已在缓存中且未过期，跳过
  if (getPreprocessedImage(key) !== null) return

  // 异步加载，fire-and-forget
  imageProcessor.normalizeImageInput(key)
    .then(base64 => {
      // 缓存满时淘汰最早的条目（简易 LRU）
      if (_imagePreprocessCache.size >= getImagePreprocessMaxSize()) {
        const oldestKey = _imagePreprocessCache.keys().next().value
        if (oldestKey !== key) {
          _imagePreprocessCache.delete(oldestKey)
        }
      }
      _imagePreprocessCache.set(key, { base64, timestamp: Date.now() })
      console.log(`[TaskQueue] Preprocessed reference image: ${key.slice(0, 12)}...`)
    })
    .catch(err => {
      // 预处理失败不阻塞，任务执行时回退到同步加载
      console.warn(`[TaskQueue] Reference image preprocess failed (will fallback): ${err.message}`)
    })
}

/**
 * 在入队时触发参考图预处理
 * 从数据库加载任务，提取 referenceImages 并异步预处理
 * @param {string} taskId
 * @param {string} taskType
 */
function _startPreprocessing(taskId, taskType) {
  try {
    const Model = taskType === 'skuai' ? SkuAiTask : FurniaiTask
    if (!Model || typeof Model.findById !== 'function') return

    Model.findById(taskId)
      .then(task => {
        if (!task || !task.referenceImages || task.referenceImages.length === 0) return
        for (const ref of task.referenceImages) {
          const fileId = typeof ref === 'object' ? (ref.data || ref) : ref
          if (fileId) {
            _preprocessReferenceImage(String(fileId))
          }
        }
      })
      .catch(err => {
        console.warn(`[TaskQueue] Preprocess lookup failed for task ${taskId}: ${err.message}`)
      })
  } catch (err) {
    // Defensive: never let preprocessing crash enqueue
    console.warn(`[TaskQueue] Preprocess start failed for task ${taskId}: ${err.message}`)
  }
}

/**
 * 入队并尝试调度
 * @param {string} taskId - 任务 ID
 * @param {string} [taskType='furniai'] - 任务类型 'furniai' | 'skuai'
 */
function enqueue(taskId, taskType) {
  const type = taskType || 'furniai'
  const strId = String(taskId)

  // 防重入：如果该任务已在内存队列中（排队或执行中），直接跳过，避免轮询误伤导致二次调度
  if (activeTasks.has(strId)) {
    console.log(`[TaskQueue] 任务 ${strId} 已在活跃队列中，跳过重复入队`)
    return
  }
  activeTasks.add(strId)

  pendingQueue.push({ taskId, taskType: type })

  // 记录入队日志
  const pos = pendingQueue.length
  const running = runningCount
  pushTimeline(taskId, type, 'queued', `任务已入队，队列位置 #${pos}，当前运行中 ${running}/${getMaxConcurrency()}`)

  // 异步预处理参考图（fire-and-forget，失败不阻塞）
  _startPreprocessing(taskId, type)

  _tryNext()
}

/**
 * 获取任务在等待队列中的位置和预估等待时间
 * @param {string} taskId
 * @returns {{ position: number, estimatedWait: number } | null}
 *   position: 0-based index in pendingQueue, -1 if not found (may be running or completed)
 *   estimatedWait: 预估等待秒数
 */
function getQueuePosition(taskId) {
  const strId = String(taskId)
  const index = pendingQueue.findIndex(item => String(item.taskId) === strId)
  if (index === -1) {
    return { position: -1, estimatedWait: 0 }
  }

  const avgDuration = _getAvgTaskDuration()
  // 预估等待 = (排在前面的等待任务数 + 当前正在执行的任务数) / 并发槽位数 * 平均耗时
  const tasksAhead = index + 1
  const estimatedWait = Math.ceil(((tasksAhead + runningCount) / getMaxConcurrency()) * (avgDuration / 1000))

  return { position: index, estimatedWait }
}

/**
 * 获取队列统计信息
 * @returns {{ running: number, pending: number, maxConcurrency: number, avgTaskDuration: number, estimatedWaitForNew: number }}
 */
function getQueueStats() {
  const avgDuration = _getAvgTaskDuration()
  const pendingCount = pendingQueue.length
  // 新任务预估等待 = (当前等待数 + 1 + 当前正在执行的任务数) / 并发槽位数 * 平均耗时
  const estimatedWaitForNew = Math.ceil(((pendingCount + 1 + runningCount) / getMaxConcurrency()) * (avgDuration / 1000))

  return {
    running: runningCount,
    pending: pendingCount,
    maxConcurrency: getMaxConcurrency(),
    subItemConcurrency: getSubItemConcurrency(),
    avgTaskDuration: Math.round(avgDuration / 1000), // 秒
    estimatedWaitForNew,
    totalKeys: getKeyPool()?.getKeyCount() || 0,
    healthyKeys: getKeyPool()?.getHealthyKeyCount() || 0,
    concurrentAvailable: !!process.env.FURNIAI_CONCURRENT_API_KEY,
    concurrentMaxConcurrency: parseInt(process.env.FURNIAI_CONCURRENT_MAX_CONCURRENCY, 10) || 4,
  }
}

/**
 * 计算平均任务耗时（ms）
 */
function _getAvgTaskDuration() {
  if (taskDurations.length === 0) return getDefaultAvgDuration()
  const sum = taskDurations.reduce((a, b) => a + b, 0)
  return sum / taskDurations.length
}

/**
 * 记录任务耗时
 */
function _recordTaskDuration(durationMs) {
  taskDurations.push(durationMs)
  if (taskDurations.length > getMaxDurationSamples()) {
    taskDurations.shift()
  }
}

/**
 * Mark a task as failed in the database (used for timeout and uncaught errors)
 * 超时标记失败前，会检查子任务是否已有成功结果。
 * 如果已有图片产出，则保留成功状态，仅记录超时警告。
 */
async function _markTaskFailed(taskId, taskType, errorMessage) {
  try {
    const Model = taskType === 'skuai' ? SkuAiTask : FurniaiTask
    const task = await Model.findById(taskId)
    if (!task || task.status === 'succeeded' || task.status === 'canceled') return

    // 检查是否有子任务已经成功产出图片
    const hasCompletedItems = task.items && task.items.some(
      item => item.status === 'completed' && item.resultFileId
    )

    if (hasCompletedItems) {
      // 已有成功结果 → 不覆盖为 failed，而是标记为 succeeded 并附带超时警告
      await Model.updateOne({ _id: taskId }, {
        $set: {
          status: 'succeeded',
          error: `[超时警告] ${errorMessage}（但已有图片产出，保留成功状态）`,
          progress: 100,
          completedAt: new Date(),
          updatedAt: new Date()
        }
      });
      console.log(`[TaskQueue] Task ${taskId} timed out but has completed items — kept as succeeded`)
    } else {
      // 没有任何成功结果 → 正常标记为失败
      await Model.updateOne({ _id: taskId }, {
        $set: {
          status: 'failed',
          error: errorMessage,
          completedAt: new Date(),
          updatedAt: new Date()
        }
      });
      console.log(`[TaskQueue] Task ${taskId} marked as failed: ${errorMessage}`)
    }
  } catch (err) {
    console.error(`[TaskQueue] Failed to mark task ${taskId} as failed:`, err.message)
  }
}

function _tryNext() {
  const maxConc = getMaxConcurrency() // 每轮调度取一次，避免循环内反复读取
  while (runningCount < maxConc && pendingQueue.length > 0) {
    const { taskId, taskType } = pendingQueue.shift()
    runningCount++

    // 记录调度日志
    pushTimeline(taskId, taskType, 'dispatched', `调度引擎已分配执行槽位，并发 ${runningCount}/${maxConc}，剩余排队 ${pendingQueue.length}`)

    const startTime = Date.now()
    const handler = taskHandlers[taskType]

    const controlFlow = { isTimeout: false }
    const taskPromise = handler
      ? handler(taskId, controlFlow)
      : _defaultProcessTask(taskId, controlFlow)

    // Wrap with timeout protection (Promise.race)
    // 保存 timer 引用，任务完成后清理，防止内存泄漏
    let timeoutTimer = null
    const timeoutPromise = new Promise((_, reject) => {
      timeoutTimer = setTimeout(() => {
        const elapsed = Date.now() - startTime
        reject(new Error(`Task ${taskId} timed out after ${elapsed}ms (limit: ${getTaskTimeout()}ms)`))
      }, getTaskTimeout())
    })

    Promise.race([taskPromise, timeoutPromise])
      .catch(err => {
        controlFlow.isTimeout = true
        console.error(`[TaskQueue] Task ${taskId} (${taskType}) failed:`, err.message)
        // Mark task as failed on timeout
        return _markTaskFailed(taskId, taskType, err.message)
      })
      .finally(() => {
        clearTimeout(timeoutTimer) // 清理超时计时器，防止内存泄漏
        activeTasks.delete(String(taskId)) // 任务结束后从活跃集合移除，允许未来重新入队
        _recordTaskDuration(Date.now() - startTime)
        runningCount--
        _tryNext()
      })
  }
}

/**
 * 默认处理函数（FurniaiTask 原有逻辑）
 * 当没有注册自定义 handler 时使用
 */
async function _defaultProcessTask(taskId, controlFlow = { isTimeout: false }) {
  const task = await FurniaiTask.findById(taskId)
  if (!task || task.status === 'canceled') return

  // 防重复执行：如果任务已成功完成（可能被重调度），直接跳过，不覆盖状态
  if (task.status === 'succeeded') {
    console.log(`[FurnIAI:Queue] 任务 ${taskId} 已成功完成，跳过重复执行`)
    return
  }

  const _tl = (phase, msg) => pushTimeline(taskId, 'furniai', phase, msg)

  try {
    const startedAt = new Date();
    const updatedAt = new Date();
    const initialUpdateData = {
      status: 'running',
      startedAt,
      updatedAt
    };

    // 预写入当前活跃通道和模型，使任务处理中阶段前端就能显示（API 返回后会覆盖为实际值）
    const activeChannels = configManager.get('channelPriority')?.filter(c => c.enabled) || []
    const primaryCh = activeChannels[0]
    if (primaryCh) {
      initialUpdateData['options.channel'] = primaryCh.name;
      initialUpdateData.modelUsed = primaryCh.imageModel || null;
      if (!task.options) task.options = {};
      task.options.channel = primaryCh.name;
      task.modelUsed = primaryCh.imageModel || null;
    }

    await FurniaiTask.updateOne({ _id: taskId }, { $set: initialUpdateData });
    task.status = 'running';
    task.startedAt = startedAt;
    task.updatedAt = updatedAt;

    _tl('task_start', `任务开始执行，通道=${primaryCh?.name || 'auto'}，模型=${primaryCh?.imageModel || '-'}，共 ${task.items.length} 个子项`)

    // 读取参考图 base64（优先使用预处理缓存）
    let refBase64 = null
    let refId = null
    if (task.referenceImages && task.referenceImages.length > 0) {
      const firstRef = task.referenceImages[0]
      refId = String(firstRef.data || firstRef)
      _tl('ref_load_start', `开始加载参考图 ${refId.slice(0, 12)}...`)
      try {
        // 尝试从预处理缓存获取
        const cached = getPreprocessedImage(refId)
        if (cached) {
          refBase64 = cached
          _tl('ref_load_done', `参考图加载完成（命中预处理缓存）`)
          console.log(`[FurnIAI:Queue] Using preprocessed reference image: ${refId.slice(0, 12)}...`)
        } else {
          const refLoadStart = Date.now()
          refBase64 = await imageProcessor.normalizeImageInput(firstRef.data || firstRef)
          _tl('ref_load_done', `参考图加载完成（从存储读取），耗时 ${Date.now() - refLoadStart}ms`)
        }
      } catch (err) {
        _tl('ref_load_fail', `参考图加载失败: ${_formatError(err)}`)
        console.error(`[FurnIAI:Queue] Reference image load failed: ${err.message}`)
        await FurniaiTask.updateOne({ _id: taskId }, {
          $set: {
            status: 'failed',
            error: 'Reference image load failed: ' + err.message,
            completedAt: new Date(),
            updatedAt: new Date()
          }
        });
        return
      }
    }

    // 使用缓存的分析数据（如果有），否则使用空对象
    // 提示词模板是固定的，不需要 AI 分析参考图
    const analysis = task.analysisCache || {}
    _tl('analysis_skip', '使用固定提示词模板（跳过 AI 分析）')

    // 并行处理子项（受信号量限制，最多 SUB_ITEM_CONCURRENCY 个同时执行）
    let completedCount = 0
    let failedCount = 0
    const totalItems = task.items.length

    // 用于准确统计本次运行的计费、调用结果，避免由于任务重试导致的历史项重复计费或漏计
    let sessionCompletedCount = 0
    let sessionFailedCount = 0
    let sessionCredits = 0

    // Count already-completed/skipped items first
    for (const item of task.items) {
      if (item.status === 'completed' || item.status === 'skipped') {
        completedCount++
      }
    }

    // Filter items that need processing
    const pendingItems = task.items.filter(
      item => item.status !== 'completed' && item.status !== 'skipped'
    )

    if (pendingItems.length > 0) {
      const sem = new Semaphore(getSubItemConcurrency())

      const itemPromises = pendingItems.map(item => {
        return (async () => {
          await sem.acquire()
          // 用于构建原子更新的字段集合
          let itemUpdate = {}
          let taskLevelUpdate = {}

          try {
            // 原子更新子任务为 processing 状态（避免并发 save 覆盖）
            const now = new Date()
            await FurniaiTask.updateOne(
              { _id: taskId, 'items._id': item._id },
              { $set: { 'items.$.status': 'processing', 'items.$.startedAt': now, updatedAt: now } }
            )

            const taskType = item.taskType
            _tl('item_start', `子项 [${taskType}] 开始处理`)
            const itemOptions = {
              userContext: task.options?.userContext || '',
              enableHD: task.options?.enableHD || false,
              ...(item.options || {}),
            }

            const prompt = promptBuilder.buildVisualPrompt(taskType, analysis || {}, itemOptions)
            _tl('prompt_built', `子项 [${taskType}] Prompt 已构建，长度=${prompt.length} 字符`)
            // 立即持久化 prompt 到 DB，确保即使后续超时/失败也有记录（不依赖最终 updateOne）
            await FurniaiTask.updateOne(
              { _id: taskId, 'items._id': item._id },
              { $set: { 'items.$.prompt': prompt, updatedAt: new Date() } }
            )

            console.log(`[FurnIAI:Queue] Generating: taskId=${taskId}, type=${taskType}`)
            _tl('api_call', `子项 [${taskType}] 正在调用 AI 生图 API...`)
            const itemStart = Date.now()

            const result = await geminiClient.generateImage(prompt, refBase64, {
              enableHD: itemOptions.enableHD,
              imageSize: task.options?.imageSize || '',       // 透传图片分辨率
              aspectRatio: task.options?.aspectRatio || '',   // 透传宽高比
              _timelineLogger: _tl,
            })

            // 熔断点 1：经过漫长生成返回后，查看外层是否已被 race 宣布超时
            if (controlFlow.isTimeout) {
              console.warn(`[FurnIAI:Queue] Task ${taskId} sub-item timeout interrupted before saving image.`)
              // 超时前尽力保存 API 返回的文本内容（prompt 已在上方提前写入）
              const timeoutUpdate = { 'items.$.status': 'failed', 'items.$.error': '任务超时中断', 'items.$.completedAt': new Date() }
              if (result && result.text) timeoutUpdate['items.$.resultText'] = result.text
              await FurniaiTask.updateOne(
                { _id: taskId, 'items._id': item._id },
                { $set: { ...timeoutUpdate, updatedAt: new Date() } }
              ).catch(e => console.warn('[FurnIAI:Queue] 超时保存失败:', e.message))
              return
            }

            const elapsed = Date.now() - itemStart
            _tl('api_done', `子项 [${taskType}] API 响应返回，耗时 ${elapsed}ms，hasImage=${!!result.image}，通道=${result.channel || '-'}，模型=${result.model || '-'}`)
            console.log(`[FurnIAI:Queue] Done: taskId=${taskId}, type=${taskType}, ${elapsed}ms, hasImage=${!!result.image}`)

            if (result.image) {
              // 保存生成的图片到 GridFS
              _tl('save_image', `子项 [${taskType}] 正在保存图片到存储 (~${Math.round(result.image.length / 1024)}KB)...`)
              console.log(`[FurnIAI:Queue] Saving image: taskId=${taskId}, type=${taskType}, ~${Math.round(result.image.length / 1024)}KB`)
              let savedFileId = null
              let savedBase64 = null
              try {
                const dataUrl = imageProcessor.toDataUrl(result.image)
                savedFileId = await imageProcessor.saveBase64ToGridFS(dataUrl, `furniai-${taskType}`)
                _tl('save_done', `子项 [${taskType}] 图片已保存到 GridFS, fileId=${savedFileId}`)
                console.log(`[FurnIAI:Queue] Image saved to GridFS: taskId=${taskId}, fileId=${savedFileId}`)
              } catch (saveErr) {
                console.error(`[FurnIAI:Queue] GridFS save FAILED: taskId=${taskId}, error=${saveErr.message}, stack=${saveErr.stack}`)
                // 兜底：内联存储 base64（限制 2MB）
                savedBase64 = result.image.length > 2000000 ? null : result.image
                if (!savedBase64) {
                  console.warn(`[FurnIAI:Queue] Image too large for inline storage (~${Math.round(result.image.length / 1024)}KB), image LOST`)
                }
              }

              if (!savedFileId && !savedBase64) {
                itemUpdate['items.$.status'] = 'failed'
                itemUpdate['items.$.error'] = 'GridFS 图片保存失败，且体积超过限制无法内联'
                itemUpdate['items.$.completedAt'] = new Date()
                failedCount++
                sessionFailedCount++
              } else {
                itemUpdate['items.$.status'] = 'completed'
                itemUpdate['items.$.completedAt'] = new Date()
                if (savedFileId) itemUpdate['items.$.resultFileId'] = savedFileId
                if (savedBase64) itemUpdate['items.$.resultBase64'] = savedBase64
                completedCount++
                sessionCompletedCount++
                sessionCredits += promptBuilder.calculateCreditCost(taskType || 'generate')
              }

              // 回写实际使用的模型和通道到 Task 顶部
              if (result.channel) {
                taskLevelUpdate['options.channel'] = result.channel
              }
              if (result.model) {
                taskLevelUpdate.modelUsed = result.model
              }
            } else {
              _tl('item_failed', `子项 [${taskType}] 失败: API 响应中无图片数据`)
              itemUpdate['items.$.status'] = 'failed'
              itemUpdate['items.$.error'] = 'No image in response'
              itemUpdate['items.$.completedAt'] = new Date()
              failedCount++
              sessionFailedCount++
            }
          } catch (err) {
            _tl('item_failed', `子项 [${item.taskType}] 异常: ${_formatError(err)}`)
            console.error(`[FurnIAI:Queue] Item failed: taskId=${taskId}, type=${item.taskType}, error=${err.message}`)
            itemUpdate['items.$.status'] = 'failed'
            itemUpdate['items.$.error'] = err.message
            itemUpdate['items.$.completedAt'] = new Date()
            failedCount++
            sessionFailedCount++
          } finally {
            sem.release()
          }

          // 原子更新：只写入当前 item 的变更字段和进度，不影响其他并发 item
          const progressVal = Math.round(((completedCount + failedCount) / totalItems) * 100)
          await FurniaiTask.updateOne(
            { _id: taskId, 'items._id': item._id },
            { $set: { ...itemUpdate, ...taskLevelUpdate, progress: progressVal, updatedAt: new Date() } }
          )
        })()
      })

      // Wait for all sub-items — allSettled ensures partial failure doesn't abort others
      await Promise.allSettled(itemPromises)
    }

    // 熔断点 2：等待所有子任务完毕后，若此时外围宣布已超时死角，那么停止回写最终记录与主扣费！
    if (controlFlow.isTimeout) {
      console.warn(`[FurnIAI:Queue] Task ${taskId} entirely timed-out. Skipping final statistical save.`)
      return
    }

    // 最终状态原子更新
    const updateData = {
      progress: 100,
      completedAt: new Date(),
      updatedAt: new Date()
    }

    if (failedCount === totalItems) {
      updateData.status = 'failed'
      updateData.error = 'All items failed'
    } else {
      // 部分失败也视为成功（至少有一个 item 生成成功即可）
      updateData.status = 'succeeded'
    }

    // ═══ Prompt 最终保障：并发写入可能导致 prompt 丢失，这里做兜底修复 ═══
    const latestFurniaiTask = await FurniaiTask.findById(taskId, 'items options').lean()
    if (latestFurniaiTask?.items) {
      const bulkOps = []
      for (const dbItem of latestFurniaiTask.items) {
        if ((dbItem.status === 'completed' || dbItem.status === 'failed') && !dbItem.prompt) {
          try {
            const itemOpts = {
              userContext: latestFurniaiTask.options?.userContext || '',
              enableHD: latestFurniaiTask.options?.enableHD || false,
              ...(dbItem.options || {}),
            }
            const rebuilt = promptBuilder.buildVisualPrompt(dbItem.taskType, analysis || {}, itemOpts)
            bulkOps.push({
              updateOne: {
                filter: { _id: taskId, 'items._id': dbItem._id },
                update: { $set: { 'items.$.prompt': rebuilt } }
              }
            })
          } catch (e) { /* 构建失败则跳过 */ }
        }
      }
      if (bulkOps.length > 0) {
        await FurniaiTask.bulkWrite(bulkOps)
        console.log(`[FurnIAI:Queue] Prompt 兜底修复: taskId=${taskId}, 修复 ${bulkOps.length} 个子项`)
      }
    }

    await FurniaiTask.updateOne({ _id: taskId }, { $set: updateData })
    _tl('task_completed', `任务完成: status=${updateData.status}, 成功=${completedCount}, 失败=${failedCount}`)
    console.log(`[FurnIAI:Queue] Task finished: taskId=${taskId}, status=${updateData.status}, ok=${completedCount}, fail=${failedCount}`)

    // ── 更新平台调用分布统计 ──
    // 根据 operatorId 判断是平台密钥调用还是 JWT 调用
    const opId = task.operatorId?.toString() || ''
    if (opId.startsWith('platform:')) {
      // 平台密钥调用 → 查找对应的 PlatformKey 并更新统计
      const platformName = opId.replace('platform:', '')
      try {
        const pk = await PlatformKey.findOne({ name: platformName })
        if (pk) {
          if (sessionCompletedCount > 0) {
            await pk.recordSuccess(sessionCredits)
          }
          if (sessionFailedCount > 0) {
            await Promise.all(Array.from({ length: sessionFailedCount }, () => pk.recordFailure()))
          }
          console.log(`[FurnIAI:Queue] 平台统计已更新: ${platformName}, 本次运行成功 ${sessionCompletedCount} 次 (计提 ${sessionCredits} 额度), 失败 ${sessionFailedCount} 次`)
        }
      } catch (e) {
        console.error(`[FurnIAI:Queue] 平台统计更新失败:`, e.message)
      }
    } else {
      // JWT 调用 → 更新 JWT 独立计数器
      try {
        await Promise.all([
          ...Array.from({ length: sessionCompletedCount }, () => jwtCounter.recordSuccess()),
          ...Array.from({ length: sessionFailedCount }, () => jwtCounter.recordFailure()),
        ])
        if (sessionCompletedCount > 0 || sessionFailedCount > 0) {
          console.log(`[FurnIAI:Queue] JWT统计已更新: 本次运行成功 ${sessionCompletedCount} 次, 失败 ${sessionFailedCount} 次`)
        }
      } catch (e) {
        console.error(`[FurnIAI:Queue] JWT统计更新失败:`, e.message)
      }
    }
  } catch (err) {
    _tl('task_failed', `任务异常: ${_formatError(err)}`)
    console.error(`[FurnIAI:Queue] Task error: taskId=${taskId}, ${err.message}`)
    try {
      await FurniaiTask.updateOne(
        { _id: taskId },
        {
          $set: {
            status: 'failed',
            error: err.message,
            completedAt: new Date(),
            updatedAt: new Date()
          }
        }
      )
    } catch (saveErr) {
      // 二次保存失败时仅打日志，避免 unhandled rejection
      console.error(`[FurnIAI:Queue] Failed to save error status for task ${taskId}:`, saveErr.message)
    }
  }
}

module.exports = {
  enqueue,
  registerHandler,
  getQueuePosition,
  getQueueStats,
  getPreprocessedImage,
  pushTimeline,
  formatError: _formatError,
  Semaphore,
  getMaxConcurrency,
  getSubItemConcurrency,
  // 查询任务是否在本进程内存队列中活跃（排队或执行中）
  isTaskActive: (taskId) => activeTasks.has(String(taskId)),
  // 预注册 taskId 到活跃集合（用于 controller 中 create 前占位，防止 Change Stream 竞态导致二次调度）
  markActive: (taskId) => { activeTasks.add(String(taskId)) },
}
