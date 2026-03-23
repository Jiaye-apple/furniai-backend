/**
 * FurnIAI — Controller
 * REST 接口控制器，所有 /api/ai/furniai 路由的处理函数
 */
const FurniaiTask = require('../models/FurniaiTask')
const geminiClient = require('../services/geminiClient')
const promptBuilder = require('../services/promptBuilder')
const imageProcessor = require('../services/imageProcessor')
const taskQueue = require('../services/taskQueue')
const configManager = require('../services/configManager')
const jwtCounter = require('../utils/jwtCounter')
const { successResponse, errorResponse, paginatedResponse } = require('../utils/response')
const crypto = require('crypto')

/**
 * 提取大模型返回文本中的有效 JSON 数据
 * 解决大模型有时不按照标准输出带 markdown ```json 前后缀或带有废话语境的问题
 */
function safeParseJson(text) {
  try {
    const mdMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
    const str = mdMatch ? mdMatch[1].trim() : text.trim()
    const jsonMatch = str.match(/(?:\{[\s\S]*\}|\[[\s\S]*\])/)
    if (jsonMatch) return JSON.parse(jsonMatch[0])
    return JSON.parse(str)
  } catch (e) {
    throw new Error('Safe JSON extract failed: ' + e.message)
  }
}

/**
 * 将 auto 通道解析为当前配置中实际会使用的通道 ID（仅用于提交时预填充）
 * auto 模式按 channelMode 或 channelPriority 中第一个启用通道的 ID 来确定
 * 注意：批量任务的真正通道由 taskQueue 在生图成功后从 result.channel 回写
 */
function resolveAutoChannelId(channelId) {
  if (channelId && channelId !== 'auto') return channelId
  const config = configManager.get()
  // 如果 channelMode 不是 auto，直接用 channelMode 值作为通道 ID
  const mode = config?.channelMode || 'auto'
  if (mode !== 'auto') return mode
  // auto 模式：取 channelPriority 中第一个启用的通道 ID
  const channels = config?.channelPriority || []
  const first = channels.find(c => c.enabled)
  return first?.id || 'auto'
}

/**
 * 从请求对象中提取调用上下文信息（用于 timeline 日志）
 * @param {object} req - Express 请求对象
 * @param {string} taskType - 任务类型
 * @returns {object} 调用上下文
 */
function extractCallContext(req, taskType) {
  // 获取客户端 IP
  const xff = req.headers?.['x-forwarded-for']
  const clientIP = xff ? xff.split(',')[0].trim() : (req.ip || req.connection?.remoteAddress || '未知')
  // 认证方式
  const authType = req.platformKey ? `平台密钥[${req.platformKey.name}]` : 'JWT'
  // 接口路径
  const apiPath = req.originalUrl || req.url || '未知'
  return { clientIP, authType, apiPath, taskType }
}

// 异步创建单次调用的任务记录（不阻塞响应）
// channel: 实际使用的通道 ID（由 generateImage 返回），不传则走 resolveAutoChannelId 兜底
// model: 实际使用的模型名称（由 generateImage 返回）
// imageDataUrl: 成功时传入 data:image/png;base64,xxx 格式的图片，异步存入 GridFS
// extra: { prompt, referenceImages, userContext } 额外输入参数（确保管理面板能看到所有输入）
// extra.referenceImages 中的图片会异步存入 GridFS，存 fileId 而非原始 base64
// callContext: { clientIP, authType, apiPath, taskType } 调用链追踪信息
function logSingleCallTask(userId, taskType, status, startTime, channel, model, imageDataUrl, extra = {}, callContext = {}) {
  const now = new Date()
  // 优先使用 API 调用实际返回的通道 ID，兜底用 resolveAutoChannelId
  const resolvedChannel = channel || resolveAutoChannelId('auto')
  const taskDoc = {
    requestId: 'api-' + crypto.randomBytes(8).toString('hex'),
    operatorId: userId || 'unknown',
    source: 'api',
    referenceImages: [],   // 异步填充：base64 存 GridFS 后转为 fileId
    items: [{
      taskType: taskType,
      status: status === 'succeeded' ? 'completed' : 'failed',
      prompt: extra.prompt || null,                 // 保存实际使用的 prompt
      startedAt: startTime,
      completedAt: now,
    }],
    options: {
      channel: resolvedChannel,
      userContext: extra.userContext || '',          // 保存用户调教参数
    },
    modelUsed: model || null,
    status: status,
    progress: 100,
    startedAt: startTime,
    completedAt: now,
  }

    // 统一异步处理：保存结果图片 + 参考图到 GridFS，最后创建任务记录
    ; (async () => {
      try {
        // 1. 保存结果图片到 GridFS
        if (imageDataUrl && status === 'succeeded') {
          try {
            const fileId = await imageProcessor.saveBase64ToGridFS(imageDataUrl, `furniai-${taskType}`)
            taskDoc.items[0].resultFileId = fileId
          } catch (e) {
            console.warn('[FurnIAI] 单次调用图片存储失败:', e.message)
            // GridFS 保存失败 → 降级 item 状态为 failed，避免"完成但无图片"的矛盾状态
            taskDoc.items[0].status = 'failed'
            taskDoc.items[0].error = '图片存储失败: ' + e.message
            taskDoc.status = 'failed'
          }
        }

        // 2. 保存参考图到 GridFS（base64/data URL → GridFS fileId，HTTP URL 和短字符串 fileId 直接透传）
        if (extra.referenceImages && extra.referenceImages.length > 0) {
          for (const ref of extra.referenceImages) {
            const imgData = typeof ref === 'object' ? ref.data : ref
            if (!imgData) continue
            try {
              if (imgData.startsWith('http://') || imgData.startsWith('https://')) {
                // HTTP URL → 直接存为 URL 引用
                taskDoc.referenceImages.push({ url: imgData })
              } else if (imgData.startsWith('data:') || (imgData.length > 200 && !imgData.includes('/'))) {
                // base64 / data URL → 存入 GridFS，转为 fileId
                const dataUrl = imgData.startsWith('data:') ? imgData : imageProcessor.toDataUrl(imgData)
                const refFileId = await imageProcessor.saveBase64ToGridFS(dataUrl, 'furniai-ref')
                taskDoc.referenceImages.push({ data: refFileId })
              } else {
                // 短字符串（可能是 GridFS fileId）→ 直接透传
                taskDoc.referenceImages.push({ data: imgData })
              }
            } catch (e) {
              console.warn('[FurnIAI] 参考图存储失败:', e.message)
            }
          }
        }
      } catch (e) {
        console.warn('[FurnIAI] 图片处理异常:', e.message)
      }

      // 创建任务前写入 timeline（单次调用无队列流程，在此一次性写入完整日志）
      const elapsed = ((now - startTime) / 1000).toFixed(1)
      const ctxInfo = callContext.apiPath
        ? `接口=${callContext.apiPath} | 认证=${callContext.authType || '未知'} | IP=${callContext.clientIP || '未知'}`
        : `来源=api`
      taskDoc.timeline = [
        { ts: startTime, phase: 'received', msg: `API 收到请求 | ${ctxInfo} | 类型=${taskType} | 通道=${resolvedChannel}` },
        { ts: startTime, phase: 'api_call', msg: `调用 AI API | 模型=${model || '未知'} | 通道=${resolvedChannel}` },
        { ts: now, phase: status === 'succeeded' ? 'task_completed' : 'task_failed', msg: status === 'succeeded' ? `任务完成 | 耗时=${elapsed}s | 模型=${model || '未知'} | 通道=${resolvedChannel}` : `任务失败 | 耗时=${elapsed}s` },
      ]

      FurniaiTask.create(taskDoc).catch(e => console.error('[FurnIAI] 任务记录创建失败:', e.message))
    })()
}

/**
 * 统一包装各类生图请求的公共逻辑（计费统计、任务写库记录）
 * actionFn 应返回 { result, responseData, logExtra }
 */
async function wrapAiGeneration(req, res, taskType, actionFn, costCalcType) {
  const startTime = new Date()
  const callCtx = extractCallContext(req, taskType)
  try {
    const { result, responseData, logExtra } = await actionFn()

    // 异步更新调用统计（平台密钥 or JWT）
    if (req.platformKey) {
      req.platformKey.recordSuccess(promptBuilder.calculateCreditCost(costCalcType)).catch(e => console.error('[FurnIAI] 平台统计更新失败:', e.message))
    } else {
      jwtCounter.recordSuccess().catch(e => console.error('[FurnIAI] JWT统计更新失败:', e.message))
    }

    // 异步记录任务（传入调用上下文）
    logSingleCallTask(req.userId, taskType, 'succeeded', startTime, result.channel, result.model, responseData.image, logExtra, callCtx)

    return res.json(successResponse(responseData, `${taskType} complete`))
  } catch (err) {
    if (req.platformKey) {
      req.platformKey.recordFailure().catch(e => console.error('[FurnIAI] 平台统计更新失败:', e.message))
    } else {
      jwtCounter.recordFailure().catch(e => console.error('[FurnIAI] JWT统计更新失败:', e.message))
    }
    logSingleCallTask(req.userId, taskType, 'failed', startTime, null, null, null, req._failLogExtra || {}, callCtx)
    console.error(`[FurnIAI] ${taskType} error:`, err.message)
    return res.status(500).json(errorResponse(`${taskType} failed: ` + err.message))
  }
}

/**
 * 统一包装纯文本/分析类请求的公共逻辑（统计记录、错误处理）
 * actionFn 应返回 { responseData, prompt }，其中 responseData 会直接作为成功响应的 data
 */
async function wrapAiAnalysis(req, res, taskType, actionFn) {
  const startTime = new Date()
  const callCtx = extractCallContext(req, taskType)
  try {
    const { responseData, prompt } = await actionFn()

    // 异步更新调用统计（平台密钥 or JWT）
    if (req.platformKey) {
      req.platformKey.recordSuccess().catch(e => console.error('[FurnIAI] 平台统计更新失败:', e.message))
    } else {
      jwtCounter.recordSuccess().catch(e => console.error('[FurnIAI] JWT统计更新失败:', e.message))
    }
    // 异步记录任务
    logSingleCallTask(req.userId, taskType, 'succeeded', startTime, null, null, null, { prompt }, callCtx)

    return res.json(successResponse(responseData, `${taskType} complete`))
  } catch (err) {
    if (req.platformKey) {
      req.platformKey.recordFailure().catch(e => console.error('[FurnIAI] 平台统计更新失败:', e.message))
    } else {
      jwtCounter.recordFailure().catch(e => console.error('[FurnIAI] JWT统计更新失败:', e.message))
    }
    logSingleCallTask(req.userId, taskType, 'failed', startTime, null, null, null, {}, callCtx)
    console.error(`[FurnIAI] ${taskType} error:`, err.message)
    return res.status(500).json(errorResponse(`${taskType} failed: ` + err.message))
  }
}

// ==================== 分析家具图片 ====================
exports.analyze = async (req, res) => {
  return wrapAiAnalysis(req, res, 'analyze', async () => {
    const { image } = req.body
    if (!image) throw new Error('Missing image')

    const base64 = await imageProcessor.normalizeImageInput(image)
    const prompt = promptBuilder.buildAnalyzePrompt()
    const result = await geminiClient.analyzeWithText(prompt, base64)

    let analysis
    try {
      analysis = safeParseJson(result.text)
    } catch (parseErr) {
      analysis = {
        category: 'OTHER', specificType: 'Unknown', materials: [],
        style: 'Unknown', primaryColor: 'Unknown', sizeEstimate: 'M',
        rawText: result.text,
      }
    }
    return { responseData: analysis, prompt }
  })
}

// ==================== 单张生图 ====================
exports.generate = async (req, res) => {
  return wrapAiGeneration(req, res, 'generate', async () => {
    const { image, taskType, analysis, options = {} } = req.body
    if (!image) throw new Error('Missing image')
    if (!taskType) throw new Error('Missing taskType')

    // 记录失败时的兜底属性
    req._failLogExtra = {
      prompt: promptBuilder.buildVisualPrompt(taskType, {}, options),
      referenceImages: [{ data: image }],
    }

    const base64 = await imageProcessor.normalizeImageInput(image)
    const prompt = promptBuilder.buildVisualPrompt(taskType, analysis || {}, options)

    const result = await geminiClient.generateImage(prompt, base64, {
      enableHD: options.enableHD,
      imageSize: options.imageSize,       // 前端透传图片分辨率
      aspectRatio: options.aspectRatio,   // 前端透传宽高比
    })

    const responseData = { text: result.text }
    if (result.image) responseData.image = imageProcessor.toDataUrl(result.image)

    return {
      result, responseData, logExtra: {
        prompt,
        referenceImages: [{ data: req.body.image }],
        userContext: options.userContext || '',
      }
    }
  }, req.body?.taskType || 'generate')
}

// ==================== 双图融合 ====================
exports.fuse = async (req, res) => {
  return wrapAiGeneration(req, res, 'fuse', async () => {
    const { sourceImage, targetImage, fusionMode, instruction, options = {} } = req.body
    if (!sourceImage || !targetImage) throw new Error('Missing sourceImage or targetImage')

    req._failLogExtra = { referenceImages: [{ data: sourceImage }, { data: targetImage }] }

    const [srcBase64, tgtBase64] = await Promise.all([
      imageProcessor.normalizeImageInput(sourceImage),
      imageProcessor.normalizeImageInput(targetImage)
    ])

    const prompt = promptBuilder.buildFusionPrompt(fusionMode || instruction || 'default')

    const result = await geminiClient.generateImage(prompt, srcBase64, {
      secondImageBase64: tgtBase64,
      imageSize: options.imageSize,       // 前端透传图片分辨率
      aspectRatio: options.aspectRatio,   // 前端透传宽高比
    })

    const responseData = { text: result.text }
    if (result.image) responseData.image = imageProcessor.toDataUrl(result.image)

    return {
      result, responseData, logExtra: {
        prompt,
        referenceImages: [{ data: req.body.sourceImage }, { data: req.body.targetImage }],
      }
    }
  }, 'fuse')
}

// ==================== 材质分析 ====================
exports.analyzeMaterial = async (req, res) => {
  return wrapAiAnalysis(req, res, 'material-analyze', async () => {
    const { image } = req.body
    if (!image) throw new Error('Missing image')

    const base64 = await imageProcessor.normalizeImageInput(image)
    const prompt = promptBuilder.buildMaterialAnalyzePrompt()
    const result = await geminiClient.analyzeWithText(prompt, base64)

    let parsed
    try { parsed = safeParseJson(result.text) }
    catch { parsed = { name: 'Unknown', category: 'Other', tags: [], rawText: result.text } }

    return { responseData: parsed, prompt }
  })
}

// ==================== 材质贴图替换 ====================
exports.applyMaterial = async (req, res) => {
  return wrapAiGeneration(req, res, 'material-apply', async () => {
    const { productImage, materialImage, materialName, targetPart, excludeParts, options = {} } = req.body
    if (!productImage || !materialImage) throw new Error('Missing productImage or materialImage')

    req._failLogExtra = { referenceImages: [{ data: productImage }, { data: materialImage }] }

    const [prodBase64, matBase64] = await Promise.all([
      imageProcessor.normalizeImageInput(productImage),
      imageProcessor.normalizeImageInput(materialImage)
    ])
    const prompt = promptBuilder.buildMaterialApplyPrompt(materialName, targetPart, excludeParts)

    const result = await geminiClient.generateImage(prompt, prodBase64, {
      secondImageBase64: matBase64,
      imageSize: options.imageSize,       // 前端透传图片分辨率
      aspectRatio: options.aspectRatio,   // 前端透传宽高比
    })

    const responseData = { text: result.text }
    if (result.image) responseData.image = imageProcessor.toDataUrl(result.image)

    return {
      result, responseData, logExtra: {
        prompt,
        referenceImages: [{ data: req.body.productImage }, { data: req.body.materialImage }],
      }
    }
  }, 'material-apply')
}

// ==================== 家具部件检测 ====================
exports.detectElements = async (req, res) => {
  return wrapAiAnalysis(req, res, 'detect-elements', async () => {
    const { image, lang = 'en' } = req.body
    if (!image) throw new Error('Missing image')

    const base64 = await imageProcessor.normalizeImageInput(image)
    const prompt = promptBuilder.buildElementDetectPrompt(lang)
    const result = await geminiClient.analyzeWithText(prompt, base64)

    let elements = []
    try {
      elements = safeParseJson(result.text)
      elements = elements.filter(el =>
        el.label && Array.isArray(el.box_2d) && el.box_2d.length === 4 &&
        el.box_2d[0] < el.box_2d[2] && el.box_2d[1] < el.box_2d[3]
      )
    } catch { elements = [] }

    return { responseData: elements, prompt }
  })
}

// ==================== AI 修图 ====================
exports.edit = async (req, res) => {
  return wrapAiGeneration(req, res, 'edit', async () => {
    const { image, instruction, referenceImage, options = {} } = req.body
    if (!image) throw new Error('Missing image')
    if (!instruction) throw new Error('Missing instruction')

    req._failLogExtra = { referenceImages: [{ data: image }, referenceImage && { data: referenceImage }].filter(Boolean) }

    const [base64, refBase64] = await Promise.all([
      imageProcessor.normalizeImageInput(image),
      referenceImage ? imageProcessor.normalizeImageInput(referenceImage) : Promise.resolve(null)
    ])

    const prompt = promptBuilder.buildEditPrompt(instruction, !!refBase64)

    const result = await geminiClient.generateImage(prompt, base64, {
      secondImageBase64: refBase64,
      imageSize: options.imageSize,       // 前端透传图片分辨率
      aspectRatio: options.aspectRatio,   // 前端透传宽高比
    })

    const responseData = { text: result.text }
    if (result.image) responseData.image = imageProcessor.toDataUrl(result.image)

    return {
      result, responseData, logExtra: {
        prompt,
        referenceImages: req._failLogExtra.referenceImages,
      }
    }
  }, 'edit')
}

// ==================== Excel 表头分析 ====================
exports.analyzeExcelHeaders = async (req, res) => {
  return wrapAiAnalysis(req, res, 'excel-headers', async () => {
    const { headers } = req.body
    if (!headers || !Array.isArray(headers) || headers.length === 0) {
      throw new Error('Missing or empty headers array')
    }

    const prompt = promptBuilder.buildExcelHeaderPrompt(headers)
    const result = await geminiClient.analyzeWithText(prompt)

    let parsed
    try { parsed = safeParseJson(result.text) }
    catch { parsed = { usefulColumns: headers, ignoreColumns: [], columnTypes: {} } }

    return { responseData: parsed, prompt }
  })
}

// ==================== Excel 行解析 ====================
exports.parseExcelRow = async (req, res) => {
  return wrapAiAnalysis(req, res, 'excel-row', async () => {
    const { rowData } = req.body
    if (!rowData || typeof rowData !== 'object') throw new Error('Missing or invalid rowData')

    const prompt = promptBuilder.buildExcelRowPrompt(rowData)
    const result = await geminiClient.analyzeWithText(prompt)

    let parsed
    try { parsed = safeParseJson(result.text) }
    catch { parsed = { productName: '', notes: 'Parse failed', rawText: result.text } }

    return { responseData: parsed, prompt }
  })
}

// ==================== 批量任务：提交 ====================
exports.batchSubmit = async (req, res) => {
  try {
    const { requestId, referenceImages, taskTypes, options = {} } = req.body

    if (!referenceImages || !Array.isArray(referenceImages) || referenceImages.length === 0) {
      return res.status(400).json(errorResponse('Missing referenceImages'))
    }
    if (!taskTypes || !Array.isArray(taskTypes) || taskTypes.length === 0) {
      return res.status(400).json(errorResponse('Missing taskTypes'))
    }

    // 幂等检查
    if (requestId) {
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000)
      const existing = await FurniaiTask.findOne({ requestId, createdAt: { $gte: tenMinAgo } })
      if (existing) {
        return res.json(successResponse({
          taskId: existing._id,
          status: existing.status,
          progress: existing.progress,
          duplicate: true,
        }, 'Task already exists (idempotent)'))
      }
    }

    const items = taskTypes.map(type => ({
      taskType: type,
      status: 'pending',
      options: {},
    }))

    const task = await FurniaiTask.create({
      requestId: requestId || `auto_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      operatorId: req.user._id || req.userId,
      source: 'furniai',
      referenceImages: referenceImages.map(img =>
        typeof img === 'string' ? { data: img } : img
      ),
      items,
      options: {
        style: options.style || '',
        userContext: options.userContext || '',
        enableHD: options.enableHD || false,
        imageSize: options.imageSize || '',         // 用户指定的图片分辨率（透传）
        aspectRatio: options.aspectRatio || '',     // 用户指定的宽高比（透传）
        lang: options.lang || 'en',
        // 将 auto 解析为实际通道 ID，确保绑定到具体通道
        channel: resolveAutoChannelId(options.channel),
      },
    })

    console.log(`[FurnIAI] Batch created: taskId=${task._id}, types=${taskTypes.join(',')}`)

    // 任务创建即写入 timeline（包含完整调用链信息）
    const ctx = extractCallContext(req, taskTypes.join(','))
    taskQueue.pushTimeline(task._id, 'furniai', 'received', `API 收到批量任务请求 | 接口=${ctx.apiPath} | 认证=${ctx.authType} | IP=${ctx.clientIP} | requestId=${task.requestId} | 类型=${taskTypes.join(',')} | 参考图=${referenceImages.length}张 | 通道=${task.options.channel}`)

    // 异步将 base64 参考图上传到 GridFS（不阻塞响应，确保管理面板能展示参考图）
    setImmediate(async () => {
      try {
        const updatedRefs = []
        let changed = false
        for (const ref of task.referenceImages) {
          const val = ref.data || ref
          if (typeof val === 'string' && val.startsWith('data:image')) {
            // base64 → GridFS
            const fileId = await imageProcessor.saveBase64ToGridFS(val, 'furniai-ref')
            updatedRefs.push({ data: String(fileId) })
            changed = true
          } else {
            updatedRefs.push(ref)
          }
        }
        if (changed) {
          await FurniaiTask.updateOne({ _id: task._id }, { $set: { referenceImages: updatedRefs } })
          console.log(`[FurnIAI] 参考图已上传 GridFS: taskId=${task._id}`)
        }
      } catch (e) {
        console.error(`[FurnIAI] 参考图上传 GridFS 失败: ${e.message}`)
      }
    })

    // 异步入队
    setImmediate(() => taskQueue.enqueue(task._id))

    return res.status(201).json(successResponse({
      taskId: task._id,
      status: 'queued',
      progress: 0,
      totalItems: items.length,
    }, 'Task submitted'))
  } catch (err) {
    console.error('[FurnIAI] batchSubmit error:', err.message)
    return res.status(500).json(errorResponse('Submit failed: ' + err.message))
  }
}

// ==================== 批量任务：查询状态 ====================
exports.batchGet = async (req, res) => {
  try {
    const { taskId } = req.params
    const task = await FurniaiTask.findById(taskId).lean()
    if (!task) return res.status(404).json(errorResponse('Task not found'))

    return res.json(successResponse({
      taskId: task._id,
      requestId: task.requestId,
      status: task.status,
      progress: task.progress,
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
    console.error('[FurnIAI] batchGet error:', err.message)
    return res.status(500).json(errorResponse('Query failed'))
  }
}

// ==================== 批量任务：列表 ====================
exports.batchList = async (req, res) => {
  try {
    const { page = 1, pageSize = 20 } = req.query
    const p = Math.max(1, parseInt(page, 10) || 1)
    const ps = Math.max(1, parseInt(pageSize, 10) || 20)
    const query = { operatorId: req.user._id || req.userId }

    const total = await FurniaiTask.countDocuments(query)
    const tasks = await FurniaiTask.find(query)
      .sort({ createdAt: -1 })
      .skip((p - 1) * ps)
      .limit(ps)
      .lean()

    const list = tasks.map(t => ({
      taskId: t._id,
      status: t.status,
      progress: t.progress,
      itemsSummary: {
        total: t.items.length,
        completed: t.items.filter(i => i.status === 'completed').length,
        failed: t.items.filter(i => i.status === 'failed').length,
      },
      createdAt: t.createdAt,
      completedAt: t.completedAt,
    }))

    return res.json(paginatedResponse(list, total, p, ps))
  } catch (err) {
    console.error('[FurnIAI] batchList error:', err.message)
    return res.status(500).json(errorResponse('List failed'))
  }
}

// ==================== 批量任务：重试 ====================
exports.batchRetry = async (req, res) => {
  try {
    const { taskId } = req.params
    const task = await FurniaiTask.findById(taskId)
    if (!task) return res.status(404).json(errorResponse('Task not found'))

    if (task.status !== 'succeeded' && task.status !== 'failed') {
      return res.status(400).json(errorResponse(`Cannot retry task with status: ${task.status}`))
    }

    let resetCount = 0
    for (const item of task.items) {
      if (item.status === 'failed') {
        item.status = 'pending'
        item.error = null
        item.resultFileId = null
        item.resultBase64 = null
        item.startedAt = null
        item.completedAt = null
        resetCount++
      }
    }

    if (resetCount === 0) {
      return res.status(400).json(errorResponse('No failed items to retry'))
    }

    task.status = 'queued'
    task.progress = 0
    task.error = null
    task.completedAt = null
    task.retryCount += 1
    task.updatedAt = new Date()
    await task.save()

    // 重试事件写入 timeline
    taskQueue.pushTimeline(task._id, 'furniai', 'retry', `任务重试（第${task.retryCount}次）| 重置 ${resetCount} 个失败子项`)

    setImmediate(() => taskQueue.enqueue(task._id))

    return res.json(successResponse({
      taskId: task._id,
      status: 'queued',
      resetItems: resetCount,
      retryCount: task.retryCount,
    }, 'Retry submitted'))
  } catch (err) {
    console.error('[FurnIAI] batchRetry error:', err.message)
    return res.status(500).json(errorResponse('Retry failed'))
  }
}

// ==================== 批量任务：取消 ====================
exports.batchCancel = async (req, res) => {
  try {
    const { taskId } = req.params
    const task = await FurniaiTask.findById(taskId)
    if (!task) return res.status(404).json(errorResponse('Task not found'))

    if (task.status === 'succeeded' || task.status === 'canceled') {
      return res.status(400).json(errorResponse(`Cannot cancel task with status: ${task.status}`))
    }

    await FurniaiTask.updateOne({ _id: taskId }, {
      $set: {
        status: 'canceled',
        updatedAt: new Date()
      }
    });

    return res.json(successResponse({ taskId: task._id, status: 'canceled' }, 'Task canceled'))
  } catch (err) {
    console.error('[FurnIAI] batchCancel error:', err.message)
    return res.status(500).json(errorResponse('Cancel failed'))
  }
}

// ==================== 执行计划优化 ====================
exports.refineExecutionPlan = async (req, res) => {
  return wrapAiAnalysis(req, res, 'refine-plan', async () => {
    const { analysis, userContext, lang } = req.body
    if (!analysis) throw new Error('Missing analysis data')

    const prompt = promptBuilder.buildExecutionPlanPrompt(analysis, userContext, lang)
    const result = await geminiClient.analyzeWithText(prompt)

    return { responseData: { plan: result.text || '' }, prompt }
  })
}

// ==================== 单元素分割 ====================
exports.segmentElement = async (req, res) => {
  return wrapAiAnalysis(req, res, 'segment-element', async () => {
    const { image, elementLabel } = req.body
    if (!image || !elementLabel) throw new Error('Missing image or elementLabel')

    const base64 = await imageProcessor.normalizeImageInput(image)
    const prompt = promptBuilder.buildSegmentElementPrompt(elementLabel)
    const result = await geminiClient.analyzeWithText(prompt, base64)

    const text = typeof result === 'string' ? result : (result?.text || '')
    const jsonMatch = text.match(/\[[\s\S]*?\]/)
    if (!jsonMatch) return { responseData: [], prompt }

    const parsed = JSON.parse(jsonMatch[0])
    const segments = parsed.map(item => ({
      label: item.label || elementLabel,
      box_2d: item.box_2d || [0, 0, 1000, 1000],
      mask: item.mask || ''
    }))
    return { responseData: segments, prompt }
  })
}

// ==================== 电商卖点生成 ====================
exports.generateSellingPoints = async (req, res) => {
  return wrapAiAnalysis(req, res, 'selling-points', async () => {
    const { image, analysis, lang, pointCount, excelContext } = req.body
    if (!image || !analysis) throw new Error('Missing image or analysis')

    const base64 = await imageProcessor.normalizeImageInput(image)
    const prompt = promptBuilder.buildSellingPointsPrompt(analysis, { lang, pointCount, excelContext })
    const result = await geminiClient.analyzeWithText(prompt + '\n\nReturn ONLY valid JSON, no markdown.', base64)

    const text = typeof result === 'string' ? result : (result?.text || '{}')
    const cleanText = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
    const parsed = safeParseJson(cleanText)
    const count = pointCount || 3
    const sellingPoints = (parsed.sellingPoints || []).slice(0, count).map((sp, idx) => ({
      id: `sp_${Date.now()}_${idx}`,
      title: sp.title || '',
      description: sp.description || '',
      icon: sp.icon || 'star',
    }))

    return { responseData: { sellingPoints, slogan: parsed.slogan || '' }, prompt }
  })
}

// ==================== 画布描述提取 ====================
exports.extractCanvasPrompt = async (req, res) => {
  return wrapAiAnalysis(req, res, 'canvas-prompt', async () => {
    const { itemDescriptions, lang } = req.body
    if (!itemDescriptions) throw new Error('Missing itemDescriptions')

    const prompt = promptBuilder.buildCanvasPromptExtract(itemDescriptions, lang)
    const result = await geminiClient.analyzeWithText(prompt)

    return { responseData: { description: result.text || '' }, prompt }
  })
}

// ==================== 家具图片深度分析 ====================
exports.deepAnalyze = async (req, res) => {
  return wrapAiAnalysis(req, res, 'deep-analyze', async () => {
    const { image } = req.body
    if (!image) throw new Error('Missing image')

    // 标准化图片输入（支持 base64 / data URL / fileId）
    const base64 = await imageProcessor.normalizeImageInput(image)
    const prompt = promptBuilder.buildDeepAnalysisPrompt()
    const result = await geminiClient.analyzeWithText(prompt, base64)

    // 解析 AI 返回的 JSON 结果
    let analysis
    try {
      analysis = safeParseJson(result.text)
    } catch (parseErr) {
      // JSON 解析失败时返回原始文本，方便调试
      analysis = {
        productName: '解析失败',
        targetAudience: '',
        coreSellingPoints: [],
        materialProfile: { material: '', gloss: '', form: '' },
        craftDetails: { structure: '', stitching: '', hardware: '', specialDesign: '' },
        functionalExperience: { breathability: '', elasticity: '', durability: '', seasonAdapt: '' },
        sceneMatching: { bestScenes: [], stylePosition: [], matchSuggestions: [] },
        rawText: result.text,
      }
    }
    return { responseData: analysis, prompt }
  })
}


// ==================== 配置查询（公开） ====================
exports.getConfig = async (req, res) => {
  try {
    return res.json(successResponse({
      creditCosts: promptBuilder.CREDIT_COSTS,
      multiViewSubtypes: promptBuilder.MULTI_VIEW_SUBTYPES,
      gemini: geminiClient.getConfig(),
      queue: taskQueue.getQueueStats(),
    }, 'Config loaded'))
  } catch (err) {
    return res.status(500).json(errorResponse('Config failed'))
  }
}

