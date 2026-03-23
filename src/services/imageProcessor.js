/**
 * FurnIAI — Image Processor
 * base64 处理、URL→base64（服务端）、GridFS 读写、图片校验
 */
const axios = require('axios')
const FileService = require('./fileService')

/**
 * 去除 data URL 前缀，返回纯 base64
 */
function extractPureBase64(input) {
  if (!input) return ''
  if (input.includes(',')) {
    // 去除 data URL 前缀，并清理可能混入的空白/换行字符
    return input.split(',')[1].replace(/\s/g, '')
  }
  return input.replace(/\s/g, '')
}

/**
 * 给 base64 加上 data URL 前缀
 */
function toDataUrl(base64, mimeType = 'image/png') {
  if (!base64) return ''
  if (base64.startsWith('data:')) return base64
  return `data:${mimeType};base64,${base64}`
}

/**
 * HTTP URL → base64（服务端版，用 axios）
 */
async function urlToBase64(url) {
  const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 })
  const contentType = resp.headers['content-type'] || 'image/jpeg'
  const b64 = Buffer.from(resp.data).toString('base64')
  return `data:${contentType};base64,${b64}`
}

/**
 * 校验图片输入，统一返回纯 base64
 * 支持：data URL / 纯 base64 / HTTP URL / GridFS fileId
 */
async function normalizeImageInput(input) {
  if (!input || typeof input !== 'string') {
    throw new Error('Invalid image input: empty or not a string')
  }

  // data URL
  if (input.startsWith('data:')) {
    return extractPureBase64(input)
  }

  // HTTP URL
  if (input.startsWith('http://') || input.startsWith('https://')) {
    const dataUrl = await urlToBase64(input)
    return extractPureBase64(dataUrl)
  }

  // 纯 base64（长度 > 100 且无斜杠前缀）
  if (input.length > 100 && /^[A-Za-z0-9+/=]+$/.test(input.slice(0, 100))) {
    return input
  }

  // 尝试当 GridFS fileId
  try {
    const dataUrl = await fileIdToBase64(input)
    return extractPureBase64(dataUrl)
  } catch (err) {
    throw new Error(`Cannot resolve image input (not base64/URL/fileId): ${err.message}`)
  }
}

/**
 * 从 Gemini 响应内容中提取图片 base64
 * 支持原生 Gemini 格式和 G3Pro Anthropic 格式
 */
function parseImageFromResponse(responseData, format = 'google') {
  if (format === 'anthropic') {
    // G3Pro 返回的 Anthropic 格式
    const content = responseData?.choices?.[0]?.message?.content || ''

    // ![...](data:image/...;base64,...)
    const mdMatch = content.match(/!\[.*?\]\(data:image\/(jpeg|png|webp);base64,([^)]+)\)/)
    if (mdMatch) return { image: mdMatch[2], mimeType: `image/${mdMatch[1]}`, text: content }

    // data:image/...;base64,...
    const rawMatch = content.match(/data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)/)
    if (rawMatch) return { image: rawMatch[2], mimeType: `image/${rawMatch[1]}`, text: content }

    // 纯文本
    return { image: null, mimeType: null, text: content }
  }

  // OpenRouter 格式：图片在 message.images[] 数组中
  if (format === 'openrouter') {
    const message = responseData?.choices?.[0]?.message || {}
    const content = message.content || ''

    // 优先从 images 数组提取（OpenRouter 标准返回方式）
    if (message.images && Array.isArray(message.images) && message.images.length > 0) {
      const imgObj = message.images[0]
      const dataUrl = imgObj?.image_url?.url || ''
      const match = dataUrl.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/)
      if (match) return { image: match[2], mimeType: `image/${match[1]}`, text: content }
    }

    // fallback: content 中可能也包含 base64（兼容部分 provider）
    const match = content.match(/data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)/)
    if (match) return { image: match[2], mimeType: `image/${match[1]}`, text: content }
    return { image: null, mimeType: null, text: content }
  }

  if (format === 'openai') {
    // ConcurrentAPI 返回的 OpenAI Chat Completions 格式
    const content = responseData?.choices?.[0]?.message?.content || ''
    const match = content.match(/data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)/)
    if (match) return { image: match[2], mimeType: `image/${match[1]}`, text: content }
    return { image: null, mimeType: null, text: content }
  }

  // Google 原生格式
  const candidates = responseData?.candidates || []
  let text = ''
  for (const cand of candidates) {
    for (const part of (cand.content?.parts || [])) {
      if (part.text) text += part.text
      const inlineData = part.inlineData || part.inline_data
      if (inlineData?.data) {
        return {
          image: inlineData.data,
          mimeType: inlineData.mimeType || inlineData.mime_type || 'image/png',
          text
        }
      }
    }
  }
  return { image: null, mimeType: null, text }
}

/**
 * GridFS fileId → data URL base64
 */
async function fileIdToBase64(fileId) {
  const fileData = await FileService.getFile(fileId)
  const chunks = []
  for await (const chunk of fileData.stream) {
    chunks.push(chunk)
  }
  const buffer = Buffer.concat(chunks)
  const mimeType = fileData.mimeType || 'image/jpeg'
  return `data:${mimeType};base64,${buffer.toString('base64')}`
}

/**
 * base64 → GridFS，返回 fileId
 */
async function saveBase64ToGridFS(base64Data, filenamePrefix = 'furniai-generated') {
  let buffer
  let mimeType = 'image/png'

  if (base64Data.startsWith('data:')) {
    const match = base64Data.match(/^data:([^;]+);base64,([\s\S]+)$/)
    if (match) {
      mimeType = match[1]
      // 清理 base64 中可能混入的空白/换行字符（防止解码异常）
      buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64')
    } else {
      buffer = Buffer.from(base64Data, 'base64')
    }
  } else {
    buffer = Buffer.from(base64Data, 'base64')
  }

  const ext = mimeType.includes('png') ? '.png' : '.jpg'
  const filename = `${filenamePrefix}-${Date.now()}${ext}`
  const result = await FileService.upload(buffer, filename, mimeType, 'gridfs')
  return result.fileId
}

module.exports = {
  extractPureBase64,
  toDataUrl,
  urlToBase64,
  normalizeImageInput,
  parseImageFromResponse,
  fileIdToBase64,
  saveBase64ToGridFS,
}
