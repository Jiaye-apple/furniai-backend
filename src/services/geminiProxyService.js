const axios = require('axios')

const G3PRO_API_URL = process.env.G3PRO_API_URL || 'https://gemini-api.wffreeget.xyz'
const G3PRO_API_KEY = process.env.G3PRO_API_KEY || ''
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash-exp'

// 积分消耗规则
const CREDIT_COSTS = {
  'white-bg': 20,        // 每个角度
  'scene': 20,           // 基础 + 家具数×5
  'furniture-replace': 30,
  'texture-replace': 25,
  'soft-decoration': 30,
  'product-replace': 30,
  'analyze': 5,
  'furniture-extra': 5   // 每个额外家具
}

/**
 * 计算积分消耗
 */
function calculateCreditCost(type, options = {}) {
  switch (type) {
    case 'white-bg':
      return (options.angleCount || 1) * CREDIT_COSTS['white-bg']
    case 'scene':
      return CREDIT_COSTS['scene'] + (options.furnitureCount || 0) * CREDIT_COSTS['furniture-extra']
    case 'furniture-replace':
      return CREDIT_COSTS['furniture-replace']
    case 'texture-replace':
      return CREDIT_COSTS['texture-replace']
    case 'soft-decoration':
      return CREDIT_COSTS['soft-decoration']
    case 'product-replace':
      return CREDIT_COSTS['product-replace']
    case 'analyze':
      return CREDIT_COSTS['analyze']
    default:
      return 20
  }
}

/**
 * 构建生成提示词
 */
function buildPrompt(type, options = {}) {
  const { style, space, description, fabric, color, userContext } = options

  const prompts = {
    'white-bg': `You are a professional product photographer. Generate a high-quality product photo on pure white background.
${options.angleName ? `Angle: ${options.angleName}` : 'Angle: front view'}
Requirements: Clean white background, professional studio lighting, no shadows, catalog-quality image.
${description ? `Additional notes: ${description}` : ''}
${userContext ? `Context: ${userContext}` : ''}
Please generate the image.`,

    'scene': `You are a professional interior designer and photographer. Generate a realistic interior design scene photo.
Style: ${style || '现代简约'}
Space: ${space || '客厅'}
Requirements: Professional architectural photography, natural lighting, elegant furniture arrangement, warm atmosphere.
${description ? `Additional notes: ${description}` : ''}
${userContext ? `Context: ${userContext}` : ''}
Please generate the scene image with the provided furniture placed naturally in the space.`,

    'furniture-replace': `You are a professional interior designer. Replace the marked furniture in the scene with the provided replacement furniture.
Requirements: Maintain the same perspective, lighting, and overall scene atmosphere. The replacement should look natural and seamless.
${description ? `Additional notes: ${description}` : ''}
Please generate the modified scene.`,

    'texture-replace': `You are a professional product designer. Replace the material/texture of the furniture in the image.
${fabric ? `New fabric: ${fabric}` : ''}
${color ? `New color: ${color}` : ''}
Requirements: Maintain the exact same shape, perspective, and lighting. Only change the material/texture to match the specified fabric and color.
${description ? `Additional notes: ${description}` : ''}
Please generate the modified product image.`,

    'soft-decoration': `You are a professional interior designer specializing in soft furnishing and decoration.
Space: ${space || '客厅'}
Style: ${style || '现代简约'}
${options.houseStatus ? `House status: ${options.houseStatus}` : ''}
Requirements: Create a complete soft decoration scheme including furniture, textiles, lighting, and decorative items. Professional quality rendering.
${description ? `Additional notes: ${description}` : ''}
Please generate the interior design scheme.`,

    'product-replace': `You are a professional interior designer. Replace the marked product in the scene with the provided replacement product.
Requirements: Maintain perspective, lighting, scale, and overall atmosphere. Seamless integration.
${description ? `Additional notes: ${description}` : ''}
Please generate the modified scene.`,

    'analyze': `You are a furniture expert. Analyze this furniture image and provide the following information in JSON format:
{
  "category": "sofa|bed|table|chair|cabinet|lamp|other",
  "name": "furniture name in Chinese",
  "material": "primary material",
  "style": "design style",
  "color": "primary color",
  "dimensions": { "width": 0, "height": 0, "depth": 0 },
  "description": "brief description in Chinese",
  "tags": ["tag1", "tag2"]
}
Respond ONLY with valid JSON, no other text.`
  }

  return prompts[type] || prompts['analyze']
}

/**
 * 调用 Gemini API (通过代理)
 */
async function callGeminiAPI(prompt, imageBase64 = null, retries = 3) {
  const parts = [{ text: prompt }]

  if (imageBase64) {
    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '')
    parts.unshift({
      inline_data: {
        mime_type: 'image/jpeg',
        data: cleanBase64
      }
    })
  }

  const body = {
    contents: [{ parts }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 8192
    }
  }

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const url = `${G3PRO_API_URL}/v1beta/models/${GEMINI_MODEL}:generateContent?key=${G3PRO_API_KEY}`
      const response = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 60000,
        validateStatus: () => true
      })

      if (response.status !== 200) {
        console.error(`[GeminiProxy] API error (attempt ${attempt + 1}):`, response.status, JSON.stringify(response.data).slice(0, 200))
        if (response.status === 429) {
          if (attempt === retries - 1) {
            throw new Error(`Gemini API rate limit exceeded after ${retries} attempts (429)`)
          }
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
          continue
        }
        throw new Error(`Gemini API error: ${response.status}`)
      }

      const data = response.data
      const content = data?.candidates?.[0]?.content?.parts?.[0]
      if (!content) {
        throw new Error('Empty response from Gemini API')
      }

      return {
        text: content.text || '',
        image: content.inline_data?.data || null
      }
    } catch (err) {
      console.error(`[GeminiProxy] Attempt ${attempt + 1} failed:`, err.message)
      if (attempt === retries - 1) throw err
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
    }
  }
}

/**
 * AI 分析家具图片
 */
async function analyzeFurnitureImage(imageBase64) {
  const prompt = buildPrompt('analyze')
  const result = await callGeminiAPI(prompt, imageBase64)

  try {
    let jsonStr = result.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    return JSON.parse(jsonStr)
  } catch (e) {
    console.error('[GeminiProxy] Failed to parse analysis result:', e.message)
    return {
      category: 'other',
      name: '未识别家具',
      material: '未知',
      style: '未知',
      color: '未知',
      dimensions: { width: 0, height: 0, depth: 0 },
      description: result.text,
      tags: []
    }
  }
}

/**
 * AI 生成家具视觉图片
 */
async function generateFurnitureVisual(imageBase64, type, options = {}) {
  const prompt = buildPrompt(type, options)
  const result = await callGeminiAPI(prompt, imageBase64)

  if (result.image) {
    return { image: result.image, text: result.text }
  }

  return { image: null, text: result.text }
}

module.exports = {
  callGeminiAPI,
  analyzeFurnitureImage,
  generateFurnitureVisual,
  calculateCreditCost,
  buildPrompt,
  CREDIT_COSTS
}
