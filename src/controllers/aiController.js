/**
 * FurnIAI — AI Controller
 * REST 接口控制器，处理素材管理、AI 生成、积分管理、场景模板管理、配置数据、使用到商品
 */
const AiCredit = require('../models/AiCredit')
const AiMaterial = require('../models/AiMaterial')
const SceneTemplate = require('../models/SceneTemplate')
const FurniaiTask = require('../models/FurniaiTask')
const { successResponse, errorResponse, paginatedResponse } = require('../utils/response')
const geminiProxy = require('../services/geminiProxyService')
const jwtCounter = require('../utils/jwtCounter')
const crypto = require('crypto')

// 统一记录 API 调用统计的闭包辅助函数
const recordApiUsage = (req, isSuccess, cost = 0) => {
  const target = req.platformKey || jwtCounter
  const action = isSuccess ? target.recordSuccess(cost) : target.recordFailure()
  action.catch(e => console.error('[AI] 统计更新失败:', e.message))
}

// 异步创建单次调用的任务记录（不阻塞响应，小程序路由专用）
function logSingleCallTask(userId, taskType, status, startTime, req) {
  const now = new Date()
  const elapsed = ((now - startTime) / 1000).toFixed(1)
  // 提取调用上下文
  const xff = req?.headers?.['x-forwarded-for']
  const clientIP = xff ? xff.split(',')[0].trim() : (req?.ip || req?.connection?.remoteAddress || '未知')
  const authType = req?.platformKey ? `平台密钥[${req.platformKey.name}]` : (req?.user ? 'JWT' : '未知')
  const apiPath = req?.originalUrl || '未知'
  FurniaiTask.create({
    requestId: 'miniapp-' + crypto.randomBytes(8).toString('hex'),
    operatorId: userId || 'unknown',
    source: 'miniapp',
    items: [{ taskType, status: status === 'succeeded' ? 'completed' : 'failed', startedAt: startTime, completedAt: now }],
    options: { channel: 'auto' },
    status,
    progress: 100,
    startedAt: startTime,
    completedAt: now,
    timeline: [
      { ts: startTime, phase: 'received', msg: `API 收到请求 | 接口=${apiPath} | 认证=${authType} | IP=${clientIP} | 类型=${taskType}` },
      { ts: now, phase: status === 'succeeded' ? 'task_completed' : 'task_failed', msg: `${status === 'succeeded' ? '任务完成' : '任务失败'} | 耗时=${elapsed}s` },
    ],
  }).catch(e => console.error('[AI] 任务记录创建失败:', e.message))
}

// ========== 素材管理 ==========

exports.getMaterials = async (req, res) => {
  try {
    const { type, page: rawPage = 1, pageSize: rawPageSize = 20 } = req.query
    const page = Math.max(1, parseInt(rawPage, 10) || 1)
    const pageSize = Math.max(1, Math.min(100, parseInt(rawPageSize, 10) || 20))
    const query = { userId: req.userId }
    if (type) query.type = type

    const [total, materials] = await Promise.all([
      AiMaterial.countDocuments(query),
      AiMaterial.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean()
    ])

    return res.json(paginatedResponse(materials, total, page, pageSize))
  } catch (err) {
    console.error('[AI] getMaterials error:', err)
    return res.status(500).json(errorResponse('获取素材列表失败'))
  }
}

exports.saveMaterial = async (req, res) => {
  try {
    const { title, type, image, thumbnail, tags, sourceType, sourceParams, width, height } = req.body
    if (!title || !type || !image) {
      return res.status(400).json(errorResponse('缺少必要参数'))
    }

    const material = await AiMaterial.create({
      userId: req.userId,
      title,
      type,
      image,
      thumbnail: thumbnail || '',
      tags: tags || [],
      sourceType: sourceType || 'generate',
      sourceParams: sourceParams || {},
      width: width || 0,
      height: height || 0
    })

    return res.json(successResponse(material, '素材保存成功'))
  } catch (err) {
    console.error('[AI] saveMaterial error:', err)
    return res.status(500).json(errorResponse('保存素材失败'))
  }
}

exports.deleteMaterial = async (req, res) => {
  try {
    const { id } = req.params
    const material = await AiMaterial.findOneAndDelete({ _id: id, userId: req.userId })
    if (!material) {
      return res.status(404).json(errorResponse('素材不存在'))
    }
    return res.json(successResponse(null, '删除成功'))
  } catch (err) {
    console.error('[AI] deleteMaterial error:', err)
    return res.status(500).json(errorResponse('删除素材失败'))
  }
}

exports.batchDeleteMaterials = async (req, res) => {
  try {
    const { ids } = req.body
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json(errorResponse('请选择要删除的素材'))
    }

    const result = await AiMaterial.deleteMany({ _id: { $in: ids }, userId: req.userId })
    return res.json(successResponse({ deletedCount: result.deletedCount }, `成功删除 ${result.deletedCount} 个素材`))
  } catch (err) {
    console.error('[AI] batchDeleteMaterials error:', err)
    return res.status(500).json(errorResponse('批量删除失败'))
  }
}

// ========== AI 生成 ==========

exports.analyzeImage = async (req, res) => {
  const startTime = new Date()
  let credit = null;
  let cost = 0;
  let consumed = false;
  try {
    const { image } = req.body
    if (!image) {
      return res.status(400).json(errorResponse('请提供图片'))
    }

    // 扣积分
    credit = await AiCredit.getOrCreate(req.userId)
    cost = geminiProxy.calculateCreditCost('analyze')
    await credit.consume(cost, 'AI图片分析')
    consumed = true;

    const analysis = await geminiProxy.analyzeFurnitureImage(image)

    // 异步更新调用统计（成功）
    recordApiUsage(req, true, cost)
    // 异步记录任务
    logSingleCallTask(req.userId, 'miniapp-analyze', 'succeeded', startTime, req)

    return res.json(successResponse({ analysis, creditCost: cost, creditBalance: credit.balance }))
  } catch (err) {
    console.error('[AI] analyzeImage error:', err)
    // 异常回滚积分
    if (credit && consumed) {
      await credit.refund(cost, 'AI分析失败退还').catch(e => console.error('[AI] 退款失败:', e))
    }
    // 异步更新调用统计（失败）
    recordApiUsage(req, false)
    // 异步记录任务（失败）
    logSingleCallTask(req.userId, 'miniapp-analyze', 'failed', startTime, req)
    if (err.message === '积分余额不足') {
      return res.status(400).json(errorResponse('积分余额不足'))
    }
    return res.status(500).json(errorResponse('AI分析失败: ' + err.message))
  }
}

exports.generateImage = async (req, res) => {
  const startTime = new Date()
  let credit = null;
  let cost = 0;
  let consumed = false;
  try {
    const { type, image, options = {} } = req.body
    if (!type || !image) {
      return res.status(400).json(errorResponse('缺少必要参数'))
    }

    // 计算积分消耗
    cost = geminiProxy.calculateCreditCost(type, options)
    credit = await AiCredit.getOrCreate(req.userId)
    await credit.consume(cost, `AI生成-${type}`, '')
    consumed = true;

    // 调用 AI 生成
    const result = await geminiProxy.generateFurnitureVisual(image, type, options)

    // 异步更新调用统计（成功）
    recordApiUsage(req, true, cost)
    // 异步记录任务
    logSingleCallTask(req.userId, 'miniapp-generate', 'succeeded', startTime, req)

    return res.json(successResponse({
      image: result.image ? `data:image/png;base64,${result.image}` : null,
      text: result.text,
      creditCost: cost,
      creditBalance: credit.balance
    }))
  } catch (err) {
    console.error('[AI] generateImage error:', err)
    // 异常回滚积分
    if (credit && consumed) {
      await credit.refund(cost, 'AI生成失败退还').catch(e => console.error('[AI] 退款失败:', e))
    }
    // 异步更新调用统计（失败）
    recordApiUsage(req, false)
    // 异步记录任务（失败）
    logSingleCallTask(req.userId, 'miniapp-generate', 'failed', startTime, req)
    if (err.message === '积分余额不足') {
      return res.status(400).json(errorResponse('积分余额不足'))
    }
    return res.status(500).json(errorResponse('AI生成失败: ' + err.message))
  }
}

exports.uploadImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json(errorResponse('请上传图片'))
    }

    const base64 = req.file.buffer.toString('base64')
    const mimeType = req.file.mimetype
    const imageData = `data:${mimeType};base64,${base64}`

    return res.json(successResponse({
      image: imageData,
      originalName: req.file.originalname,
      size: req.file.size,
      mimeType
    }))
  } catch (err) {
    console.error('[AI] uploadImage error:', err)
    return res.status(500).json(errorResponse('上传失败'))
  }
}

// ========== 积分 ==========

exports.getCredits = async (req, res) => {
  try {
    const credit = await AiCredit.getOrCreate(req.userId)
    return res.json(successResponse({
      balance: credit.balance,
      totalConsumed: credit.totalConsumed,
      totalRecharged: credit.totalRecharged
    }))
  } catch (err) {
    console.error('[AI] getCredits error:', err)
    return res.status(500).json(errorResponse('获取积分信息失败'))
  }
}

exports.getCreditHistory = async (req, res) => {
  try {
    const { page: rawPage = 1, pageSize: rawPageSize = 20 } = req.query
    const page = Math.max(1, parseInt(rawPage, 10) || 1)
    const pageSize = Math.max(1, Math.min(100, parseInt(rawPageSize, 10) || 20))
    const credit = await AiCredit.getOrCreate(req.userId)

    const history = credit.history
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice((page - 1) * pageSize, page * pageSize)

    return res.json(paginatedResponse(history, credit.history.length, page, pageSize))
  } catch (err) {
    console.error('[AI] getCreditHistory error:', err)
    return res.status(500).json(errorResponse('获取积分记录失败'))
  }
}

// ========== 场景模板 ==========

exports.getSceneTemplates = async (req, res) => {
  try {
    const { style, space, keyword, page: rawPage2 = 1, pageSize: rawPageSize2 = 20 } = req.query
    const page = Math.max(1, parseInt(rawPage2, 10) || 1)
    const pageSize = Math.max(1, Math.min(100, parseInt(rawPageSize2, 10) || 20))
    const query = { status: 'active' }
    if (style) query.style = style
    if (space) query.space = space
    if (keyword) {
      // 转义正则特殊字符，防止用户构造恶意正则导致 ReDoS
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      query.$or = [
        { name: { $regex: escaped, $options: 'i' } },
        { tags: { $in: [new RegExp(escaped, 'i')] } }
      ]
    }

    const [total, templates] = await Promise.all([
      SceneTemplate.countDocuments(query),
      SceneTemplate.find(query)
        .sort({ sortOrder: -1, createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(parseInt(pageSize))
        .lean()
    ])

    return res.json(paginatedResponse(templates, total, page, pageSize))
  } catch (err) {
    console.error('[AI] getSceneTemplates error:', err)
    return res.status(500).json(errorResponse('获取场景模板失败'))
  }
}

exports.createSceneTemplate = async (req, res) => {
  try {
    const { name, style, space, image, thumbnail, orientation, popular, sortOrder, tags, description } = req.body
    if (!name || !style || !space || !image) {
      return res.status(400).json(errorResponse('缺少必要参数'))
    }

    const template = await SceneTemplate.create({
      name, style, space, image,
      thumbnail: thumbnail || '',
      orientation: orientation || 'landscape',
      popular: popular || false,
      sortOrder: sortOrder || 0,
      tags: tags || [],
      description: description || ''
    })

    return res.json(successResponse(template, '创建成功'))
  } catch (err) {
    console.error('[AI] createSceneTemplate error:', err)
    return res.status(500).json(errorResponse('创建场景模板失败'))
  }
}

exports.updateSceneTemplate = async (req, res) => {
  try {
    const { id } = req.params
    // 白名单提取允许更新的字段，防止注入 _id/$set 等非预期操作
    const allowedFields = ['name', 'style', 'space', 'image', 'thumbnail', 'orientation', 'popular', 'sortOrder', 'tags', 'description', 'status']
    const update = {}
    for (const key of allowedFields) {
      if (req.body[key] !== undefined) update[key] = req.body[key]
    }
    const template = await SceneTemplate.findByIdAndUpdate(id, update, { new: true })
    if (!template) {
      return res.status(404).json(errorResponse('模板不存在'))
    }
    return res.json(successResponse(template, '更新成功'))
  } catch (err) {
    console.error('[AI] updateSceneTemplate error:', err)
    return res.status(500).json(errorResponse('更新失败'))
  }
}

exports.deleteSceneTemplate = async (req, res) => {
  try {
    const { id } = req.params
    const template = await SceneTemplate.findByIdAndDelete(id)
    if (!template) {
      return res.status(404).json(errorResponse('模板不存在'))
    }
    return res.json(successResponse(null, '删除成功'))
  } catch (err) {
    console.error('[AI] deleteSceneTemplate error:', err)
    return res.status(500).json(errorResponse('删除失败'))
  }
}

// ========== 配置数据 ==========

const STYLE_OPTIONS = [
  { id: 'modern', name: '现代简约' },
  { id: 'nordic', name: '北欧风格' },
  { id: 'chinese', name: '新中式' },
  { id: 'light-luxury', name: '轻奢风' },
  { id: 'industrial', name: '工业风' },
  { id: 'japanese', name: '日式' }
]

const SPACE_OPTIONS = [
  { id: 'living', name: '客厅' },
  { id: 'bedroom', name: '卧室' },
  { id: 'dining', name: '餐厅' },
  { id: 'study', name: '书房' },
  { id: 'balcony', name: '阳台' }
]

const FABRIC_OPTIONS = [
  { id: 'italian-leather', name: '意大利头层牛皮', tag: '推荐', priceAdd: 800 },
  { id: 'nappa-leather', name: 'Nappa真皮', tag: '热门', priceAdd: 600 },
  { id: 'tech-fabric', name: '科技布', tag: '', priceAdd: 0 },
  { id: 'cotton-linen', name: '棉麻混纺', tag: '', priceAdd: 200 },
  { id: 'velvet', name: '丝绒', tag: '', priceAdd: 400 },
  { id: 'microfiber', name: '超纤皮', tag: '', priceAdd: 300 }
]

const COLOR_OPTIONS = [
  { id: 'mc-black', name: '黑色', color: '#1a1a1a' },
  { id: 'mc-dark-brown', name: '深棕', color: '#3d2b1f' },
  { id: 'mc-brown', name: '棕色', color: '#6b4423' },
  { id: 'mc-camel', name: '驼色', color: '#c19a6b' },
  { id: 'mc-gray', name: '灰色', color: '#808080' },
  { id: 'mc-olive', name: '橄榄绿', color: '#808000' },
  { id: 'mc-cream', name: '米白', color: '#f5f5dc' },
  { id: 'mc-tan', name: '浅棕', color: '#d2b48c' },
  { id: 'mc-charcoal', name: '炭灰', color: '#36454f' },
  { id: 'mc-navy', name: '藏青', color: '#000080' },
  { id: 'mc-burgundy', name: '酒红', color: '#800020' },
  { id: 'mc-sand', name: '沙色', color: '#c2b280' }
]

exports.getStyleOptions = async (req, res) => {
  return res.json(successResponse(STYLE_OPTIONS))
}

exports.getSpaceOptions = async (req, res) => {
  return res.json(successResponse(SPACE_OPTIONS))
}

exports.getFabricOptions = async (req, res) => {
  return res.json(successResponse(FABRIC_OPTIONS))
}

exports.getColorOptions = async (req, res) => {
  return res.json(successResponse(COLOR_OPTIONS))
}

// ========== 使用到商品 ==========

exports.useInProduct = async (req, res) => {
  let credit = null;
  let creditCost = 0;
  let consumed = false;
  try {
    const { image, fabric, color, specs, productId, usageType = 'texture-replace' } = req.body
    if (!image) {
      return res.status(400).json(errorResponse('缺少商品图片'))
    }
    if (!fabric && !color) {
      return res.status(400).json(errorResponse('请至少指定目标面料(fabric)或颜色(color)'))
    }

    // 1. 扣减积分
    creditCost = geminiProxy.calculateCreditCost('texture-replace')
    credit = await AiCredit.getOrCreate(req.userId)
    if (credit.balance < creditCost) {
      return res.status(403).json(errorResponse(`积分不足，需要 ${creditCost} 积分，当前余额 ${credit.balance}`))
    }
    await credit.consume(creditCost, `材质替换: ${fabric || ''} ${color || ''}`)
    consumed = true;

    // 2. 调用 AI 生成材质替换图片
    const startTime = new Date()
    const result = await geminiProxy.generateFurnitureVisual(image, 'texture-replace', {
      fabric: fabric || '',
      color: color || '',
      description: specs || '',
    })

    if (!result.image) {
      // AI 未返回图片，退还积分
      await credit.refund(creditCost, '材质替换失败-未生成图片')
      consumed = false;
      // 记录失败任务
      logSingleCallTask(req.userId, 'texture-replace', 'failed', startTime, req)
      recordApiUsage(req, false)
      return res.status(500).json(errorResponse('AI 未能生成替换图片，积分已退还'))
    }

    // 3. 保存生成的素材到 AiMaterial
    const material = await AiMaterial.create({
      userId: req.userId,
      title: `材质替换 - ${fabric || color || '自定义'}`,
      type: 'texture',
      image: `data:image/png;base64,${result.image}`,
      tags: [fabric, color, usageType].filter(Boolean),
      sourceType: 'generate',
      sourceParams: { productId, fabric, color, specs, usageType },
    })

    // 4. 记录成功任务
    logSingleCallTask(req.userId, 'texture-replace', 'succeeded', startTime, req)

    // 5. 更新调用统计
    recordApiUsage(req, true, creditCost)

    return res.json(successResponse({
      materialId: material._id,
      image: `data:image/png;base64,${result.image}`,
      text: result.text || '',
      creditCost,
      remainingCredits: credit.balance - creditCost,
    }, '材质替换成功'))
  } catch (err) {
    console.error('[AI] useInProduct error:', err)
    // 异常回滚积分
    if (credit && consumed) {
      await credit.refund(creditCost, '材质替换失败退还').catch(e => console.error('[AI] 退款失败:', e))
    }
    recordApiUsage(req, false)
    return res.status(500).json(errorResponse('材质替换失败: ' + err.message))
  }
}
