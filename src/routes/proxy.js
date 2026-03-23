/**
 * New API 中转路由 — 纯透传 + 平台密钥鉴权 + 大盘统计
 * 
 * 前端调用: POST https://hzh.sealos.run/proxy/v1/chat/completions
 * 本路由:   鉴权(pk-xxx) → 转发到 http://zx2.52youxi.cc:3000/v1/chat/completions → 记录统计
 * 
 * 统计规则：只有 POST /v1/chat/completions（生图请求）才记录任务和统计
 *          其他请求（如 GET /v1/models）只做透传，不记录
 */
const express = require('express')
const router = express.Router()
const axios = require('axios')
const http = require('http')
const https = require('https')
const { auth } = require('../middleware/auth')
const FurniaiTask = require('../models/FurniaiTask')
const crypto = require('crypto')
const configManager = require('../services/configManager')
const jwtCounter = require('../utils/jwtCounter')

// HTTP(S) Keep-Alive 连接复用 — 避免每次请求重新建立 TCP/TLS 握手（省 100-300ms/次）
const httpKeepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 10 })
const httpsKeepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 10 })

// 动态获取当前活动的通道（考虑到 channelPriority 优先级）
function getActiveChannel() {
    const config = configManager.get()
    const mode = config?.channelMode || 'auto'
    const list = config?.channelPriority || []

    // 如果不是 auto，直接按 id 查找通道
    let activeId = mode
    if (mode === 'auto') {
        const firstActive = list.find(c => c.enabled)
        activeId = firstActive ? firstActive.id : 'concurrent'
    }

    const activeCh = list.find(c => c.id === activeId)
    // 如果找不到，返回一个空的结构防报错
    return activeCh || {}
}

/**
 * 获取所有已启用通道列表（按 channelPriority 排序），用于通道降级重试
 * @returns {Array<Object>} 已启用通道列表
 */
function getAllActiveChannels() {
    const config = configManager.get()
    const list = config?.channelPriority || []
    return list.filter(c => c.enabled)
}

function getProxyTarget() { return getActiveChannel().url || process.env.NEWAPI_TARGET || 'http://zx2.52youxi.cc:3000' }
function getProxyKey() { return getActiveChannel().apiKey || process.env.NEWAPI_KEY || '' }
function getProxyChannelName() { return getActiveChannel().name || '未知配置' }
function getProxyChannelId() { return getActiveChannel().id || 'auto' }

/**
 * 从请求体中提取 prompt 文本和输入图片 base64
 * 支持多种格式：OpenAI messages / 顶层 prompt / input 等
 * 纯内存读取操作，零延迟，不影响转发速度
 * @param {Object} body - req.body
 * @returns {{ promptText: string, inputImages: string[], imageUrls: string[], hasInputImages: boolean }}
 */
function extractMessagesInfo(body) {
    const result = { promptText: '', inputImages: [], imageUrls: [], hasInputImages: false }
    if (!body) return result

    const textParts = []
    const messages = body.messages

    // ── 1. 标准 OpenAI messages 格式 ──
    if (Array.isArray(messages)) {
        for (const msg of messages) {
            const content = msg.content
            if (!content) continue

            // 纯文本格式：content 是字符串
            if (typeof content === 'string') {
                textParts.push(content)
                continue
            }

            // 多模态格式：content 是数组 [{type:'text', text:...}, {type:'image_url', image_url:{url:...}}]
            if (Array.isArray(content)) {
                for (const part of content) {
                    if (part.type === 'text' && part.text) {
                        textParts.push(part.text)
                    } else if (part.type === 'image_url' && part.image_url?.url) {
                        const url = part.image_url.url
                        if (url.startsWith('data:image')) {
                            // base64 图片 → 存储到 GridFS
                            result.inputImages.push(url)
                        } else if (url.startsWith('http')) {
                            // 外部 URL 图片 → 仅记录 URL，不下载
                            result.imageUrls.push(url)
                        }
                    }
                }
            }
        }
    }

    // ── 2. 兜底：检查顶层 prompt / input 字段（非标准格式） ──
    if (textParts.length === 0) {
        if (typeof body.prompt === 'string' && body.prompt) textParts.push(body.prompt)
        if (typeof body.input === 'string' && body.input) textParts.push(body.input)

        // 兜底：如果就是个字符串的内容
        if (typeof messages === 'string' && messages) textParts.push(messages)

        // 兜底：如果 messages 是数组但全是各种奇怪格式
        if (Array.isArray(messages) && textParts.length === 0) {
            try {
                // 限制前 10KB 做正则匹配，防止超长输入导致正则回溯卡住（此分支仅用于日志展示）
                const str = JSON.stringify(messages).slice(0, 10240)
                // 尝试用正则粗略提取文字
                const matches = str.match(/"text"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g)
                if (matches) {
                    matches.forEach(m => {
                        const v = m.match(/"text"\s*:\s*"(.*)"/)[1]
                        if (v) textParts.push(v)
                    })
                }
            } catch (e) {
                console.warn('[Proxy] 兜底提取信息异常', e)
            }
        }
    }

    result.promptText = textParts.join('\n').slice(0, 2000) // 截断过长 prompt，防止 DB 膨胀
    result.hasInputImages = result.inputImages.length > 0 || result.imageUrls.length > 0
    return result
}

/**
 * 在转发前创建 running 状态的任务记录
 * 管理面板可实时看到「运行中」的代理任务
 * @param {string} userId - 调用者标识
 * @param {string} model - 模型名称
 * @param {Date} startTime - 请求开始时间
 * @param {Object} extractedInfo - extractMessagesInfo 提取的信息
 * @returns {Promise<Object>} 创建的任务文档
 */
async function createProxyTask(userId, model, startTime, extractedInfo, req) {
    const channelId = getProxyChannelId()
    const channelName = getProxyChannelName()
    // 根据是否有输入图片判断任务类型：有图+文字指令 → edit，纯文字 → generate
    const taskType = extractedInfo?.hasInputImages ? 'edit' : 'generate'
    // 提取调用上下文信息
    const xff = req?.headers?.['x-forwarded-for']
    const clientIP = xff ? xff.split(',')[0].trim() : (req?.ip || req?.connection?.remoteAddress || '未知')
    const authType = req?.platformKey ? `平台密钥[${req.platformKey.name}]` : 'JWT'
    const apiPath = req?.originalUrl || '未知'
    const taskDoc = await FurniaiTask.create({
        requestId: 'api-' + crypto.randomBytes(8).toString('hex'),
        operatorId: userId || 'unknown',
        source: 'api',
        items: [{
            taskType: taskType,
            status: 'processing', // 子项正在处理中
            startedAt: startTime,
            prompt: extractedInfo?.promptText || null, // 保存 prompt 文本，供后台详情展示
        }],
        options: {
            channel: channelId,
            model: model || 'unknown',
            userContext: extractedInfo?.promptText || '', // 同步保存到 userContext，前端详情弹窗会读取此字段
        },
        // 立即写入 modelUsed，任务列表/详情可以立即展示模型名
        modelUsed: model || null,
        status: 'running', // 任务运行中
        progress: 0,
        startedAt: startTime,
        // 创建时即写入 timeline 日志
        timeline: [
            { ts: startTime, phase: 'received', msg: `API 收到请求 | 接口=${apiPath} | 认证=${authType} | IP=${clientIP} | 类型=${taskType} | 通道=${channelName} | 模型=${model || '未知'}` },
            { ts: startTime, phase: 'api_call', msg: `开始转发到 AI 通道 | 通道=${channelName} | 模型=${model || '未知'}` },
        ],
    })
    console.log(`[Proxy] 任务记录已创建(running): taskId=${taskDoc.requestId}, type=${taskType}, model=${model}, channel=${channelName}`)
    return taskDoc
}

/**
 * 转发完成后更新任务记录状态 + 保存输出图片 + 异步保存输入图片
 * 全部在响应返回给用户之后执行，不阻塞用户
 * @param {Object} taskDoc - createProxyTask 返回的任务文档
 * @param {string} status - 最终状态 succeeded/failed
 * @param {Buffer|null} responseBuffer - 响应体 Buffer（用于提取输出图片）
 * @param {string} errorMessage - 失败时的错误信息
 * @param {Object} extractedInfo - extractMessagesInfo 预提取的信息 { inputImages, imageUrls }
 * @param {Object} [channelInfo] - 最终使用的通道信息 { channelId, channelName, model }
 */
async function completeProxyTask(taskDoc, status, responseBuffer, errorMessage, extractedInfo, channelInfo, responseEndTime) {
    if (!taskDoc) return
    const now = new Date()
    // 任务完成时间 = 响应返回给用户的精确时间（如果有），否则用当前时间
    const completionTime = responseEndTime || now
    const imageProcessor = require('../services/imageProcessor')

    // ══════════════════════════════════════════════════════════════════
    // 第一步：先提取和保存图片/文本（在更新状态之前完成）
    // 这样前端轮询到 succeeded 时，resultFileId 已经就绪
    // ══════════════════════════════════════════════════════════════════
    let resultFileId = null
    let resultText = null

    if (status === 'succeeded' && responseBuffer) {
        try {
            const respText = responseBuffer.toString('utf-8')
            const respJson = JSON.parse(respText)

            // ── 统一提取响应中的文本和图片（兼容 string / array 两种 content 格式） ──
            let responseTextContent = ''  // 可读文本（去除 base64 后）
            let imageBase64 = null        // 提取到的图片 base64 数据

            const rawContent = respJson?.choices?.[0]?.message?.content

            // ━━━━ 分支1: content 是字符串（标准 OpenAI 文本格式） ━━━━
            if (typeof rawContent === 'string' && rawContent) {
                // 去掉 base64 图片数据，只保留可读文本（避免文本字段过大）
                responseTextContent = rawContent.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[图片数据已省略]').trim()

                // 提取图片：data:image/xxx;base64,...（放宽 MIME 类型匹配）
                const dataUrlMatch = rawContent.match(/data:image\/([^;]+);base64,([A-Za-z0-9+/=]+)/)
                if (dataUrlMatch) {
                    imageBase64 = dataUrlMatch[2]
                }

                // Markdown 图片格式：![...](data:image/...;base64,...)
                if (!imageBase64) {
                    const mdMatch = rawContent.match(/!\[.*?\]\(data:image\/([^;]+);base64,([^)]+)\)/)
                    if (mdMatch) imageBase64 = mdMatch[2]
                }
            }
            // ━━━━ 分支2: content 是数组（多模态格式，部分代理/通道会返回此格式） ━━━━
            else if (Array.isArray(rawContent) && rawContent.length > 0) {
                const textParts = []
                for (const part of rawContent) {
                    // 防护：跳过 null/undefined/非对象元素
                    if (!part || typeof part !== 'object') continue
                    // 文本部分
                    if (part.type === 'text' && part.text) {
                        textParts.push(part.text)
                    }
                    // 图片部分：{type:'image_url', image_url:{url:'data:image/...;base64,...'}}
                    else if (part.type === 'image_url' && part.image_url?.url) {
                        const url = part.image_url.url
                        const b64Match = url.match(/^data:image\/([^;]+);base64,([A-Za-z0-9+/=]+)$/)
                        if (b64Match && !imageBase64) {
                            imageBase64 = b64Match[2]
                        } else if (url.startsWith('http') && !imageBase64) {
                            responseTextContent = url
                        }
                    }
                    // 兜底：直接包含 base64 字段的格式
                    else if (part.type === 'image' && part.data && !imageBase64) {
                        imageBase64 = part.data
                    }
                }
                if (textParts.length > 0) {
                    responseTextContent = textParts.join('\n').trim()
                }
                console.log(`[Proxy] content 为数组格式（${rawContent.length} 项），提取文本=${textParts.length}项，图片=${imageBase64 ? '有' : '无'}`)
            }

            // ━━━━ OpenRouter 格式：choices[0].message.images[].image_url.url ━━━━
            if (!imageBase64) {
                const images = respJson?.choices?.[0]?.message?.images
                if (images && Array.isArray(images) && images.length > 0) {
                    const dataUrl = images[0]?.image_url?.url || ''
                    if (dataUrl) {
                        const orMatch = dataUrl.match(/^data:image\/([^;]+);base64,([A-Za-z0-9+/=]+)$/)
                        if (orMatch) {
                            imageBase64 = orMatch[2]
                        } else if (dataUrl.startsWith('http')) {
                            responseTextContent = dataUrl
                        }
                    }
                }
            }

            // ━━━━ OpenAI DALL-E 格式: data[0].b64_json 或 url ━━━━
            if (!imageBase64 && respJson?.data && Array.isArray(respJson.data) && respJson.data.length > 0) {
                const imgData = respJson.data[0]
                if (imgData.b64_json) {
                    imageBase64 = imgData.b64_json
                } else if (imgData.url) {
                    responseTextContent = imgData.url
                }
            }

            // ━━━━ Google 原生格式：candidates[].content.parts[].inlineData.data ━━━━
            if (!imageBase64 && respJson?.candidates) {
                const textParts = []
                for (const cand of (respJson.candidates || [])) {
                    for (const part of (cand.content?.parts || [])) {
                        if (part.text) textParts.push(part.text)
                        const inlineData = part.inlineData || part.inline_data
                        if (inlineData?.data && !imageBase64) {
                            imageBase64 = inlineData.data
                        }
                    }
                }
                if (!responseTextContent && textParts.length > 0) {
                    responseTextContent = textParts.join('\n').trim()
                }
            }

            // ━━━━ 兜底：扫描整个响应 JSON 寻找 base64 图片数据 ━━━━
            if (!imageBase64) {
                const maxScanLen = 500000
                const scanText = respText.length > maxScanLen ? respText.slice(0, maxScanLen) : respText
                const fallbackMatch = scanText.match(/data:image\/([^;]{1,20});base64,([A-Za-z0-9+/=]{1000,500000})/)
                if (fallbackMatch) {
                    imageBase64 = fallbackMatch[2]
                    console.log(`[Proxy] 兜底扫描命中图片数据: MIME=${fallbackMatch[1]}, 长度=${imageBase64.length}`)
                }
            }

            // ━━━━ 保存 resultText ━━━━
            if (responseTextContent.length > 2000) {
                responseTextContent = responseTextContent.substring(0, 2000) + '...[截断]'
            }
            if (responseTextContent) {
                resultText = responseTextContent
            }

            // ━━━━ 保存图片到 GridFS（含 timeline 日志） ━━━━
            if (imageBase64) {
                try {
                    const saveStart = new Date()
                    // timeline: 开始保存图片
                    FurniaiTask.updateOne({ _id: taskDoc._id }, { $push: { timeline: { ts: saveStart, phase: 'saving_image', msg: `开始保存输出图片到 GridFS | 数据量=${(imageBase64.length / 1024).toFixed(0)}KB` } } }).catch(() => { })
                    const dataUrl = imageProcessor.toDataUrl(imageBase64)
                    resultFileId = await imageProcessor.saveBase64ToGridFS(dataUrl, `proxy-${taskDoc.items[0].taskType}`)
                    const saveElapsed = ((new Date() - saveStart) / 1000).toFixed(1)
                    console.log(`[Proxy] 输出图片已保存到 GridFS: fileId=${resultFileId}, taskId=${taskDoc.requestId}, 耗时=${saveElapsed}s`)
                    // timeline: 图片保存完成
                    FurniaiTask.updateOne({ _id: taskDoc._id }, { $push: { timeline: { ts: new Date(), phase: 'image_saved', msg: `输出图片保存完成 | fileId=${resultFileId} | 耗时=${saveElapsed}s` } } }).catch(() => { })
                } catch (saveErr) {
                    console.error(`[Proxy] 输出图片保存到 GridFS 失败: taskId=${taskDoc.requestId}, error=${saveErr.message}`)
                }
            } else {
                const keys = Object.keys(respJson || {}).slice(0, 10)
                const choiceKeys = respJson?.choices?.[0] ? Object.keys(respJson.choices[0].message || {}).slice(0, 10) : []
                const contentType = typeof rawContent
                console.warn(`[Proxy] 响应中未找到图片数据: taskId=${taskDoc.requestId}, 响应顶层keys=[${keys}], message.keys=[${choiceKeys}], content类型=${contentType}`)
            }
        } catch (e) {
            const bufLen = responseBuffer ? responseBuffer.length : 0
            console.warn(`[Proxy] 响应解析/保存失败（不影响用户响应）: ${e.message}, bufferLen=${bufLen}, taskId=${taskDoc.requestId}`)
        }
    }

    // ══════════════════════════════════════════════════════════════════
    // 第二步：一次性原子更新所有字段（状态 + 图片 + 文本）
    // 确保前端轮询到 succeeded 时，resultFileId/resultText 已就绪
    // ══════════════════════════════════════════════════════════════════
    const updateData = {
        status: status,
        progress: 100,
        completedAt: completionTime,
        updatedAt: now,
        'items.0.status': status === 'succeeded' ? 'completed' : 'failed',
        'items.0.completedAt': completionTime
    }

    // 通道降级信息 — 写入通道名称（而非 ID），确保管理面板能直接展示人类可读的通道名
    if (channelInfo) {
        updateData['options.channel'] = channelInfo.channelName || channelInfo.channelId
        updateData.modelUsed = channelInfo.model
    }

    // 失败时保存错误信息
    if (status === 'failed' && errorMessage) {
        updateData.error = errorMessage
        updateData['items.0.error'] = errorMessage
    }

    // 图片和文本数据（在状态更新中一次性写入，避免时序竞态）
    if (resultFileId) {
        updateData['items.0.resultFileId'] = resultFileId
    }
    if (resultText) {
        updateData['items.0.resultText'] = resultText
    }

    await FurniaiTask.updateOne({ _id: taskDoc._id }, { $set: updateData })
    console.log(`[Proxy] 任务已原子更新: taskId=${taskDoc.requestId}, status=${status}, hasImage=${!!resultFileId}, hasText=${!!resultText}`)

    // 追加完成阶段的 timeline 日志（包含详细的耗时节点）
    const userElapsed = ((completionTime - taskDoc.startedAt) / 1000).toFixed(1)
    const totalElapsed = ((now - taskDoc.startedAt) / 1000).toFixed(1)
    const postProcessElapsed = ((now - completionTime) / 1000).toFixed(1)
    const finalChannel = channelInfo?.channelName || '未知'
    const finalModel = channelInfo?.model || '未知'
    const tlEntries = []
    if (status === 'succeeded') {
        // 记录响应返回用户的时间点
        if (responseEndTime) {
            tlEntries.push({ ts: responseEndTime, phase: 'response_sent', msg: `响应已返回用户 | 用户感知耗时=${userElapsed}s | 通道=${finalChannel} | 模型=${finalModel}` })
        }
        // 记录后处理完成（图片保存+DB更新）
        tlEntries.push({ ts: now, phase: 'task_completed', msg: `任务完成 | 用户耗时=${userElapsed}s | 后处理=${postProcessElapsed}s | 总跨度=${totalElapsed}s | 通道=${finalChannel} | 模型=${finalModel} | 有图=${!!resultFileId}` })
    } else {
        tlEntries.push({ ts: completionTime, phase: 'task_failed', msg: `任务失败 | 耗时=${userElapsed}s | 错误=${errorMessage || '未知'}` })
    }
    FurniaiTask.updateOne({ _id: taskDoc._id }, { $push: { timeline: { $each: tlEntries } } }).catch(e => console.warn('[Proxy] timeline追加失败:', e.message))

    // ══════════════════════════════════════════════════════════════════
    // 第三步：异步保存输入图片（不阻塞，不影响任务状态展示）
    // ══════════════════════════════════════════════════════════════════
    const inputImages = extractedInfo?.inputImages || []
    const imageUrls = extractedInfo?.imageUrls || []

    if (inputImages.length > 0 || imageUrls.length > 0) {
        (async () => {
            try {
                const refEntries = []
                for (const dataUrl of inputImages) {
                    try {
                        if (dataUrl.length < 1000) {
                            console.warn(`[Proxy] 输入图片数据过短（${dataUrl.length} 字符），疑似截断，跳过保存`)
                            continue
                        }
                        const fileId = await imageProcessor.saveBase64ToGridFS(dataUrl, 'proxy-input')
                        refEntries.push({ data: fileId })
                    } catch (e) {
                        console.warn(`[Proxy] 输入图片保存失败（跳过）: ${e.message}`)
                    }
                }
                for (const url of imageUrls) {
                    refEntries.push({ url: url })
                }
                if (refEntries.length > 0) {
                    await FurniaiTask.updateOne(
                        { _id: taskDoc._id },
                        { $set: { referenceImages: refEntries } }
                    )
                    console.log(`[Proxy] 输入图片已保存: ${refEntries.length} 条(GridFS:${inputImages.length}, URL:${imageUrls.length}), taskId=${taskDoc.requestId}`)
                }
            } catch (e) {
                console.warn(`[Proxy] 输入图片批量保存异常: ${e.message}`)
            }
        })()
    }
}


/**
 * 对指定通道执行单次 axios 转发
 * @param {Object} ch - channelPriority 中的通道配置对象
 * @param {Object} req - Express 请求对象
 * @param {string} targetPath - 去除 /proxy 前缀后的路径
 * @param {string} model - 本次使用的模型名
 * @returns {Promise<{response: Object, targetUrl: string, finalModel: string}>} axios 响应
 */
async function _forwardToChannel(ch, req, targetPath, model) {
    const baseUrl = (ch.url || process.env.NEWAPI_TARGET || 'http://zx2.52youxi.cc:3000').replace(/\/+$/, '')
    let path = targetPath
    // 应对接口常常自带 /v1 后缀导致两重 /v1/v1 的问题
    if (baseUrl.endsWith('/v1') && path.startsWith('/v1/')) {
        path = path.substring(3)
    }
    const targetUrl = `${baseUrl}${path}`

    // 覆盖请求体中的 model
    const body = req.body ? { ...req.body, model } : req.body

    const apiTimeout = configManager.get('apiTimeoutMs') || 120000
    const axiosConfig = {
        method: req.method,
        url: targetUrl,
        headers: {
            'Content-Type': req.headers['content-type'] || 'application/json',
            'Authorization': `Bearer ${ch.apiKey || process.env.NEWAPI_KEY || ''}`,
        },
        timeout: apiTimeout,
        responseType: 'arraybuffer',
        httpAgent: httpKeepAliveAgent,
        httpsAgent: httpsKeepAliveAgent,
        validateStatus: () => true,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
    }
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        axiosConfig.data = body
    }

    const response = await axios(axiosConfig)
    return { response, targetUrl, finalModel: model }
}

// CORS 预检请求放行（OPTIONS 不走 auth，否则浏览器 preflight 会被 401 拦截）
router.options('/*', (req, res) => {
    res.set('Access-Control-Allow-Origin', req.headers.origin || '*')
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.set('Access-Control-Max-Age', '86400')
    res.sendStatus(200)
})

// 所有代理路由都需要平台密钥鉴权
router.use(auth)

/**
 * 通用透传：所有路径 + 所有方法
 * /proxy/v1/chat/completions → 优先通道 → 失败时降级到备用模型/下一通道
 * /proxy/v1/models → 直接透传，不做降级
 */
router.all('/*', async (req, res) => {
    const startTime = new Date()
    // 只有 POST /v1/chat/completions 才是生图请求，需要统计和通道降级
    const isGenerateCall = req.method === 'POST' && req.originalUrl.includes('/chat/completions')
    // 生图请求：在转发前从 messages 中提取 prompt 文本和输入图片（纯内存读取，零延迟）
    const extractedInfo = isGenerateCall ? extractMessagesInfo(req.body) : null
    // 生图任务的预创建 Promise（不阻塞转发，与 AI 调用并行执行）
    let proxyTaskPromise = null

    // 去掉路由前缀，保留 /v1/... 路径
    const targetPath = req.originalUrl.replace(/^\/proxy/, '')

    // ── 非生图请求：保持原有单次转发逻辑（不做降级） ──
    if (!isGenerateCall) {
        try {
            const activeCh = getActiveChannel()
            const { response, targetUrl } = await _forwardToChannel(activeCh, req, targetPath, req.body?.model || 'unknown')
            console.log(`[Proxy] ${req.method} -> ${targetUrl} | 用户: ${req.userId}`)
            res.status(response.status)
            res.set('Access-Control-Allow-Origin', req.headers.origin || '*')
            const contentType = response.headers['content-type']
            if (contentType) res.set('Content-Type', contentType)
            res.send(Buffer.from(response.data))
        } catch (err) {
            console.error('[Proxy] 转发失败:', err.message)
            res.status(502).json({ error: 'Proxy Error', message: err.message })
        }
        return
    }

    // ── 生图请求：带通道降级重试的转发逻辑 ──
    const allChannels = getAllActiveChannels()
    const primaryCh = getActiveChannel()
    // 确定首选模型
    const originalModel = req.body?.model || 'unknown'
    const primaryModel = primaryCh.imageModel || originalModel

    // 创建任务记录（不阻塞转发，与 AI 调用并行执行）
    try {
        proxyTaskPromise = createProxyTask(req.userId, primaryModel, startTime, extractedInfo, req)
        proxyTaskPromise.catch(e => console.warn('[Proxy] 创建任务记录失败（不阻塞请求）:', e.message))
    } catch (e) {
        console.warn('[Proxy] 创建任务记录失败（不阻塞请求）:', e.message)
    }

    // 构建要尝试的通道+模型列表：[ { ch, model, label }, ... ]
    const attempts = []
    for (const ch of allChannels) {
        // 主模型
        attempts.push({ ch, model: ch.imageModel || originalModel, label: `${ch.name}[主:${ch.imageModel || originalModel}]` })
        // 备用模型（如果配置了且不同于主模型）
        if (ch.backupImageModel && ch.backupImageModel !== ch.imageModel) {
            attempts.push({ ch, model: ch.backupImageModel, label: `${ch.name}[备用:${ch.backupImageModel}]` })
        }
    }

    // 如果没有任何可用通道，直接报错
    if (attempts.length === 0) {
        console.error('[Proxy] 没有可用的通道配置')
        res.status(502).json({ error: 'Proxy Error', message: '没有可用的通道配置' })
        if (proxyTaskPromise) proxyTaskPromise.then(doc => completeProxyTask(doc, 'failed', null, '没有可用的通道配置', extractedInfo)).catch(() => { })
        return
    }

    const errors = []

    for (let i = 0; i < attempts.length; i++) {
        const { ch, model, label } = attempts[i]
        try {
            console.log(`[Proxy] 生图转发尝试 ${i + 1}/${attempts.length}: ${label} | 用户: ${req.userId}`)
            // 实时写入 timeline：记录每次降级尝试的开始（第1次已在 createProxyTask 中记录）
            if (i > 0 && proxyTaskPromise) {
                proxyTaskPromise.then(doc => {
                    if (doc) FurniaiTask.updateOne({ _id: doc._id }, { $push: { timeline: { ts: new Date(), phase: 'channel_attempt', msg: `降级尝试 ${i + 1}/${attempts.length}: ${label}` } } }).catch(() => { })
                }).catch(() => { })
            }
            const { response, targetUrl, finalModel } = await _forwardToChannel(ch, req, targetPath, model)

            const isSuccess = response.status >= 200 && response.status < 400

            if (isSuccess) {
                // ── 成功：返回响应 + 记录统计 ──
                res.status(response.status)
                res.set('Access-Control-Allow-Origin', req.headers.origin || '*')
                const contentType = response.headers['content-type']
                if (contentType) res.set('Content-Type', contentType)
                const dataBuffer = Buffer.from(response.data)
                res.send(dataBuffer)

                // 记录响应返回给用户的精确时间（此时用户已拿到数据）
                const responseEndTime = new Date()
                const userElapsedMs = (responseEndTime - startTime) / 1000
                console.log(`[Proxy] ✅ 响应已返回用户 | 用户感知耗时=${userElapsedMs.toFixed(1)}s | 通道=${ch.name} | 模型=${finalModel}`)

                // 统计（不阻塞）
                if (req.platformKey) {
                    req.platformKey.recordSuccess(20).catch(e => console.error('[Proxy] 平台统计更新失败:', e.message))
                } else {
                    jwtCounter.recordSuccess().catch(e => console.error('[Proxy] JWT统计更新失败:', e.message))
                }

                // 如果发生了降级（i > 0），日志提示
                if (i > 0) {
                    console.log(`[Proxy] ✅ 降级成功: 第 ${i + 1} 次尝试成功 (${label})`)
                }

                // 异步后处理：等待任务记录创建完成后执行 GridFS 保存和 DB 更新
                if (proxyTaskPromise) {
                    proxyTaskPromise.then(taskDoc => {
                        if (!taskDoc) return
                        // 降级日志
                        if (i > 0) {
                            // channel_fail 已在循环中实时写入，这里只追加降级成功记录
                            FurniaiTask.updateOne({ _id: taskDoc._id }, { $push: { timeline: { ts: new Date(), phase: 'channel_switch', msg: `降级成功: 第 ${i + 1} 次尝试 (${label})` } } }).catch(() => { })
                        }
                        // 异步执行后处理（图片保存 + 状态更新 + timeline 记录）
                        completeProxyTask(taskDoc, 'succeeded', dataBuffer, null, extractedInfo, {
                            channelId: ch.id, channelName: ch.name, model: finalModel,
                        }, responseEndTime)
                    }).catch(e => console.warn('[Proxy] 异步后处理失败:', e.message))
                }
                return // 成功，结束
            }

            // 上游返回了非成功状态码 → 视为可降级的失败
            const errText = Buffer.from(response.data).toString('utf-8').slice(0, 300)
            const errMsg = `${label} 上游 HTTP ${response.status}: ${errText}`
            console.warn(`[Proxy] ${errMsg}`)
            errors.push(errMsg)
            // 实时写入 timeline：记录通道失败（上游返回错误）
            if (proxyTaskPromise) {
                proxyTaskPromise.then(doc => {
                    if (doc) FurniaiTask.updateOne({ _id: doc._id }, { $push: { timeline: { ts: new Date(), phase: 'channel_fail', msg: errMsg } } }).catch(() => { })
                }).catch(() => { })
            }
            // 继续尝试下一个通道

        } catch (err) {
            // 网络错误/超时 → 可降级
            const errMsg = `${label} ${err.message}`
            console.warn(`[Proxy] 通道失败: ${errMsg}`)
            errors.push(errMsg)
            // 实时写入 timeline：记录通道失败（网络错误/超时）
            if (proxyTaskPromise) {
                proxyTaskPromise.then(doc => {
                    if (doc) FurniaiTask.updateOne({ _id: doc._id }, { $push: { timeline: { ts: new Date(), phase: 'channel_fail', msg: errMsg } } }).catch(() => { })
                }).catch(() => { })
            }
            // 继续尝试下一个通道
        }
    }

    // ── 所有通道都失败 ──
    const allErrors = errors.join('; ')
    console.error(`[Proxy] 所有通道均失败 (${attempts.length} 次尝试): ${allErrors}`)
    res.status(502).json({
        error: 'Proxy Error',
        message: `所有通道均失败: ${allErrors}`,
    })

    // 统计
    if (req.platformKey) {
        req.platformKey.recordFailure().catch(e => console.error('[Proxy] 平台统计更新失败:', e.message))
    } else {
        jwtCounter.recordFailure().catch(e => console.error('[Proxy] JWT统计更新失败:', e.message))
    }
    if (proxyTaskPromise) proxyTaskPromise.then(doc => completeProxyTask(doc, 'failed', null, `所有通道均失败: ${allErrors}`, extractedInfo)).catch(() => { })
})

module.exports = router
