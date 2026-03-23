/**
 * FurnIAI — Gemini Client
 * 双通道 Gemini 调用器：Google 官方 REST + G3Pro 代理（Anthropic 格式）
 * 全局节流、自动重试
 */
const axios = require('axios')
const imageProcessor = require('./imageProcessor')
const { analysisCache } = require('./analysisCache')
const { TokenBucket } = require('./tokenBucket')
const { getInstance: getKeyPoolInstance } = require('./keyPool')
const configManager = require('./configManager')

// ==================== 工具函数 ====================

/**
 * Bearer Token 脱敏：隐藏中间部分
 * - 长度 >= 12：前 8 位 + **** + 后 4 位
 * - 长度 < 12：前 4 位 + ****
 * - 空/falsy：返回 '****'
 */
const { maskToken } = require('../utils/mask')

/**
 * 提取 OpenAI content 图片对象的 MIME 和纯 Base64 数据
 * 支持完整的 Data URI Scheme 和去头纯 Base64 (兜底回退为 image/jpeg)
 * @param {string} urlStr 
 * @returns {{ mime_type: string, data: string } | null}
 */
function extractImageData(urlStr) {
  if (!urlStr) return null
  const match = urlStr.match(/^data:([^;]+);base64,(.+)$/)
  if (match) {
    return { mime_type: match[1], data: match[2] }
  } else if (urlStr.length > 100 && !urlStr.startsWith('http')) {
    // Fallback: 认为是去除了前缀的纯 Base64
    return { mime_type: 'image/jpeg', data: urlStr }
  }
  return null
}

// Lazy singleton for KeyPool (initialized on first use)
let _keyPool = null
function getKeyPool() {
  if (!_keyPool) _keyPool = getKeyPoolInstance()
  return _keyPool
}

// ==================== 动态配置读取（从 configManager 获取，支持管理面板热更新） ====================

// 按通道id查找通道配置
function _getChannel(channelId) {
  const list = configManager.get('channelPriority') || []
  return list.find(c => c.id === channelId) || {}
}

// Google 通道配置（默认值统一在 configManager.getDefaults() 中管理）
function getGoogleModel() { return _getChannel('google').analysisModel || '' }
function getGoogleImageModel() { return _getChannel('google').imageModel || '' }
function getGoogleBase() { return _getChannel('google').url || '' }

// G3Pro 通道配置（默认值统一在 configManager.getDefaults() 中管理）
function getG3ProUrl() { return _getChannel('g3pro').url || '' }
function getG3ProVisionModel() { return _getChannel('g3pro').analysisModel || '' }
function getG3ProImageModel() { return _getChannel('g3pro').imageModel || '' }

// 通道模式（默认值统一在 configManager.getDefaults() 中管理）
function getChannelMode() { return configManager.get('channelMode') || 'auto' }

// ConcurrentAPI 配置（默认值统一在 configManager.getDefaults() 中管理）
function getConcurrentUrl() { return _getChannel('concurrent').url || '' }
function getConcurrentKey() { return _getChannel('concurrent').apiKey || '' }
function getConcurrentModel() { return _getChannel('concurrent').imageModel || '' }
function getConcurrentAnalysisModel() { return _getChannel('concurrent').analysisModel || '' }
function getConcurrentBackupUrl() { return _getChannel('concurrent').backupUrl || '' }
function getConcurrentBackupKey() { return _getChannel('concurrent').backupKey || '' }
function getConcurrentMax() { return configManager.get('concurrentMaxConcurrency') || 4 }

// API 超时时间（从 configManager 读取，默认 120000ms）
function getApiTimeout() { return configManager.get('apiTimeoutMs') || 120000 }
// 重试退避延迟数组（从 configManager 读取）
function getRetryDelays() { return configManager.get('retryDelays') || [2000, 4000, 8000, 16000] }
// Anthropic 协议 max_tokens（从 configManager 读取）
function getMaxTokens() { return configManager.get('maxTokens') || 4096 }
// 重试次数（从 configManager 读取，默认值见 getDefaults().retryCount）
function getRetryCount() { return configManager.get('retryCount') || 2 }

// 图片生成参数：从指定通道读取 imageSize 和 aspectRatio
function getChannelImageSize(channelId) { return _getChannel(channelId).imageSize || '' }
function getChannelAspectRatio(channelId) { return _getChannel(channelId).aspectRatio || '' }

// 动态获取活跃通道列表（按 channelPriority 排序，只取已启用通道）
function getActiveChannels() {
  const config = configManager.get()
  const allChannels = config?.channelPriority || []
  const mode = config?.channelMode || 'auto'
  if (mode === 'auto') {
    return allChannels.filter(c => c.enabled)
  } else {
    const target = allChannels.find(c => c.id === mode)
    return target ? [target] : allChannels.filter(c => c.enabled)
  }
}

// ==================== 令牌桶限流器 ====================

// 全局令牌桶实例（从 configManager 读取 tokenBucketConfig 配置）
function _getTokenBucketConfig() {
  return configManager.get('tokenBucketConfig') || { capacity: 5, refillRate: 1, refillInterval: 1000 }
}
const tokenBucket = new TokenBucket(_getTokenBucketConfig())

// ConcurrentAPI 独立信号量：控制最大并发请求数（复用公共 Semaphore 类）
const { Semaphore } = require('../utils/semaphore')
let _concurrentSemaphore = null
function getConcurrentSemaphore() {
  const max = getConcurrentMax()
  if (!_concurrentSemaphore || _concurrentSemaphore._max !== max) {
    _concurrentSemaphore = new Semaphore(max)
  }
  return _concurrentSemaphore
}

// ==================== 通道 A：Google 官方 REST ====================

async function callGoogleAPI(endpoint, body, retries) {
  if (retries === undefined) retries = getRetryCount()
  const retryDelays = getRetryDelays()

  for (let attempt = 0; attempt < retries; attempt++) {
    // Acquire a key from the pool (token already consumed by acquireKey)
    const { key, tokenBucket: tb, reportResult } = await getKeyPool().acquireKey()
    // Key 通过 header 传递，避免泄漏到日志/URL 中
    const url = `${getGoogleBase()}${endpoint}`

    try {
      const axiosOpts = {
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': key,
        },
        timeout: getApiTimeout(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        validateStatus: () => true,
      }
      const resp = await axios.post(url, body, axiosOpts)

      // Adaptive throttling on the key's own TokenBucket
      tb.onApiResponse(resp.status)
      // Report result to KeyPool health manager
      reportResult(resp.status, resp.data)

      if (resp.status === 429) {
        console.log(`[FurnIAI:Google] 429 rate limited, switching key (${attempt + 1}/${retries})`)
        continue
      }

      if (resp.status !== 200) {
        const msg = JSON.stringify(resp.data).slice(0, 500)
        console.error(`[FurnIAI:Google] HTTP ${resp.status}: ${msg}`)
        throw new Error(`Google API error (${resp.status}): ${msg}`)
      }

      return resp.data
    } catch (err) {
      console.error(`[FurnIAI:Google] Attempt ${attempt + 1} failed: ${err.message}`)
      if (attempt === retries - 1) throw err
      const jitter = Math.floor(Math.random() * 1000)
      const wait = retryDelays[Math.min(attempt, retryDelays.length - 1)] + jitter
      await new Promise(r => setTimeout(r, wait))
    }
  }
}




// ==================== 通道 B：G3Pro 代理（Anthropic 格式） ====================

async function callG3ProAPI(model, messages, retries, maxTokens = null) {
  if (retries === undefined) retries = getRetryCount()
  // 复用 getMaxTokens() 配置，调用方可覆盖
  const effectiveMaxTokens = maxTokens || getMaxTokens()
  const url = `${getG3ProUrl()}/v1/messages`
  const retryDelays = getRetryDelays()

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await tokenBucket.acquire()

      // 转换消息格式为 Anthropic
      const anthropicMessages = messages.map(msg => {
        if (typeof msg.content === 'string') {
          return { role: msg.role, content: msg.content }
        }
        if (Array.isArray(msg.content)) {
          const blocks = []
          for (const item of msg.content) {
            if (item.type === 'text') {
              blocks.push({ type: 'text', text: item.text })
            } else if (item.type === 'image_url' && item.image_url?.url) {
              const dataUrl = item.image_url.url
              const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
              if (match) {
                blocks.push({
                  type: 'image',
                  source: { type: 'base64', media_type: match[1], data: match[2] }
                })
              }
            }
          }
          return { role: msg.role, content: blocks }
        }
        return msg
      })

      const resp = await axios.post(url, {
        model,
        max_tokens: effectiveMaxTokens,
        messages: anthropicMessages,
      }, {
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        timeout: getApiTimeout(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        validateStatus: () => true,
      })

      // 自适应限流：反馈 API 响应状态码
      tokenBucket.onApiResponse(resp.status)

      if (resp.status === 429) {
        const jitter = Math.floor(Math.random() * 1000)
        const wait = retryDelays[Math.min(attempt, retryDelays.length - 1)] + jitter
        console.log(`[FurnIAI:G3Pro] 429 rate limited, wait ${wait}ms (${attempt + 1}/${retries})`)
        await new Promise(r => setTimeout(r, wait))
        continue
      }

      // 检测配额耗尽
      if (resp.status === 400) {
        const errMsg = resp.data?.error?.message || ''
        if (errMsg.includes('exhausted your capacity')) {
          const resetMatch = errMsg.match(/reset after (\S+)/)
          const resetTime = resetMatch ? resetMatch[1] : '未知'
          console.error(`[FurnIAI:G3Pro] 配额耗尽, 重置时间: ${resetTime}`)
          throw new Error(`AI图片生成配额已用完，预计 ${resetTime} 后恢复。请稍后重试。`)
        }
      }

      if (resp.status !== 200) {
        const msg = JSON.stringify(resp.data).slice(0, 500)
        console.error(`[FurnIAI:G3Pro] HTTP ${resp.status}: ${msg}`)
        throw new Error(`G3Pro API error (${resp.status}): ${msg}`)
      }

      // 转换为统一格式
      const data = resp.data
      let textContent = ''
      let imageContent = ''

      if (data.content && Array.isArray(data.content)) {
        for (const block of data.content) {
          if (block.type === 'text') textContent += block.text
          else if (block.type === 'image' && block.source?.data) {
            const mt = block.source.media_type || 'image/png'
            imageContent = `![generated](data:${mt};base64,${block.source.data})`
          }
        }
      }

      const finalContent = imageContent ? (textContent + '\n' + imageContent) : textContent
      return {
        choices: [{ message: { role: 'assistant', content: finalContent } }]
      }
    } catch (err) {
      console.error(`[FurnIAI:G3Pro] Attempt ${attempt + 1} failed: ${err.message}`)
      if (attempt === retries - 1) throw err
      const jitter = Math.floor(Math.random() * 1000)
      const wait = retryDelays[Math.min(attempt, retryDelays.length - 1)] + jitter
      await new Promise(r => setTimeout(r, wait))
    }
  }
}

// ==================== 通道 C1：ConcurrentAPI Native (Google REST兼容格式) ====================

async function callConcurrentNativeImageAPI(model, body, retries) {
  if (retries === undefined) retries = getRetryCount()
  const url = `${getConcurrentUrl()}/v1beta/models/${model}:generateContent`
  const retryDelays = getRetryDelays()

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const resp = await axios.post(url, body, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${getConcurrentKey()}`,
        },
        timeout: getApiTimeout(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        validateStatus: () => true,
      })

      if (resp.status !== 200) {
        const msg = JSON.stringify(resp.data).slice(0, 300)
        console.error(`[FurnIAI:ConcurrentNative] HTTP ${resp.status}: ${msg}`)
        throw new Error(`ConcurrentNative API error: ${resp.status}`)
      }

      return resp.data
    } catch (err) {
      console.error(`[FurnIAI:ConcurrentNative] Attempt ${attempt + 1} failed: ${err.message}`)
      if (attempt === retries - 1) throw err
      const jitter = Math.floor(Math.random() * 1000)
      const wait = retryDelays[Math.min(attempt, retryDelays.length - 1)] + jitter
      await new Promise(r => setTimeout(r, wait))
    }
  }
}

// ==================== 通道 C：ConcurrentAPI（OpenAI Chat Completions 兼容格式） ====================

/**
 * 通道 C：ConcurrentAPI（OpenAI Chat Completions 兼容格式）
 * @param {Array<{role: string, content: string|Array}>} messages - OpenAI 格式消息
 * @param {number} retries - 最大重试次数，默认从 configManager.retryCount 读取
 * @returns {Promise<{choices: Array}>} OpenAI 格式响应
 */
async function callConcurrentAPI(messages, retries, { model, imageConfig } = {}) {
  if (retries === undefined) retries = getRetryCount()
  const url = `${getConcurrentUrl()}/v1/chat/completions`
  const retryDelays = getRetryDelays()

  const requestBody = {
    model: model || getConcurrentModel(),
    messages,
    stream: false,
  }

  // 透传图片生成参数（中转平台支持 generationConfig 透传）
  if (imageConfig && Object.keys(imageConfig).length > 0) {
    requestBody.generationConfig = {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig,
    }
  }

  // 打印请求体（base64 图片截断显示，避免日志过大）
  const logBody = JSON.parse(JSON.stringify(requestBody))
  for (const msg of logBody.messages || []) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'image_url' && part.image_url?.url) {
          const url_str = part.image_url.url
          if (url_str.length > 200) {
            part.image_url.url = url_str.slice(0, 80) + `...[truncated, total ${url_str.length} chars]`
          }
        }
      }
    }
  }
  console.log(`[FurnIAI:Concurrent] 调用, model: ${requestBody.model}, token: ${maskToken(getConcurrentKey())}`)
  console.log(`[FurnIAI:Concurrent] 请求体: ${JSON.stringify(logBody)}`)

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const startTime = Date.now()

      const resp = await axios.post(url, requestBody, {
        headers: {
          'Authorization': `Bearer ${getConcurrentKey()}`,
          'Content-Type': 'application/json',
        },
        timeout: getApiTimeout(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        validateStatus: () => true,
      })

      // 429 限流：指数退避重试
      if (resp.status === 429) {
        const jitter = Math.floor(Math.random() * 1000)
        const wait = retryDelays[Math.min(attempt, retryDelays.length - 1)] + jitter
        console.log(`[FurnIAI:Concurrent] 429 rate limited, wait ${wait}ms (${attempt + 1}/${retries})`)
        await new Promise(r => setTimeout(r, wait))
        continue
      }

      // 400 请求格式错误：直接抛出，不重试
      if (resp.status === 400) {
        const msg = JSON.stringify(resp.data).slice(0, 500)
        console.error(`[FurnIAI:Concurrent] 400 Bad Request: ${msg}`)
        throw new Error(`ConcurrentAPI bad request (${resp.status}): ${msg}`)
      }

      // 401/403 认证失败：尝试备用通道
      if (resp.status === 401 || resp.status === 403) {
        console.error(`[FurnIAI:Concurrent] Auth failed (${resp.status}), trying backup...`)
        if (getConcurrentBackupUrl() && getConcurrentBackupKey()) {
          return await callConcurrentBackup(requestBody)
        }
        throw new Error(`ConcurrentAPI auth error: ${resp.status}`)
      }

      // 5xx 服务端错误：重试
      if (resp.status >= 500) {
        const msg = JSON.stringify(resp.data).slice(0, 500)
        console.error(`[FurnIAI:Concurrent] HTTP ${resp.status}: ${msg}`)
        if (attempt === retries - 1) throw new Error(`ConcurrentAPI server error (${resp.status}): ${msg}`)
        const jitter = Math.floor(Math.random() * 1000)
        const wait = retryDelays[Math.min(attempt, retryDelays.length - 1)] + jitter
        console.log(`[FurnIAI:Concurrent] 500 重试, wait ${wait}ms (${attempt + 1}/${retries})`)
        await new Promise(r => setTimeout(r, wait))
        continue
      }

      if (resp.status !== 200) {
        const msg = JSON.stringify(resp.data).slice(0, 500)
        console.error(`[FurnIAI:Concurrent] HTTP ${resp.status}: ${msg}`)
        throw new Error(`ConcurrentAPI error (${resp.status}): ${msg}`)
      }

      const elapsed = Date.now() - startTime
      console.log(`[FurnIAI:Concurrent] 成功, 耗时 ${elapsed}ms, HTTP ${resp.status}`)
      return resp.data
    } catch (err) {
      if (err.message.includes('bad request')) {
        throw err
      }
      if (err.message.includes('auth error')) {
        if (getConcurrentBackupUrl() && getConcurrentBackupKey()) {
          return await callConcurrentBackup(requestBody)
        }
        throw err
      }
      console.error(`[FurnIAI:Concurrent] 失败, attempt ${attempt + 1}/${retries}, error: ${err.message}`)
      if (attempt === retries - 1) throw err
      const jitter = Math.floor(Math.random() * 1000)
      const wait = retryDelays[Math.min(attempt, retryDelays.length - 1)] + jitter
      await new Promise(r => setTimeout(r, wait))
    }
  }
}

/**
 * 备用 ConcurrentAPI 通道（主通道 401/403 时自动降级）
 */
async function callConcurrentBackup(requestBody) {
  const url = `${getConcurrentBackupUrl()}/v1/chat/completions`
  console.log(`[FurnIAI:Backup] 降级调用, url: ${getConcurrentBackupUrl()}, model: ${requestBody.model}, token: ${maskToken(getConcurrentBackupKey())}`)
  const startTime = Date.now()
  const resp = await axios.post(url, requestBody, {
    headers: {
      'Authorization': `Bearer ${getConcurrentBackupKey()}`,
      'Content-Type': 'application/json',
    },
    timeout: getApiTimeout(),
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    validateStatus: () => true,
  })
  if (resp.status !== 200) {
    const msg = JSON.stringify(resp.data).slice(0, 300)
    console.error(`[FurnIAI:Backup] HTTP ${resp.status}: ${msg}`)
    throw new Error(`Backup ConcurrentAPI error: ${resp.status}`)
  }
  const elapsed = Date.now() - startTime
  console.log(`[FurnIAI:Backup] 成功, 耗时 ${elapsed}ms, HTTP ${resp.status}`)
  return resp.data
}


// ==================== 通用通道路由辅助函数（按 channelPriority 动态路由） ====================

/**
 * 通用生图调用：根据通道的 protocol 路由到对应 API
 * 支持 openai / anthropic / google 三种协议，自动处理格式转换和重试
 * @param {object} ch - channelPriority 中的通道配置对象
 * @param {Array} content - OpenAI 格式 content 数组（image_url + text）
 * @param {Array} parts - Google 格式 parts 数组（inline_data + text）
 * @param {object} options - 额外选项
 * @returns {Promise<{ image: string|null, text: string }>}
 */
async function _callChannelForImage(ch, content, parts, options = {}, useBackupModel = false) {
  const protocol = ch.protocol || 'openai'
  // 如果指定使用备用模型，则切换到 backupImageModel
  const model = useBackupModel ? (ch.backupImageModel || ch.imageModel || '') : (ch.imageModel || '')
  const retryDelays = getRetryDelays()
  const maxRetries = getRetryCount()

  // 构建 imageConfig（分辨率 + 宽高比）
  // 优先使用用户请求中传入的 imageSize / aspectRatio（前端透传），未传则回退到通道默认配置
  const imgCfg = {}
  const userImageSize = options.imageSize || ''
  const userAspectRatio = options.aspectRatio || ''
  if (userImageSize || ch.imageSize) imgCfg.imageSize = userImageSize || ch.imageSize
  if (userAspectRatio || ch.aspectRatio) imgCfg.aspectRatio = userAspectRatio || ch.aspectRatio
  const hasImgCfg = Object.keys(imgCfg).length > 0

  // ---- Google 协议 ----
  if (protocol === 'google') {
    const genConfig = { responseModalities: ['IMAGE', 'TEXT'] }
    if (hasImgCfg) genConfig.imageConfig = imgCfg
    const body = { contents: [{ role: 'user', parts }], generationConfig: genConfig }

    // 判断：有自己的 url 和 apiKey 的第三方通道，直接用通道的 URL + Bearer 认证
    if (ch.url && ch.apiKey) {
      console.log(`[FurnIAI:Channel] ${ch.name} 使用 Google REST 模式 (第三方, Bearer), model: ${model}, url: ${ch.url}`)
      const endpoint = `${ch.url}/v1beta/models/${model}:generateContent`
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const resp = await axios.post(endpoint, body, {
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ch.apiKey}` },
            timeout: getApiTimeout(), maxContentLength: Infinity, maxBodyLength: Infinity,
            validateStatus: () => true,
          })
          if (resp.status === 429) {
            const wait = retryDelays[Math.min(attempt, retryDelays.length - 1)] + Math.floor(Math.random() * 1000)
            console.log(`[FurnIAI:Channel] ${ch.name} 429 限流, 等待 ${wait}ms (${attempt + 1}/${maxRetries})`)
            await new Promise(r => setTimeout(r, wait))
            continue
          }
          if (resp.status !== 200) {
            const msg = JSON.stringify(resp.data).slice(0, 500)
            console.error(`[FurnIAI:Channel] ${ch.name} HTTP ${resp.status}: ${msg}`)
            throw new Error(`${ch.name} 上游 HTTP ${resp.status}: ${msg}`)
          }
          if (resp.data?.promptFeedback?.blockReason) throw new Error(`Content blocked: ${resp.data.promptFeedback.blockReason}`)
          const parsed = imageProcessor.parseImageFromResponse(resp.data, 'google')
          if (parsed) { parsed.channel = ch.name; parsed.model = model }
          return parsed
        } catch (err) {
          console.error(`[FurnIAI:Channel] ${ch.name} Google(Bearer) 尝试 ${attempt + 1} 失败: ${err.message}`)
          if (attempt === maxRetries - 1) throw err
          const wait = retryDelays[Math.min(attempt, retryDelays.length - 1)] + Math.floor(Math.random() * 1000)
          await new Promise(r => setTimeout(r, wait))
        }
      }
    } else {
      // 官方 Google 通道：走 KeyPool 自动轮换
      console.log(`[FurnIAI:Channel] ${ch.name} 使用 Google REST 模式 (官方 KeyPool)`)
      const resp = await callGoogleAPI(`/v1beta/models/${model}:generateContent`, body)
      if (resp.promptFeedback?.blockReason) throw new Error(`Content blocked: ${resp.promptFeedback.blockReason}`)
      const parsed = imageProcessor.parseImageFromResponse(resp, 'google')
      if (parsed) { parsed.channel = ch.name; parsed.model = model }
      return parsed
    }
  }

  // ---- Anthropic 协议：Anthropic Messages 格式 ----
  if (protocol === 'anthropic') {
    console.log(`[FurnIAI:Channel] ${ch.name} 使用 Anthropic 模式, model: ${model}`)
    // 转换 OpenAI content 为 Anthropic blocks
    const anthropicBlocks = []
    for (const item of content) {
      if (item.type === 'text') {
        anthropicBlocks.push({ type: 'text', text: item.text })
      } else if (item.type === 'image_url' && item.image_url?.url) {
        const img = extractImageData(item.image_url.url)
        if (img) {
          anthropicBlocks.push({ type: 'image', source: { type: 'base64', media_type: img.mime_type, data: img.data } })
        }
      }
    }
    const anthropicMessages = [{ role: 'user', content: anthropicBlocks }]

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await tokenBucket.acquire()
        const resp = await axios.post(`${ch.url}/v1/messages`, {
          model, max_tokens: getMaxTokens(), messages: anthropicMessages,
        }, {
          headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
          timeout: getApiTimeout(), maxContentLength: Infinity, maxBodyLength: Infinity,
          validateStatus: () => true,
        })
        tokenBucket.onApiResponse(resp.status)
        if (resp.status === 429) {
          const wait = retryDelays[Math.min(attempt, retryDelays.length - 1)] + Math.floor(Math.random() * 1000)
          console.log(`[FurnIAI:Channel] ${ch.name} 429 限流, 等待 ${wait}ms (${attempt + 1}/${maxRetries})`)
          await new Promise(r => setTimeout(r, wait))
          continue
        }
        if (resp.status === 400) {
          const errMsg = resp.data?.error?.message || ''
          if (errMsg.includes('exhausted your capacity')) {
            throw new Error(`${ch.name} 配额耗尽，请稍后重试`)
          }
        }
        if (resp.status !== 200) {
          const msg = JSON.stringify(resp.data).slice(0, 500)
          throw new Error(`${ch.name} Anthropic API error (${resp.status}): ${msg}`)
        }
        // 解析 Anthropic 响应 → 统一格式
        let textContent = '', imageContent = ''
        if (resp.data?.content && Array.isArray(resp.data.content)) {
          for (const block of resp.data.content) {
            if (block.type === 'text') textContent += block.text
            else if (block.type === 'image' && block.source?.data) {
              const mt = block.source.media_type || 'image/png'
              imageContent = `![generated](data:${mt};base64,${block.source.data})`
            }
          }
        }
        const finalContent = imageContent ? (textContent + '\n' + imageContent) : textContent
        const parsed = imageProcessor.parseImageFromResponse(
          { choices: [{ message: { role: 'assistant', content: finalContent } }] }, 'anthropic'
        )
        if (parsed) { parsed.channel = ch.name; parsed.model = model }
        return parsed
      } catch (err) {
        console.error(`[FurnIAI:Channel] ${ch.name} Anthropic 尝试 ${attempt + 1} 失败: ${err.message}`)
        if (attempt === maxRetries - 1) throw err
        const wait = retryDelays[Math.min(attempt, retryDelays.length - 1)] + Math.floor(Math.random() * 1000)
        await new Promise(r => setTimeout(r, wait))
      }
    }
  }

  // ---- OpenRouter 协议：OpenAI Chat Completions + modalities + image_config ----
  if (protocol === 'openrouter') {
    console.log(`[FurnIAI:Channel] ${ch.name} 使用 OpenRouter 模式, model: ${model}`)
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const chatUrl = `${ch.url}/v1/chat/completions`
        const requestBody = {
          model,
          messages: [{ role: 'user', content }],
          modalities: ['image', 'text'],  // OpenRouter 必需：声明输出包含图片
          stream: false,
        }
        // OpenRouter image_config（分辨率 + 宽高比）
        if (hasImgCfg) {
          requestBody.image_config = {}
          if (ch.aspectRatio) requestBody.image_config.aspect_ratio = ch.aspectRatio
          if (ch.imageSize) requestBody.image_config.image_size = ch.imageSize
        }
        const startTime = Date.now()
        const resp = await axios.post(chatUrl, requestBody, {
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ch.apiKey}` },
          timeout: getApiTimeout(), maxContentLength: Infinity, maxBodyLength: Infinity,
          validateStatus: () => true,
        })
        if (resp.status === 429) {
          const wait = retryDelays[Math.min(attempt, retryDelays.length - 1)] + Math.floor(Math.random() * 1000)
          console.log(`[FurnIAI:Channel] ${ch.name} 429 限流, 等待 ${wait}ms`)
          await new Promise(r => setTimeout(r, wait))
          continue
        }
        if (resp.status === 400) {
          const msg = JSON.stringify(resp.data).slice(0, 500)
          throw new Error(`${ch.name} bad request (${resp.status}): ${msg}`)
        }
        if (resp.status >= 500) {
          const msg = JSON.stringify(resp.data).slice(0, 500)
          if (attempt === maxRetries - 1) throw new Error(`${ch.name} server error (${resp.status}): ${msg}`)
          const wait = retryDelays[Math.min(attempt, retryDelays.length - 1)] + Math.floor(Math.random() * 1000)
          await new Promise(r => setTimeout(r, wait))
          continue
        }
        if (resp.status !== 200) {
          const msg = JSON.stringify(resp.data).slice(0, 500)
          throw new Error(`${ch.name} OpenRouter API error (${resp.status}): ${msg}`)
        }
        const elapsed = Date.now() - startTime
        console.log(`[FurnIAI:Channel] ${ch.name} 成功, 耗时 ${elapsed}ms`)
        const parsed = imageProcessor.parseImageFromResponse(resp.data, 'openrouter')
        if (parsed) { parsed.channel = ch.name; parsed.model = model }
        return parsed
      } catch (err) {
        if (err.message.includes('bad request')) throw err
        console.error(`[FurnIAI:Channel] ${ch.name} OpenRouter 尝试 ${attempt + 1} 失败: ${err.message}`)
        if (attempt === maxRetries - 1) throw err
        const wait = retryDelays[Math.min(attempt, retryDelays.length - 1)] + Math.floor(Math.random() * 1000)
        await new Promise(r => setTimeout(r, wait))
      }
    }
  }

  // ---- OpenAI 协议（默认）----
  if (hasImgCfg) {
    // 有 imageConfig 时使用 Native Google REST 格式（中转平台透传 generationConfig）
    console.log(`[FurnIAI:Channel] ${ch.name} 使用 OpenAI Native 模式 (imageConfig), model: ${model}`)
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const nativeUrl = `${ch.url}/v1beta/models/${model}:generateContent`
        const body = {
          contents: [{ role: 'user', parts }],
          generationConfig: { responseModalities: ['IMAGE', 'TEXT'], imageConfig: imgCfg },
        }
        const resp = await axios.post(nativeUrl, body, {
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ch.apiKey}` },
          timeout: getApiTimeout(), maxContentLength: Infinity, maxBodyLength: Infinity,
          validateStatus: () => true,
        })
        if (resp.status === 429) {
          const wait = retryDelays[Math.min(attempt, retryDelays.length - 1)] + Math.floor(Math.random() * 1000)
          console.log(`[FurnIAI:Channel] ${ch.name} 429 限流, 等待 ${wait}ms`)
          await new Promise(r => setTimeout(r, wait))
          continue
        }
        if (resp.status !== 200) {
          const msg = JSON.stringify(resp.data).slice(0, 500)
          throw new Error(`${ch.name} Native API error (${resp.status}): ${msg}`)
        }
        if (resp.data?.promptFeedback?.blockReason) throw new Error(`Content blocked: ${resp.data.promptFeedback.blockReason}`)
        const parsed = imageProcessor.parseImageFromResponse(resp.data, 'google')
        if (parsed) { parsed.channel = ch.name; parsed.model = model }
        return parsed
      } catch (err) {
        console.error(`[FurnIAI:Channel] ${ch.name} Native 尝试 ${attempt + 1} 失败: ${err.message}`)
        if (attempt === maxRetries - 1) throw err
        const wait = retryDelays[Math.min(attempt, retryDelays.length - 1)] + Math.floor(Math.random() * 1000)
        await new Promise(r => setTimeout(r, wait))
      }
    }
  } else {
    // 标准 OpenAI Chat Completions 格式
    console.log(`[FurnIAI:Channel] ${ch.name} 使用 OpenAI Chat 模式, model: ${model}, token: ${maskToken(ch.apiKey)}`)
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const chatUrl = `${ch.url}/v1/chat/completions`
        const requestBody = { model, messages: [{ role: 'user', content }], stream: false }
        const startTime = Date.now()
        const resp = await axios.post(chatUrl, requestBody, {
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ch.apiKey}` },
          timeout: getApiTimeout(), maxContentLength: Infinity, maxBodyLength: Infinity,
          validateStatus: () => true,
        })
        if (resp.status === 429) {
          const wait = retryDelays[Math.min(attempt, retryDelays.length - 1)] + Math.floor(Math.random() * 1000)
          console.log(`[FurnIAI:Channel] ${ch.name} 429 限流, 等待 ${wait}ms`)
          await new Promise(r => setTimeout(r, wait))
          continue
        }
        if (resp.status === 400) {
          const msg = JSON.stringify(resp.data).slice(0, 500)
          throw new Error(`${ch.name} bad request (${resp.status}): ${msg}`)
        }
        if (resp.status >= 500) {
          const msg = JSON.stringify(resp.data).slice(0, 500)
          if (attempt === maxRetries - 1) throw new Error(`${ch.name} server error (${resp.status}): ${msg}`)
          const wait = retryDelays[Math.min(attempt, retryDelays.length - 1)] + Math.floor(Math.random() * 1000)
          await new Promise(r => setTimeout(r, wait))
          continue
        }
        if (resp.status !== 200) {
          const msg = JSON.stringify(resp.data).slice(0, 500)
          throw new Error(`${ch.name} OpenAI API error (${resp.status}): ${msg}`)
        }
        const elapsed = Date.now() - startTime
        console.log(`[FurnIAI:Channel] ${ch.name} 成功, 耗时 ${elapsed}ms`)
        const parsed = imageProcessor.parseImageFromResponse(resp.data, 'openai')
        if (parsed) { parsed.channel = ch.name; parsed.model = model }
        return parsed
      } catch (err) {
        if (err.message.includes('bad request')) throw err
        console.error(`[FurnIAI:Channel] ${ch.name} Chat 尝试 ${attempt + 1} 失败: ${err.message}`)
        if (attempt === maxRetries - 1) throw err
        const wait = retryDelays[Math.min(attempt, retryDelays.length - 1)] + Math.floor(Math.random() * 1000)
        await new Promise(r => setTimeout(r, wait))
      }
    }
  }

  throw new Error(`${ch.name}: 未知协议 ${protocol}`)
}

/**
 * 通用文本分析调用：根据通道的 protocol 路由到对应 API
 * @param {object} ch - channelPriority 中的通道配置对象
 * @param {Array} content - OpenAI 格式 content 数组
 * @returns {Promise<{ text: string }>}
 */
async function _callChannelForAnalysis(ch, content, useBackupModel = false) {
  const protocol = ch.protocol || 'openai'
  // 如果指定使用备用模型，则切换到 backupAnalysisModel
  const model = useBackupModel ? (ch.backupAnalysisModel || ch.analysisModel || ch.imageModel || '') : (ch.analysisModel || ch.imageModel || '')

  // ---- Google 协议 ----
  if (protocol === 'google') {
    console.log(`[FurnIAI:Channel] ${ch.name} 分析(Google), model: ${model}`)
    // 把 OpenAI content 转为 Google parts
    const parts = []
    for (const item of content) {
      if (item.type === 'text') {
        parts.push({ text: item.text })
      } else if (item.type === 'image_url' && item.image_url?.url) {
        const img = extractImageData(item.image_url.url)
        if (img) {
          parts.push({ inline_data: { data: img.data, mime_type: img.mime_type } })
        }
      }
    }
    const body = {
      contents: [{ parts }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 4096 },
    }

    // 第三方通道：用通道自己的 URL + Bearer 认证
    if (ch.url && ch.apiKey) {
      const endpoint = `${ch.url}/v1beta/models/${model}:generateContent`
      const resp = await axios.post(endpoint, body, {
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ch.apiKey}` },
        timeout: getApiTimeout(), maxContentLength: Infinity, maxBodyLength: Infinity,
        validateStatus: () => true,
      })
      if (resp.status !== 200) {
        const msg = JSON.stringify(resp.data).slice(0, 500)
        throw new Error(`${ch.name} 分析 HTTP ${resp.status}: ${msg}`)
      }
      const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || ''
      return { text }
    } else {
      // 官方 Google 通道：走 KeyPool
      const resp = await callGoogleAPI(`/v1beta/models/${model}:generateContent`, body)
      const text = resp.candidates?.[0]?.content?.parts?.[0]?.text || ''
      return { text }
    }
  }

  // ---- Anthropic 协议 ----
  if (protocol === 'anthropic') {
    console.log(`[FurnIAI:Channel] ${ch.name} 分析(Anthropic), model: ${model}`)
    // 转换为 Anthropic blocks
    const anthropicBlocks = []
    for (const item of content) {
      if (item.type === 'text') {
        anthropicBlocks.push({ type: 'text', text: item.text })
      } else if (item.type === 'image_url' && item.image_url?.url) {
        const img = extractImageData(item.image_url.url)
        if (img) {
          anthropicBlocks.push({ type: 'image', source: { type: 'base64', media_type: img.mime_type, data: img.data } })
        }
      }
    }
    try {
      await tokenBucket.acquire()
      const resp = await axios.post(`${ch.url}/v1/messages`, {
        model, max_tokens: getMaxTokens(), messages: [{ role: 'user', content: anthropicBlocks }],
      }, {
        headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
        timeout: getApiTimeout(), maxContentLength: Infinity, maxBodyLength: Infinity,
        validateStatus: () => true,
      })
      tokenBucket.onApiResponse(resp.status)
      if (resp.status !== 200) throw new Error(`${ch.name} Anthropic analyze error: ${resp.status}`)
      let text = resp.data?.content?.[0]?.text || resp.data?.content?.map(b => b.text || '').join('') || '{}'
      text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
      return { text }
    } catch (err) {
      console.warn(`[FurnIAI:Channel] ${ch.name} Anthropic 分析失败: ${err.message}`)
      throw err
    }
  }

  // ---- OpenAI / OpenRouter 协议（默认）----
  // OpenRouter 文本分析格式与 OpenAI 完全一致，共用同一逻辑
  console.log(`[FurnIAI:Channel] ${ch.name} 分析(${protocol}), model: ${model}`)
  try {
    const chatUrl = `${ch.url}/v1/chat/completions`
    const requestBody = { model, messages: [{ role: 'user', content }], stream: false }
    const resp = await axios.post(chatUrl, requestBody, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ch.apiKey}` },
      timeout: getApiTimeout(), maxContentLength: Infinity, maxBodyLength: Infinity,
      validateStatus: () => true,
    })
    if (resp.status !== 200) throw new Error(`${ch.name} OpenAI analyze error: ${resp.status}`)
    const raw = resp.data?.choices?.[0]?.message?.content || '{}'
    let text = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
    return { text: text || '{}' }
  } catch (err) {
    console.warn(`[FurnIAI:Channel] ${ch.name} OpenAI 分析失败: ${err.message}`)
    throw err
  }
}

// ==================== 统一高级接口 ====================

/**
 * 纯文本分析（不需要图片生成）
 * @param {string} prompt
 * @param {string|null} imageBase64
 * @param {{ cacheKey?: string }} [options] - cacheKey: reference image fileId for caching
 * @returns {{ text: string }}
 */
async function analyzeWithText(prompt, imageBase64 = null, options = {}) {
  const { cacheKey } = options
  // 可选的 timeline 日志回调（由 taskQueue 传入，用于记录降级过程到任务 timeline）
  const _tl = options._timelineLogger || (() => { })

  // Cache lookup — skip API call on hit
  if (cacheKey) {
    const cached = analysisCache.get(cacheKey)
    if (cached) {
      console.log(`[FurnIAI] analyzeWithText cache hit, fileId=${cacheKey}`)
      return cached
    }
  }

  const pureBase64 = imageBase64 ? imageProcessor.extractPureBase64(imageBase64) : null

  // 构造 OpenAI 兼容的 content 数组
  const content = []
  if (pureBase64) {
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${pureBase64}` } })
  }
  content.push({ type: 'text', text: prompt + '\n\nReturn ONLY valid JSON, no markdown.' })

  // 使用缓存的活跃通道列表，按优先级尝试分析（主模型 → 备用模型 → 下一通道）
  const activeChs = getActiveChannels();
  for (let i = 0; i < activeChs.length; i++) {
    const ch = activeChs[i]
    // 1. 先用主模型
    try {
      const result = await _callChannelForAnalysis(ch, content, false)
      if (result && result.text) {
        if (cacheKey) analysisCache.set(cacheKey, result)
        return result
      }
    } catch (err) {
      const errDetail = err.message?.slice(0, 300) || String(err)
      console.warn(`[FurnIAI] 通道 ${ch.name}[主] 分析失败: ${errDetail}`)
      _tl('channel_fail', `分析通道 [${ch.name}] 主模型(${ch.analysisModel || '-'}) 失败: ${errDetail}`)
      // 只有一个通道且无备用模型时直接使用默认值
      if (activeChs.length === 1 && (!ch.backupAnalysisModel || ch.backupAnalysisModel === ch.analysisModel)) {
        console.warn('[FurnIAI] 唯一通道分析失败，使用默认值')
        _tl('channel_fail', `唯一分析通道 [${ch.name}] 失败，使用默认分析值`)
        return { text: '{}' }
      }
    }

    // 2. 主模型失败，且配置了不同的备用模型 → 用备用模型重试
    if (ch.backupAnalysisModel && ch.backupAnalysisModel !== ch.analysisModel) {
      console.log(`[FurnIAI] ${ch.name} 分析主模型(${ch.analysisModel})失败, 切换备用模型: ${ch.backupAnalysisModel}`)
      _tl('channel_fallback', `分析通道 [${ch.name}] 主模型失败，切换备用模型: ${ch.analysisModel} → ${ch.backupAnalysisModel}`)
      try {
        const result = await _callChannelForAnalysis(ch, content, true)
        if (result && result.text) {
          if (cacheKey) analysisCache.set(cacheKey, result)
          return result
        }
      } catch (err) {
        const errDetail = err.message?.slice(0, 300) || String(err)
        console.warn(`[FurnIAI] 通道 ${ch.name}[备用] 分析失败: ${errDetail}`)
        _tl('channel_fail', `分析通道 [${ch.name}] 备用模型(${ch.backupAnalysisModel}) 也失败: ${errDetail}`)
        if (activeChs.length === 1) {
          console.warn('[FurnIAI] 唯一通道备用模型也失败，使用默认值')
          _tl('channel_fail', `唯一分析通道 [${ch.name}] 主备模型均失败，使用默认分析值`)
          return { text: '{}' }
        }
      }
    }

    // 3. 当前通道全部失败，跳转下一通道
    if (i < activeChs.length - 1) {
      const nextCh = activeChs[i + 1]
      console.log(`[FurnIAI] 分析通道 ${ch.name} 全部失败，跳转下一通道: ${nextCh.name}`)
      _tl('channel_switch', `分析通道 [${ch.name}] 全部失败 → 跳转: ${nextCh.name}(${nextCh.analysisModel || '-'})`)
    }
  }

  // 所有通道都失败，返回默认值
  console.warn('[FurnIAI] 所有通道分析失败，使用默认值')
  _tl('channel_fail', `所有分析通道均失败，使用默认分析值`)
  return { text: '{}' }
}


/**
 * 图片生成（需要 responseModalities: IMAGE）
 * 按 channelPriority 配置的排序动态选择通道，支持 auto 逐级降级
 * @returns {{ image: string|null, text: string }}  image 为纯 base64
 */
async function generateImage(prompt, imageBase64 = null, options = {}) {
  const pureBase64 = imageBase64 ? imageProcessor.extractPureBase64(imageBase64) : null
  // 可选的 timeline 日志回调（由 taskQueue 传入，用于记录降级过程到任务 timeline）
  const _tl = options._timelineLogger || (() => { })

  // 构造 OpenAI 兼容的 content 数组（各协议通用）
  const content = []
  if (pureBase64) {
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${pureBase64}` } })
  }
  if (options.secondImageBase64) {
    const pure2 = imageProcessor.extractPureBase64(options.secondImageBase64)
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${pure2}` } })
  }
  content.push({ type: 'text', text: prompt })

  // 构造 Google 格式 parts 数组
  const parts = []
  if (pureBase64) {
    parts.push({ inline_data: { data: pureBase64, mime_type: 'image/jpeg' } })
  }
  if (options.secondImageBase64) {
    const pure2 = imageProcessor.extractPureBase64(options.secondImageBase64)
    parts.push({ inline_data: { data: pure2, mime_type: 'image/jpeg' } })
  }
  parts.push({ text: prompt })

  // 按 channelPriority 排序遍历通道（主模型 → 备用模型 → 下一通道）
  const errors = []
  const activeChs = getActiveChannels()
  for (let i = 0; i < activeChs.length; i++) {
    const ch = activeChs[i]
    // 1. 先用主模型
    try {
      const result = await _callChannelForImage(ch, content, parts, options, false)
      if (result && result.image) {
        return result
      }
      // API 返回 200 但没有图片（静默失败）— 记录日志和错误
      const silentDetail = `API返回成功但无图片(result=${result ? 'has text, no image' : 'null'})`
      console.warn(`[FurnIAI] 通道 ${ch.name}[主] 静默失败: ${silentDetail}`)
      errors.push(`${ch.name} [主]: ${silentDetail}`)
      _tl('channel_fail', `通道 [${ch.name}] 主模型(${ch.imageModel || '-'}) 静默失败: ${silentDetail}`)
    } catch (err) {
      // 截取错误信息（限 300 字符避免日志过长）
      const errDetail = err.message?.slice(0, 300) || String(err)
      console.warn(`[FurnIAI] 通道 ${ch.name}[主] 生图失败: ${errDetail}`)
      errors.push(`${ch.name} [主]: ${errDetail}`)
      // 写入 timeline：主模型失败原因
      _tl('channel_fail', `通道 [${ch.name}] 主模型(${ch.imageModel || '-'}) 生图失败: ${errDetail}`)
    }

    // 2. 主模型未出图，且配置了不同的备用模型 → 用备用模型重试
    if (ch.backupImageModel && ch.backupImageModel !== ch.imageModel) {
      console.log(`[FurnIAI] ${ch.name} 主模型(${ch.imageModel})未出图, 切换备用模型: ${ch.backupImageModel}`)
      _tl('channel_fallback', `通道 [${ch.name}] 主模型未出图，切换备用模型: ${ch.imageModel} → ${ch.backupImageModel}`)
      try {
        const result = await _callChannelForImage(ch, content, parts, options, true)
        if (result && result.image) {
          return result
        }
        // 备用模型也静默失败
        const silentDetail = `备用模型也无图片(result=${result ? 'has text, no image' : 'null'})`
        console.warn(`[FurnIAI] 通道 ${ch.name}[备用] 静默失败: ${silentDetail}`)
        errors.push(`${ch.name} [备用]: ${silentDetail}`)
        _tl('channel_fail', `通道 [${ch.name}] 备用模型(${ch.backupImageModel}) 静默失败: ${silentDetail}`)
      } catch (err) {
        const errDetail = err.message?.slice(0, 300) || String(err)
        console.warn(`[FurnIAI] 通道 ${ch.name}[备用] 生图失败: ${errDetail}`)
        errors.push(`${ch.name} [备用]: ${errDetail}`)
        // 写入 timeline：备用模型也失败
        _tl('channel_fail', `通道 [${ch.name}] 备用模型(${ch.backupImageModel}) 也失败: ${errDetail}`)
      }
    }

    // 3. 当前通道全部失败，跳转下一通道
    if (i < activeChs.length - 1) {
      const nextCh = activeChs[i + 1]
      console.log(`[FurnIAI] 通道 ${ch.name} 全部失败，跳转下一通道: ${nextCh.name}(${nextCh.imageModel || '-'})`)
      _tl('channel_switch', `通道 [${ch.name}] 全部失败 → 跳转下一通道: ${nextCh.name}(${nextCh.imageModel || '-'})`)
    }
  }

  throw new Error(`所有通道生图失败: ${errors.join('; ')}`)
}

module.exports = {
  callGoogleAPI,
  callG3ProAPI,
  callConcurrentAPI,
  maskToken,
  analyzeWithText,
  generateImage,

  // 令牌桶限流器
  TokenBucket,
  tokenBucket,
  // 分析缓存
  analysisCache,
  // 刷新配置（管理面板更新后调用）

  // 动态配置访问函数
  getConcurrentUrl,
  getConcurrentKey,
  getConcurrentModel,
  // 暴露配置供外部读取（实时获取最新值，各 getter 已动态从 configManager 读取）
  getConfig: () => {
    let keyPoolSize = 0
    let hasGoogleKey = false
    try {
      const pool = getKeyPool()
      keyPoolSize = pool.getKeyCount()
      hasGoogleKey = keyPoolSize > 0
    } catch (e) {
      hasGoogleKey = !!(process.env.FURNIAI_GEMINI_API_KEYS || process.env.FURNIAI_GEMINI_API_KEY || process.env.G3PRO_API_KEY)
    }
    return {
      channel: getChannelMode(),
      googleModel: getGoogleModel(),
      googleImageModel: getGoogleImageModel(),
      g3proUrl: getG3ProUrl(),
      g3proVisionModel: getG3ProVisionModel(),
      g3proImageModel: getG3ProImageModel(),
      concurrentMax: getConcurrentMax(),
      hasGoogleKey,
      keyPoolSize,
      concurrentApiUrl: getConcurrentUrl(),
      concurrentModel: getConcurrentModel(),
      concurrentAvailable: !!getConcurrentKey(),
    }
  },
}
