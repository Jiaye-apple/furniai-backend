/**
 * FurnIAI — Prompt Builder
 * 完整的 10+ taskType prompt 体系，从 furniai/services/geminiService.ts 迁移
 * 积分成本和场景风格支持从 configManager 动态读取
 */
const configManager = require('./configManager')

// ==================== Prompt 覆盖层（从 DB 读取用户自定义值） ====================

/**
 * 获取用户覆盖的 prompt（如果有），否则返回 null
 * @param {string} templateId - 模板 ID（如 'white-bg', 'analyze'）
 * @returns {string|null} 覆盖的 prompt 文本或 null
 */
function getPromptOverride(templateId) {
  const overrides = configManager.get('promptTemplates')
  if (overrides && overrides[templateId]) return overrides[templateId]
  return null
}

function _applyVars(template, vars) {
  // 只查找字符串里存在的 {key} 占位符并按需替换，避免正则注入风险并提升性能
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    return key in vars ? (vars[key] || '') : match
  })
}

// ==================== 多视图子类型 ====================
const MULTI_VIEW_SUBTYPES = [
  { id: 'front', label: 'Front View', promptKey: 'front' },
  { id: 'angle-45', label: '45° Angle', promptKey: 'angle-45' },
  { id: 'side', label: 'Side Profile', promptKey: 'side' },
  { id: 'back', label: 'Back View', promptKey: 'back' },
  { id: 'detail-texture', label: 'Material Texture', promptKey: 'detail-texture' },
  { id: 'detail-craft', label: 'Craftsmanship Detail', promptKey: 'detail-craft' },
]

// ==================== 场景风格 Prompt（动态读取） ====================

// 按需获取场景风格 Prompt（优先从configManager DB读取，否则用默认值）
function _getSceneStylePrompt(styleId) {
  const styles = configManager.get('sceneStyles') || configManager.getDefaults().sceneStyles || []
  const item = styles.find(s => s.id === styleId)
  return item ? (item.prompt || '') : undefined
}

// 兼容旧代码的常量引用（Proxy 代理，访问时动态按需获取最新值，防止全量创建）
const SCENE_STYLE_PROMPTS = new Proxy({}, {
  get(target, prop) {
    if (typeof prop !== 'string') return undefined
    return _getSceneStylePrompt(prop)
  }
})

// ==================== 积分消耗（动态读取） ====================
// 默认值从 configManager.getDefaults() 获取，避免重复维护
function _getDefaultCreditCosts() {
  return configManager.getDefaults().creditCosts || {}
}

// 按需动态获取积分成本（优先从configManager DB读取，否则用 getDefaults 默认值）
function _getCreditCost(type) {
  const customCosts = configManager.get('creditCosts')
  if (customCosts && type in customCosts) {
    return customCosts[type]
  }
  return _getDefaultCreditCosts()[type]
}

// 兼容旧代码的常量引用（Proxy 代理，访问时动态按需获取最新值，防止全量合并）
const CREDIT_COSTS = new Proxy({}, {
  get(target, prop) {
    if (typeof prop !== 'string') return undefined
    return _getCreditCost(prop)
  }
})

function calculateCreditCost(type, options = {}) {
  switch (type) {
    case 'white-bg':
      return (options.angleCount || 1) * (_getCreditCost('white-bg') || 20)
    case 'scene':
      return (_getCreditCost('scene') || 20) + (options.furnitureCount || 0) * (_getCreditCost('furniture-extra') || 5)
    default:
      return _getCreditCost(type) || 20
  }
}

// ==================== 生成视觉 Prompt ====================

// ==================== 随机化动态图库 (Random Prompt Pools) ====================
// 灯光池：明亮自然的商业/生活光线，适合电商产品展示
const DEFAULT_LIGHTING_POOLS = [
  "Bright natural daylight from large windows, soft even illumination, clean gentle shadows",
  "Soft morning sunlight filling the room, warm and inviting natural light, light airy atmosphere",
  "Bright overcast daylight, beautifully diffused wrap-around light, minimal soft shadows",
  "Clean studio-style natural light with soft fill, bright and well-lit space, subtle grounding shadows",
  "Warm afternoon sunlight through sheer curtains, naturally bright room, gentle directional light"
]

// 相机池：清晰锐利的产品摄影，电商级画质
const DEFAULT_CAMERA_POOLS = [
  "Photorealistic, shot with Sony A7RIV, 50mm lens, f/5.6, sharp focus throughout, commercial product photography",
  "Shot on 50mm lens, f/4, crisp details, bright and clean commercial aesthetic",
  "Professional e-commerce photography, 35mm lens, f/5.6, sharp product focus, bright background",
  "Clean commercial product shot, 85mm lens, f/4, slight background softness, product in sharp focus",
  "High-resolution lifestyle product photography, 50mm lens, f/4.5, natural perspective, sharp details"
]

// 不完美池：保留轻微自然生活感，真实但不脏乱
const DEFAULT_IMPERFECTION_POOLS = [
  "natural fabric texture visible, a casual and inviting lived-in feel, realistically placed cushions",
  "subtle natural fabric drape, tangible texture, slightly relaxed arrangement as if someone just stood up",
  "highly detailed material texture, realistic surface quality, warm and welcoming atmosphere",
  "visible weave and fabric grain, natural light catching the texture, cozy everyday living feel",
  "authentic relaxed home atmosphere, realistic materiality, a sense of everyday comfort"
]

// 道具池：按产品类别分组，确保道具与产品协调匹配
// 每个类别内随机抽取，生成多样化但合理的场景
const CATEGORY_PROP_POOLS = {
  SOFA: [
    "a soft throw blanket casually draped over one armrest, a couple of decorative cushions, warm lived-in feel",
    "a small side table nearby with a coffee cup and a book, cozy reading corner atmosphere",
    "a textured area rug underneath, a small potted plant on the floor beside the sofa, relaxed living room",
    "a floor lamp casting warm light nearby, a woven basket with a folded blanket, inviting homey scene",
    "a simple coffee table in front with a candle and a small tray, comfortable everyday living",
    "a few scattered cushions in coordinating colors, a lightweight throw folded on one side, casual elegance",
  ],
  BED: [
    "neatly layered bedding with a folded throw at the foot, matching nightstand with a small lamp and book",
    "soft plush pillows arranged naturally, a bedside table with a glass of water and reading glasses",
    "a cozy knitted blanket draped across the bed corner, warm ambient bedside lamp glow",
    "matching nightstands with simple ceramic vases, a soft rug beside the bed, peaceful bedroom setting",
    "a breakfast tray placed casually on the bed, morning light feel, a small plant on the windowsill behind",
    "layered textures with linen and cotton bedding, a pendant light above, serene sleep space",
  ],
  TABLE_CHAIR: [
    "a simple table setting with ceramic plates and glasses, a small vase with fresh flowers as centerpiece",
    "a neat place setting for two, a bread basket and a water pitcher, warm dining atmosphere",
    "a laptop and a cup of coffee on the table, modern work-from-home setting",
    "a few books and a potted herb on the table, bright and functional everyday workspace",
    "tableware in coordinating neutral tones, a folded linen napkin, casual elegant dining",
    "a simple fruit bowl and a coffee mug on the table surface, natural everyday scene",
  ],
  CABINET: [
    "a few neatly arranged decorative items on top: a small sculpture, books, a ceramic dish",
    "display items visible through glass doors or on open shelves: framed photos, a small clock, a vase",
    "a small plant on top of the cabinet, a decorative tray with a candle, organized and stylish storage",
    "a couple of books stacked with a small ornament on top, a mirror on the wall above, tidy hallway",
    "a set of matching storage boxes and a framed art print leaning against the wall nearby",
  ],
  COFFEE_TABLE: [
    "a stack of coffee table books, a small candle, a decorative bowl with keys or small items",
    "a tray with a teapot and two cups, a small succulent plant, relaxed afternoon tea moment",
    "a flower arrangement in a simple vase, a remote control, lived-in casual living room",
    "a bowl of fruit, a pair of reading glasses, a folded newspaper, comfortable everyday scene",
    "a decorative candle holder, a small potted plant, clean and styled but natural",
  ],
  DECOR: [
    "complementary decorative pieces in the background, neutral-toned wall art, cohesive styling",
    "a clean shelf or mantel with curated accessories, coordinating textures and colors",
    "placed on a textured surface or shelf with minimal surroundings, the decor item as the focus",
    "styled alongside one or two other accent pieces, clean background, curated vignette",
  ],
  // 通用兜底：任何无法匹配的产品类别都用此池
  OTHER: [
    "clean and bright setting with minimal complementary accessories that match the product style",
    "a small decorative plant or vase nearby as subtle accent, product as the clear focal point",
    "tasteful minimal styling with one or two coordinating accessories, bright lifestyle scene",
    "simple and clean composition, warm natural light, the product placed naturally in context",
    "a soft rug or textured surface underneath, a small accent piece nearby, inviting atmosphere",
  ],
}

// 根据产品类别获取对应的道具池
function getCategoryProps(category) {
  return CATEGORY_PROP_POOLS[category] || CATEGORY_PROP_POOLS['OTHER']
}

// 色彩风格池：明亮干净，适合电商展示，保留温暖居家感
const DEFAULT_COLOR_STYLE_POOLS = [
  "Bright and clean color palette, true-to-life color accuracy, warm natural tones",
  "Light and airy aesthetic, soft whites with warm accents, clean commercial look",
  "Natural warm color grading, vivid but not oversaturated, inviting home atmosphere",
  "Clean bright palette with subtle warm undertones, lifestyle magazine aesthetic",
  "True-to-life color reproduction, bright daylight white balance, professional product color accuracy"
]

// 辅助：优先使用自定义 pool，为空则回退默认值
const poolOrDefault = (pool, fallback) =>
  (Array.isArray(pool) && pool.length > 0) ? pool : fallback

function getPromptPools(category) {
  const pools = configManager.get('promptPools') || {}
  return {
    lighting: poolOrDefault(pools.lighting, DEFAULT_LIGHTING_POOLS),
    camera: poolOrDefault(pools.camera, DEFAULT_CAMERA_POOLS),
    imperfection: poolOrDefault(pools.imperfection, DEFAULT_IMPERFECTION_POOLS),
    prop: getCategoryProps(category),
    colorStyle: poolOrDefault(pools.colorStyle, DEFAULT_COLOR_STYLE_POOLS)
  }
}

function getRandomItem(arr) {
  if (!arr || arr.length === 0) return ''
  return arr[Math.floor(Math.random() * arr.length)]
}

function buildVisualPrompt(taskType, analysis = {}, options = {}) {
  const { userContext, enableHD } = options
  const spec = analysis?.specificType || analysis?.name || 'furniture'
  const mats = Array.isArray(analysis?.materials) ? analysis.materials.join(', ') : (analysis?.material || '')
  const color = analysis?.primaryColor || analysis?.color || ''
  const style = analysis?.style || ''
  const size = analysis?.sizeEstimate || analysis?.size || ''

  const contextNote = userContext
    ? `\n\nUSER-PROVIDED SPECIFICATIONS (USE THESE AS PRIMARY REFERENCE):\n${userContext}\nIMPORTANT: The above user-provided data takes priority over AI estimates. Use exact dimensions, materials, and details as specified by the user.`
    : ''

  const hdNote = enableHD
    ? `\n\nQUALITY REQUIREMENTS:\n- Ultra-high resolution output (4K quality)\n- Cinematic studio lighting with soft shadows\n- Ultra-sharp focus on all details\n- High contrast textures showing fabric/material detail\n- Professional commercial photography quality\n- No blur, no artifacts, no distortion`
    : `\n\nQUALITY: High resolution, sharp focus, professional quality.`

  const baseInfo = `SUBJECT: ${spec}\nMATERIALS: ${mats}\nCOLOR: ${color}\nSTYLE: ${style}`

  const colorConstraint = `\n\n⚠️ CRITICAL COLOR CONSISTENCY RULES ⚠️\n- The furniture color MUST be EXACTLY "${color}" - no exceptions\n- DO NOT change, shift, or interpret the color differently\n- Match the EXACT hue, saturation, and brightness of the source image\n- Color accuracy is MORE important than artistic interpretation\n- Any color deviation is considered a FAILURE`

  const extractionConstraint = `\n\n⚠️ CRITICAL EXTRACTION RULES ⚠️\n- Focus ONLY on the MAIN furniture subject.\n- STRICTLY IGNORE and REMOVE any surrounding objects, props, magazines, text labels, dimension annotations, floor mats, or background clutter.\n- Ensure the final result contains ONLY the clean, isolated furniture item.`

  // 随机化组件：根据产品类别动态匹配道具池
  const category = analysis?.category || 'OTHER'
  const pools = getPromptPools(category)

  // 公共变量映射（供 DB 覆盖模板变量插值使用）
  const vars = {
    baseInfo, colorConstraint, extractionConstraint, contextNote, hdNote,
    spec, mats, color, style, size, angleName: options.angleName || '',
    effectiveStyle: '', userContext: userContext || '',
    get randomLighting() { return getRandomItem(pools.lighting) },
    get randomCamera() { return getRandomItem(pools.camera) },
    get randomImperfection() { return getRandomItem(pools.imperfection) },
    get randomProp() { return getRandomItem(pools.prop) },
    get randomColorStyle() { return getRandomItem(pools.colorStyle) }
  }

  // 封装局部渲染器，统一处理 DB override 和 变量注入
  const render = (templateId, defaultPrompt) => {
    const override = getPromptOverride(templateId)
    return _applyVars(override || defaultPrompt, vars)
  }

  switch (taskType) {
    case 'white-bg': {
      return render('white-bg', `TASK: Create a professional e-commerce product photo.\n\n${baseInfo}\n${options.angleName ? `Angle: ${options.angleName}` : ''}\n\nREQUIREMENTS:\n1. Pure white background (#FFFFFF, RGB 255,255,255)\n2. Perfect isolation/cutout of the furniture\n3. Preserve 100% of original textures, stitching, and material details (${vars.randomImperfection})\n4. Professional product photography lighting (soft diffused light from above-left)\n5. Slight shadow underneath for grounding\n6. Center the product in frame with appropriate padding\n7. Keep exact proportions and shape of the original furniture${extractionConstraint}${contextNote}${hdNote}`)
    }

    case 'multi-view':
    case 'multi-view:front':
    case 'multi-view:angle-45':
    case 'multi-view:side':
    case 'multi-view:back':
    case 'multi-view:detail-texture':
    case 'multi-view:detail-craft': {
      const subType = taskType.includes(':') ? taskType.split(':')[1] : 'front'
      // 多视图子类型覆盖ID映射
      const subTypeIdMap = { 'front': 'multi-view-front', 'angle-45': 'multi-view-angle45', 'side': 'multi-view-side', 'back': 'multi-view-back', 'detail-texture': 'multi-view-texture', 'detail-craft': 'multi-view-craft' }
      const templateId = subTypeIdMap[subType] || subTypeIdMap['front']

      // 按需生成器 map，只构建实际需要的那一个 prompt（避免每次创建 6 个长字符串浪费）
      const viewPromptGen = {
        'front': () => `TASK: Create a professional FRONT VIEW product photo.\n\n${baseInfo}\n\nREQUIREMENTS:\n1. Straight-on front view (camera directly facing the furniture)\n2. Pure white background (#FFFFFF)\n3. Professional studio lighting (soft, even illumination)\n4. Show the full product in frame with appropriate padding\n5. Capture all front-facing details: buttons, cushions, patterns\n6. PRESERVE EXACT ORIGINAL COLOR - no color shift allowed\n7. High-quality photorealistic rendering${colorConstraint}${extractionConstraint}${contextNote}${hdNote}`,

        'angle-45': () => `TASK: Create a professional 45-DEGREE ANGLE product photo.\n\n${baseInfo}\n\nREQUIREMENTS:\n1. Three-quarter angle view (45 degrees from front)\n2. Show both front and side depth of the furniture\n3. Pure white background (#FFFFFF)\n4. Professional studio lighting\n5. Highlight 3D form and proportions\n6. PRESERVE EXACT ORIGINAL COLOR - identical to source image\n7. High-quality photorealistic rendering${colorConstraint}${extractionConstraint}${contextNote}${hdNote}`,

        'side': () => `TASK: Create a professional SIDE PROFILE product photo.\n\n${baseInfo}\n\nREQUIREMENTS:\n1. Clean 90-degree side view (perfect profile)\n2. Show the silhouette and depth of the furniture\n3. Pure white background (#FFFFFF)\n4. Professional studio lighting\n5. Capture side details: armrests, legs, seat depth\n6. PRESERVE EXACT ORIGINAL COLOR - must match source exactly\n7. High-quality photorealistic rendering${colorConstraint}${extractionConstraint}${contextNote}${hdNote}`,

        'back': () => `TASK: Create a professional BACK VIEW product photo.\n\n${baseInfo}\n\nREQUIREMENTS:\n1. Straight-on back view (camera facing the rear)\n2. Show the back panel, structure, and any rear details\n3. Pure white background (#FFFFFF)\n4. Professional studio lighting\n5. Capture back construction and finishing\n6. PRESERVE EXACT ORIGINAL COLOR - no color changes\n7. High-quality photorealistic rendering${colorConstraint}${extractionConstraint}${contextNote}${hdNote}`,

        'detail-texture': () => `TASK: Create an ULTRA CLOSE-UP of the material texture.\n\n${baseInfo}\n\nDETAIL SHOT REQUIREMENTS:\n1. Extreme close-up macro shot of the main material surface\n2. Show fabric weave / leather grain / wood texture in detail\n3. Fill 80% of frame with the texture\n4. Pure white or blurred background\n5. Sharp focus on material details\n6. PRESERVE EXACT ORIGINAL COLOR in the texture\n7. Highlight thread patterns, surface quality, color depth\n8. Professional macro photography quality${colorConstraint}${extractionConstraint}${contextNote}${hdNote}`,

        'detail-craft': () => `TASK: Create an ULTRA CLOSE-UP of craftsmanship details.\n\n${baseInfo}\n\nDETAIL SHOT REQUIREMENTS:\n1. Extreme close-up of a key craftsmanship area\n2. Focus on ONE of: stitching lines, seams, hardware, edge finishing\n3. Fill 80% of frame with the detail\n4. Pure white or blurred background\n5. Sharp focus showing precision workmanship\n6. PRESERVE EXACT ORIGINAL COLOR of materials\n7. Professional macro photography quality${colorConstraint}${extractionConstraint}${contextNote}${hdNote}`,
      }
      return render(templateId, (viewPromptGen[subType] || viewPromptGen['front'])())
    }

    case 'multi-view:collage': {
      return render('multi-view-collage', `TASK: Create a professional multi-angle product collage sheet.\n\nSUBJECT: ${spec}\nMATERIALS: ${mats}\nCOLOR: ${color}\nSIZE: ${size}\n\nCOLLAGE REQUIREMENTS:\n1. Create a SINGLE composite image with 4-6 views of the furniture:\n   - FRONT VIEW (largest, center)\n   - 45-DEGREE ANGLE VIEW\n   - SIDE VIEW\n   - BACK VIEW\n   - DETAIL: material texture close-up\n   - DETAIL: craftsmanship close-up\n2. Pure white background (#FFFFFF)\n3. Professional product catalog layout\n4. Photorealistic quality for each view\n5. Consistent lighting and color across all views\n6. NO text, NO labels on the image\n7. Clean grid or artistic arrangement${extractionConstraint}${contextNote}${hdNote}`)
    }

    case 'dimensions': {
      return render('dimensions', `TASK: Create a technical dimension diagram for this furniture.\n\nSUBJECT: ${spec}\nSIZE CATEGORY: ${size}\n\nDIMENSION ANNOTATION REQUIREMENTS:\n1. Keep the original product photo\n2. Add clean, professional dimension lines in BLACK\n3. Show dimension lines with arrows at endpoints\n4. Display ONLY numbers with "cm" unit (e.g., "180cm", "85cm", "90cm")\n5. NO text labels, NO words, NO language - ONLY numbers + cm\n6. Background: Pure white or light gray (#F5F5F5)\n7. Lines should not overlap the product\n8. Show: width (horizontal), height (vertical), depth (front-back)\n\nCRITICAL: Numbers and "cm" only. No letters except "cm". No Chinese, no English words.\n${userContext ? `Dimensions: ${userContext}` : 'Estimate based on furniture type.'}${hdNote}`)
    }

    case 'scene': {
      const sceneStyle = options.sceneStyle || 'auto'
      const styleDesc = SCENE_STYLE_PROMPTS[sceneStyle] || ''
      const effectiveStyle = sceneStyle === 'auto' ? style : styleDesc
      vars.effectiveStyle = effectiveStyle
      return render('scene', `TASK: Create a bright, realistic e-commerce lifestyle scene photo for this furniture product (suitable for Amazon/Wayfair product listing).\n\n${baseInfo}\n\nSCENE REQUIREMENTS:\n1. Create a photorealistic, BRIGHT and well-lit interior setting — a real-looking lifestyle product photo for online shopping\n2. Style should match: ${effectiveStyle}\n3. Lighting: ${vars.randomLighting}\n4. Camera & Tone: ${vars.randomCamera}, ${vars.randomColorStyle}\n5. Realism Details: ${vars.randomImperfection}\n6. Scene Styling: ${vars.randomProp}\n7. The furniture MUST be the clear hero/focal point, occupying at least 60-70% of the frame\n8. The scene, props, and accessories must HARMONIZE with the product type — choose items that naturally belong in the same space (e.g., bedding accessories for beds, tableware for dining tables, cushions for sofas)\n9. Clean, bright, modern living space with natural daylight feel — NOT dark, NOT moody, NOT overly dramatic\n10. The setting should look like a real, naturally lived-in home — warm, inviting, slightly imperfect, authentic\n11. Decorative plants, flowers, or greenery may appear as small background/side accents but NEVER dominate the foreground or obscure the product\n12. Variety is important — each generated image should feel unique with different compositions, angles, and styling details\n13. The overall image must look like a professional e-commerce product lifestyle photo — bright, inviting, and aspirational${extractionConstraint}${contextNote}${hdNote}`)
    }

    case 'cross-section': {
      return render('cross-section', `TASK: Create an exploded view / cross-section diagram showing internal structure.\n\nSUBJECT: ${spec}\nMATERIALS: ${mats}\n\nCROSS-SECTION REQUIREMENTS:\n1. Show the furniture as a technical exploded/cutaway view\n2. Reveal internal construction layers and materials\n3. Display: frame structure, padding layers, fabric/leather covering\n4. Use clean isometric or 3/4 view perspective\n5. Label materials in ENGLISH: Wood Frame, High Density Foam, Leather/Fabric, Springs\n6. Clean white or light gray background\n7. Professional technical illustration style\n8. Show craftsmanship details: joints, stitching, reinforcements\n9. Use thin black lines for section cuts\n10. Color-code different material layers for visual distinction${contextNote}${hdNote}`)
    }

    case 'cad-views': {
      return render('cad-views', `TASK: Create a professional three-view product rendering layout.\n\nSUBJECT: ${spec}\nMATERIALS: ${mats}\nCOLOR: ${color}\nSIZE: ${size}\n\nTHREE-VIEW REQUIREMENTS:\n1. Create a COMPOSITE IMAGE with 3 photorealistic views:\n   - FRONT - largest, center or left\n   - SIDE - right side, profile view\n   - TOP - smaller, above or corner\n2. CRITICAL: Keep REAL furniture appearance:\n   - Preserve original colors, textures, materials\n   - Photorealistic quality, NOT line drawings\n   - Each view = real photo from that angle\n3. Pure white background (#FFFFFF)\n4. NO text labels on image - views distinguished by position only\n5. Professional product catalog style\n6. Consistent lighting across views\n7. Accurate proportions\n\nCRITICAL: NO text, NO labels, NO words on the image. Visual arrangement only.\n${userContext ? `Dims: ${userContext}` : ''}${extractionConstraint}${hdNote}`)
    }

    case 'six-views': {
      return render('six-views', `TASK: Create a complete six-view product rendering layout.\n\nSUBJECT: ${spec}\nMATERIALS: ${mats}\nCOLOR: ${color}\nSIZE: ${size}\n\nSIX-VIEW REQUIREMENTS:\n1. COMPOSITE IMAGE with 6 photorealistic views in grid:\n   - FRONT / BACK\n   - LEFT / RIGHT\n   - TOP / BOTTOM\n2. CRITICAL: Photorealistic quality for all views:\n   - Same colors, materials, textures as original\n   - NOT line drawings or sketches\n   - Each view = real photograph\n3. Grid layout: 2x3 or 3x2\n4. Pure white background\n5. NO text labels on image - views distinguished by grid position only\n6. Professional product documentation style\n7. Consistent studio lighting\n8. Accurate proportions\n\nCRITICAL: NO text, NO labels, NO words on the image. Visual grid only.\n${contextNote}${extractionConstraint}${hdNote}`)
    }

    case 'scale-drawing': {
      return render('scale-drawing', `TASK: Create a precise scale technical dimension drawing.\n\nSUBJECT: ${spec}\nSIZE: ${size}\n\nSCALE DRAWING REQUIREMENTS:\n1. Detailed dimension drawing at TRUE SCALE\n2. Include ALL measurements with dimension lines\n3. Dimension annotation style:\n   - Thin black lines with arrows\n   - ONLY numbers + "cm" (e.g., "180cm", "85cm")\n   - NO letters except "cm", NO words\n4. White background\n5. Multiple views if needed for complete dimensioning\n6. Reference grid optional\n\nCRITICAL: Numbers and "cm" only. No text, no labels, no language.\n${userContext ? `Dims: ${userContext}` : 'Estimate based on type/size.'}${hdNote}`)
    }

    default:
      return `TASK: Enhance this furniture product photo.\n\nSUBJECT: ${spec}\n\nREQUIREMENTS:\n1. Improve overall image quality\n2. Better lighting and contrast\n3. Clean background\n4. Sharp focus on all details${contextNote}${hdNote}`
  }
}

// ==================== 分析 Prompt ====================

function buildAnalyzePrompt() {
  // 优先使用 DB 覆盖值
  const override = getPromptOverride('analyze')
  if (override) return override

  return `Analyze this furniture image. Return JSON only with these fields:
1. category: One of [SOFA, BED, TABLE_CHAIR, CABINET, COFFEE_TABLE, DECOR, OTHER]
2. specificType: Specific type, e.g. "3-Seater Fabric Sofa", "King Size Bed"
3. materials: Array of materials, e.g. ["Leather", "Oak Wood", "Stainless Steel"]
4. style: Style name, e.g. "Modern", "Nordic", "Industrial", "Classical"
5. primaryColor: Color name, e.g. "Beige", "Dark Brown", "Gray"
6. sizeEstimate: One of ["S", "M", "L"] based on typical furniture scale

Return ONLY valid JSON, no markdown, no explanation.`
}

// ==================== 材质分析 Prompt ====================

function buildMaterialAnalyzePrompt() {
  // 优先使用 DB 覆盖值
  const override = getPromptOverride('material-analyze')
  if (override) return override

  return `You are a professional material and texture analyst. Analyze this texture image.

Tasks:
1. Identify material type (e.g., Wood, Leather, Fabric, Metal, Stone)
2. Give specific material name (e.g., Oak Grain, Italian Nappa Leather, Brushed Steel)
3. List 2-4 descriptive tags

Output JSON: {
  "name": "Specific Name",
  "category": "Category",
  "tags": ["Tag1", "Tag2"]
}

Output ONLY JSON.`
}

// ==================== 融合 Prompt ====================

// 融合模式枚举（用于精确匹配，避免用户输入模糊命中错误分支）
const FUSION_MODES = ['strict', 'extract', 'quality', 'default']

function buildFusionPrompt(mode = 'default') {
  // 如果传入的 mode 不在枚举中，回退到 default
  if (!FUSION_MODES.includes(mode)) mode = 'default'

  if (mode === 'strict') {
    // 优先使用 DB 覆盖值
    const override = getPromptOverride('fusion-strict')
    if (override) return override
    return `TASK: Strict Product Placement (Perspective Preservation)

Instructions:
1. Identify the product from the FIRST image (transparent or white background).
2. Place it into the scene in the SECOND image.
3. CRITICAL: DO NOT CHANGE THE ANGLE, PERSPECTIVE, OR SHAPE of the product.
4. The product geometry must remain EXACTLY as provided in the source image.
5. ONLY generate realistic shadows, reflections, and lighting on the product to match the scene.
6. Do not distort, rotate, or morph the product.
7. Output a photorealistic result where the product looks naturally placed but geometrically identical to source.

IMPORTANT: The user has already positioned the product. Your job is LIGHTING and SHADOWS integration only.`
  }

  if (mode === 'extract') {
    const override = getPromptOverride('fusion-extract')
    if (override) return override
    return `TASK: Extract Product and Place Into Scene

Instructions:
1. Identify and precisely extract the MAIN furniture/product from the FIRST image
2. STRICTLY IGNORE and REMOVE any surrounding non-subject objects like props, magazines, text labels, floor mats, or dimension annotations from the extracted product
3. Place the clean, extracted product naturally into the interior scene shown in the SECOND image
4. CRITICAL: The product size must be REALISTIC and proportional to the room - NOT too large or too small
5. Match the perspective angle of the product to the scene's vanishing point
6. Add natural shadows and reflections so the product appears to truly belong in the space
7. Adjust the product's lighting color to match the scene's light sources
8. Output a high-definition, photorealistic interior visualization

IMPORTANT: The final result should look like the product was originally photographed in that scene, NOT like it was pasted in later.`
  }

  if (mode === 'quality') {
    const override = getPromptOverride('fusion-quality')
    if (override) return override
    return `TASK: Quality and Style Transfer

Instructions:
1. Analyze the overall color atmosphere, high-quality texture, and lighting effects of the FIRST image
2. Apply this quality style to the SECOND image
3. Enhance the clarity, lighting details, and material textures
4. Maintain the main subject and layout of the SECOND image unchanged
5. Output a high-definition, professional-grade interior visualization`
  }

  // 默认融合模式
  const override = getPromptOverride('fusion-default')
  if (override) return override
  return `TASK: Intelligent Image Fusion

Instructions:
1. Identify the core element (furniture, product, etc.) from the FIRST image
2. Perfectly merge it with the scene from the SECOND image
3. Ensure the merged element has CORRECT SIZE PROPORTIONS that match real-world spatial relationships
4. Maintain lighting consistency and add natural shadows
5. Generate a photorealistic high-definition interior visualization

GOAL: The final image should look like a real photograph, NOT a digitally composited image.`
}

// ==================== 材质贴图 Prompt ====================

function buildMaterialApplyPrompt(materialName = 'Material', targetPart = 'Whole', excludeParts = '') {
  const excludeNote = (excludeParts || '').trim()
    ? `\n\n⚠️ EXCLUSION ZONES (DO NOT APPLY MATERIAL TO THESE AREAS):\n${excludeParts}\nKeep these areas in their ORIGINAL material/texture.`
    : ''
  const targetArea = targetPart === '整体' || targetPart === 'Whole' ? 'Apply to ENTIRE furniture' : `Apply specifically to the ${targetPart} area`

  // 优先使用 DB 覆盖值（支持变量插值）
  const override = getPromptOverride('material-apply')
  if (override) return _applyVars(override, { materialName, targetPart: targetArea, excludeNote })

  return `TASK: Material Texture Replacement (STRICT CONSTRAINTS)

You have two images:
1. FIRST IMAGE: A furniture product photo (REFERENCE for angle, perspective, composition)
2. SECOND IMAGE: A material texture sample (${materialName})

ABSOLUTE CONSTRAINTS:
- DO NOT change the camera angle or perspective
- DO NOT rotate or move the furniture
- DO NOT change the background or composition
- ONLY change the surface material/texture

Instructions:
1. Apply the texture/material from the SECOND image to the furniture in the FIRST image
2. Target area: ${targetArea}
3. Output image must match original perspective, lighting, and shadows EXACTLY.
4. Texture must follow furniture contours and perspective.
${excludeNote}
GOAL: "Material swap" while keeping everything else identical.`
}

// ==================== 部件检测 Prompt ====================

function buildElementDetectPrompt(lang = 'en') {
  const labelLang = lang === 'zh' ? 'Use Chinese labels' : 'Use English labels'
  const mainLabel = lang === 'zh' ? '主体' : 'Main Body'

  // 优先使用 DB 覆盖值（支持变量插值）
  const override = getPromptOverride('detect-elements')
  if (override) return _applyVars(override, { labelLang, mainLabel })

  return `Detect the main parts of this furniture. ${labelLang}

Rules:
- Return at most 5 main parts (e.g. the whole product, backrest, seat, legs, armrest)
- box_2d: [ymin, xmin, ymax, xmax], normalized 0-1000
- MUST include one item for the ENTIRE furniture with label "${mainLabel}"

Output JSON array ONLY:
[{"label": "name", "box_2d": [ymin, xmin, ymax, xmax]}]`
}

// ==================== AI 修图 Prompt ====================

function buildEditPrompt(instruction, hasReference = false) {
  if (hasReference) {
    // 优先使用 DB 覆盖值（支持变量插值）
    const override = getPromptOverride('edit-with-ref')
    if (override) return _applyVars(override, { instruction })
    return `TASK: Image Editing with Reference

You have two images:
1. FIRST IMAGE: The original image to be modified
2. SECOND IMAGE: A reference image for style/color/texture guidance

USER INSTRUCTION: ${instruction}

RULES:
1. Modify the FIRST image according to the user's instruction
2. Use the SECOND image as visual reference where applicable
3. Preserve the overall composition, perspective, and layout of the original
4. Only change what the user explicitly asked to change
5. Output a high-quality, photorealistic result
6. Do NOT add any text, watermark, or labels to the image

IMPORTANT: The result should look natural and professional, not like a crude edit.`
  }

  // 无参考图模式 - 优先使用 DB 覆盖值
  const overrideNoRef = getPromptOverride('edit-no-ref')
  if (overrideNoRef) return _applyVars(overrideNoRef, { instruction })

  return `TASK: Image Editing

You have one image that needs to be modified.

USER INSTRUCTION: ${instruction}

RULES:
1. Modify the image according to the user's instruction
2. Preserve the overall composition, perspective, and layout
3. Only change what the user explicitly asked to change
4. Output a high-quality, photorealistic result
5. Do NOT add any text, watermark, or labels to the image

IMPORTANT: The result should look natural and professional.`
}

// ==================== Excel Prompt ====================

function buildExcelHeaderPrompt(headers) {
  const headersList = headers.map((h, i) => `${i + 1}. ${h}`).join('\n')

  // 优先使用 DB 覆盖值
  const override = getPromptOverride('excel-headers')
  if (override) return _applyVars(override, { headersList })

  return `Analyze Excel column headers for furniture product data. Classify each column.

Headers:
${headersList}

Tasks:
1. Identify semantic type for each column: productName/dimensions/materials/style/image/notes/color/price/code/unknown
2. Find the most likely column for each key field (exact match original header name):
   - productNameCol: Product name/model/title
   - dimensionsCol: Size/dimensions (L*W*H format)
   - materialsCol: Material/fabric description
   - styleCol: Style/series/type
   - imageCol: Image/filename/photo column
   - notesCol: Notes/remarks
3. Separate useful columns vs ignored columns (ignore: price, code, stock, date)

Return JSON only.`
}

function buildExcelRowPrompt(rowData) {
  const rowString = Object.entries(rowData)
    .filter(([_, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')

  // 优先使用 DB 覆盖值
  const override = getPromptOverride('excel-row')
  if (override) return _applyVars(override, { rowString })

  return `Parse furniture product data from Excel row. Extract key information.

Row Data:
${rowString}

Extract (leave empty if not found, numbers only for dimensions in mm):
1. productName: Product name/model/title
2. overallDimensions: Overall size (e.g. "3200*1030*840")
3. width: Width in mm (number only)
4. depth: Depth in mm (number only)
5. height: Height in mm (number only)
6. materialDetails: Material description
7. armHeight: Arm height mm (number only)
8. armWidth: Arm width mm (number only)
9. seatDepth: Seat depth mm (number only)
10. seatHeight: Seat height mm (number only)
11. legHeight: Leg height mm (number only)
12. style: Style name
13. notes: Other important notes

Rules:
- Parse dimensions format like "Width*Depth*Height"
- Notes field may contain detail dimensions - extract them
- Ignore irrelevant fields

Return JSON.`
}

// ==================== 执行计划 Prompt ====================

function buildExecutionPlanPrompt(analysis, userContext, lang = 'en') {
  // 白名单字段提取，防止用户可控内容注入 prompt
  const safeFields = ['category', 'specificType', 'materials', 'style', 'primaryColor', 'sizeEstimate']
  const safeAnalysis = {}
  for (const key of safeFields) {
    if (analysis && key in analysis) safeAnalysis[key] = analysis[key]
  }
  const analysisStr = JSON.stringify(safeAnalysis)
  const langStr = lang === 'zh' ? 'Chinese' : 'English'

  // 优先使用 DB 覆盖值
  const override = getPromptOverride('execution-plan')
  if (override) return _applyVars(override, { analysis: analysisStr, userContext: userContext || '', lang: langStr })

  return `Initial Analysis: ${analysisStr}
User Additional Context: "${userContext || ''}"

Task: Create a bulleted "Execution Plan" summarizing how the AI will use this additional context to refine the image generation.
Specifically address if the user provided dimensions, style changes, or scene requirements.
Language: ${langStr}.
Keep it concise and professional.`
}

// ==================== 单元素分割 Prompt ====================
function buildSegmentElementPrompt(elementLabel) {
  const override = getPromptOverride('segment-element')
  if (override) return _applyVars(override, { elementLabel })

  return `You are a furniture element segmentation expert.
Given a furniture image, segment the element labeled "${elementLabel}".

Return a JSON array with the following structure:
[
  {
    "label": "element name",
    "box_2d": [ymin, xmin, ymax, xmax]
  }
]

RULES:
- box_2d values are normalized to 0-1000 range
- Be as precise as possible with the bounding box
- If the element is not found, return an empty array []
- Return ONLY the JSON array, no other text`
}

// ==================== 电商卖点 Prompt ====================
function buildSellingPointsPrompt(analysis, options = {}) {
  const { lang = 'zh', pointCount = 3, excelContext = '' } = options
  const langInstruction = lang === 'zh'
    ? '用中文回答，标题简洁有力（4-8字），描述一句话说明核心价值。'
    : 'Answer in English, titles should be concise (2-5 words), descriptions one clear sentence.'

  const override = getPromptOverride('selling-points')
  if (override) return _applyVars(override, {
    specificType: analysis?.specificType || '',
    materials: Array.isArray(analysis?.materials) ? analysis.materials.join(', ') : '',
    style: analysis?.style || '',
    primaryColor: analysis?.primaryColor || '',
    sizeEstimate: analysis?.sizeEstimate || '',
    excelContext, pointCount: String(pointCount), langInstruction, lang
  })

  return `You are an expert e-commerce copywriter. Analyze this furniture product image and generate compelling selling points for an e-commerce promotional banner.

PRODUCT INFO:
- Type: ${analysis?.specificType || ''}
- Materials: ${Array.isArray(analysis?.materials) ? analysis.materials.join(', ') : ''}
- Style: ${analysis?.style || ''}
- Color: ${analysis?.primaryColor || ''}
- Size: ${analysis?.sizeEstimate || ''}
${excelContext ? `- Additional Data: ${excelContext}` : ''}

TASK: Generate EXACTLY ${pointCount} selling points and 1 slogan.
⚠️ CRITICAL: You MUST return EXACTLY ${pointCount} selling points — not more, not less.

${langInstruction}

For each selling point, provide:
1. "title": Short punchy headline
2. "description": One sentence explaining the value
3. "icon": Suggest an icon name from this list: [shield, feather, ruler, palette, star, heart, zap, clock, leaf, gem, award, settings, truck, recycle, sun, moon, home, target, layers, box]

Also generate:
- "slogan": A catchy brand tagline for the product (${lang === 'zh' ? '中文' : 'English'})

Return ONLY valid JSON:
{
  "sellingPoints": [{ "title": "...", "description": "...", "icon": "..." }],
  "slogan": "..."
}`
}

// ==================== 画布描述提取 Prompt ====================
function buildCanvasPromptExtract(itemDescriptions, lang = 'en') {
  const override = getPromptOverride('canvas-prompt')
  if (override) return _applyVars(override, { itemDescriptions, lang: lang === 'zh' ? 'Chinese' : 'English' })

  return `Based on the following design canvas elements, generate a professional and creative interior design description.

Canvas Elements:
${itemDescriptions}

Task:
1. Describe a harmonious room scene incorporating these elements
2. Suggest style direction (modern, Scandinavian, luxury, etc.)
3. Include lighting and atmosphere suggestions
4. Use descriptive language suitable for AI image generation
5. Output in ${lang === 'zh' ? 'Chinese' : 'English'}
6. Keep it concise but evocative (2-3 sentences)

Output ONLY the design description text, no explanations.`
}

// ==================== 家具图片深度分析 Prompt ====================
function buildDeepAnalysisPrompt() {
  // 优先使用 DB 覆盖值
  const override = getPromptOverride('deep-analyze')
  if (override) return override

  return `你是一位资深的家具行业产品经理和营销策划专家。请对提供的家具产品图片进行全面、深度、专业的分析，产出一份完整的产品营销分析报告。

请严格按以下 JSON 结构返回结果（所有字段用中文填写）：

{
  "productName": "产品全称（包含风格+材质+品类，如：法式复古褶皱摩洛哥懒人沙发）",
  "targetAudience": "目标受众描述（一句话概括核心用户画像）",
  "coreSellingPoints": [
    {
      "title": "卖点标题（简洁有力，6-12字）",
      "description": "卖点详细描述（2-3句话，突出差异化价值）"
    }
  ],
  "materialProfile": {
    "material": "主要材质描述（触感、质感特征）",
    "gloss": "光泽感描述（光线表现、高级感体现）",
    "form": "形态描述（结构特征、外观廓形）"
  },
  "craftDetails": {
    "structure": "剪裁/结构设计（人体工学、承重等）",
    "stitching": "走线/缝纫工艺（针脚、纹理持久度）",
    "hardware": "五金/配件细节（拉链、底部设计等）",
    "specialDesign": "特殊设计亮点（独特辨识度元素）"
  },
  "functionalExperience": {
    "breathability": "透气/保暖性能",
    "elasticity": "弹性/回弹表现",
    "durability": "耐用性与日常护理",
    "seasonAdapt": "季节适配性"
  },
  "sceneMatching": {
    "bestScenes": ["最佳使用场景1", "场景2", "场景3"],
    "stylePosition": ["风格定位1", "风格定位2"],
    "matchSuggestions": [
      {
        "category": "搭配类别（如：地面搭配、周边家具、软装配饰）",
        "suggestion": "具体搭配建议"
      }
    ]
  }
}

分析要求：
1. 核心卖点(coreSellingPoints)至少提炼2个，最多4个，每个卖点要有独特的差异化角度
2. 所有描述要专业且富有营销感染力，像高端家居品牌的产品文案
3. 即使图片信息有限，也要基于专业经验合理推断，给出完整分析
4. 如果某些细节无法从图片明确判断，用专业术语进行合理推测并标注"（推测）"
5. 场景搭配建议(matchSuggestions)至少给出2条，最多4条

Return ONLY valid JSON, no markdown, no explanation.`
}

module.exports = {
  MULTI_VIEW_SUBTYPES,
  SCENE_STYLE_PROMPTS,
  CREDIT_COSTS,
  calculateCreditCost,
  buildVisualPrompt,
  buildAnalyzePrompt,
  buildMaterialAnalyzePrompt,
  buildFusionPrompt,
  buildMaterialApplyPrompt,
  buildElementDetectPrompt,
  buildEditPrompt,
  buildExcelHeaderPrompt,
  buildExcelRowPrompt,
  buildExecutionPlanPrompt,
  buildSegmentElementPrompt,
  buildSellingPointsPrompt,
  buildCanvasPromptExtract,
  buildDeepAnalysisPrompt,
  // Prompt 覆盖层查询（供前端 API 使用）
  getPromptOverride,
}
