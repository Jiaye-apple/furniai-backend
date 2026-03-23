/**
 * ConfigManager — 配置管理器
 * 从 MongoDB 加载配置，合并环境变量默认值，提供热更新接口
 * 所有模块通过 configManager.get('key') 读取配置，而非直接 process.env
 */
const AdminConfig = require('../models/AdminConfig')

// 内存配置缓存（避免每次都查DB）
let _configCache = null
// 是否已初始化
let _initialized = false

// === 默认配置（来自环境变量和代码硬编码） ===
function getDefaults() {
    return {
        channelMode: process.env.FURNIAI_CHANNEL || 'auto',

        // 默认通道优先级
        channelPriority: [
            {
                id: 'concurrent',
                name: 'ConcurrentAPI',
                url: process.env.FURNIAI_CONCURRENT_API_URL || 'http://zx2.52youxi.cc:3000',
                apiKey: process.env.FURNIAI_CONCURRENT_API_KEY || '',
                backupUrl: process.env.FURNIAI_CONCURRENT_BACKUP_URL || '',
                backupKey: process.env.FURNIAI_CONCURRENT_BACKUP_KEY || '',
                protocol: 'openai',
                enabled: true,
                analysisModel: process.env.FURNIAI_CONCURRENT_ANALYSIS_MODEL || 'gemini-3-flash-preview',
                imageModel: process.env.FURNIAI_CONCURRENT_MODEL || 'gemini-3-pro-image-preview',
                backupImageModel: '',
                backupAnalysisModel: '',
                imageSize: '',
                aspectRatio: '',
            },
            {
                // 备用通道：独立通道条目，使用备用端点和Key
                id: 'concurrent-backup',
                name: 'ConcurrentAPI-备用',
                url: process.env.FURNIAI_CONCURRENT_BACKUP_URL || 'http://64.32.27.166:3015',
                apiKey: process.env.FURNIAI_CONCURRENT_BACKUP_KEY || '',
                backupUrl: '',
                backupKey: '',
                protocol: 'openai',
                enabled: true,
                analysisModel: process.env.FURNIAI_CONCURRENT_ANALYSIS_MODEL || 'gemini-3-flash-preview',
                imageModel: process.env.FURNIAI_CONCURRENT_MODEL || 'gemini-3-pro-image-preview',
                backupImageModel: '',
                backupAnalysisModel: '',
                imageSize: '',
                aspectRatio: '',
            },
            {
                id: 'g3pro',
                name: 'G3Pro代理',
                url: process.env.FURNIAI_G3PRO_URL || process.env.G3PRO_API_URL || 'https://gemini-api.wffreeget.xyz',
                apiKey: '',
                backupUrl: '',
                backupKey: '',
                protocol: 'anthropic',
                enabled: true,
                analysisModel: 'gemini-2.5-flash',
                imageModel: 'gemini-3-pro-image',
                backupImageModel: '',
                backupAnalysisModel: '',
                imageSize: '',
                aspectRatio: '',
            },
            {
                id: 'google',
                name: 'Google官方',
                url: process.env.FURNIAI_GOOGLE_BASE || 'https://furniai-api.xiaodiyanxuan.com',
                apiKey: '',
                backupUrl: '',
                backupKey: '',
                protocol: 'google',
                enabled: true,
                analysisModel: process.env.FURNIAI_GEMINI_MODEL || 'gemini-2.0-flash-exp',
                imageModel: process.env.FURNIAI_GEMINI_IMAGE_MODEL || 'gemini-2.0-flash-exp-image-generation',
                backupImageModel: '',
                backupAnalysisModel: '',
                imageSize: '',
                aspectRatio: '',
            },
        ],

        // Google API Keys
        googleApiKeys: (process.env.FURNIAI_GEMINI_API_KEYS || process.env.FURNIAI_GEMINI_API_KEY || '')
            .split(',')
            .map(k => k.trim())
            .filter(Boolean),

        keyPoolConfig: {
            cooldownThreshold: 3,
            cooldownWindowMs: 60000,
            cooldownDurationMs: 60000,
        },

        // 并发与限流
        concurrentMax: parseInt(process.env.FURNIAI_CONCURRENT_MAX) || 5,
        concurrentMaxConcurrency: parseInt(process.env.FURNIAI_CONCURRENT_MAX_CONCURRENCY) || 4,
        apiTimeoutMs: parseInt(process.env.FURNIAI_API_TIMEOUT) || 120000,
        retryCount: parseInt(process.env.FURNIAI_RETRY_COUNT) || 2,
        taskTimeoutMs: parseInt(process.env.FURNIAI_TASK_TIMEOUT) || 600000,
        tokenBucketConfig: {
            capacity: 5,
            refillRate: 1,
            refillInterval: 1000,
        },
        // 重试退避延迟（ms 数组）
        retryDelays: [2000, 4000, 8000, 16000],
        // Anthropic 协议 max_tokens 上限
        maxTokens: 4096,

        // 高级调度参数
        defaultAvgDurationMs: 60000,       // 默认平均任务耗时预估（ms）
        maxDurationSamples: 20,            // 耗时统计采样数量
        imagePreprocessTTLMs: 1800000,     // 参考图预处理缓存 TTL（ms）- 30分钟
        imagePreprocessMaxSize: 100,       // 参考图预处理缓存最大条数

        // 缓存参数
        analysisCacheSize: parseInt(process.env.FURNIAI_CACHE_SIZE) || 200,
        analysisCacheTTLMs: parseInt(process.env.FURNIAI_CACHE_TTL) || 3600000,

        // 积分单价：1积分 = 多少元（用于收入核算）
        creditUnitPrice: 0.1,
        // 通道×模型成本，key = "通道id:模型名"，value = { imageCost, analysisCost }
        modelCosts: {},
        // 历史成本核算起点
        accountingStartDate: null,

        // 积分成本
        creditCosts: {
            'white-bg': 20,
            'multi-view': 20,
            'dimensions': 20,
            'scene': 20,
            'cross-section': 25,
            'cad-views': 25,
            'six-views': 30,
            'scale-drawing': 20,
            'analyze': 5,
            'fuse': 30,
            'material-analyze': 5,
            'material-apply': 30,
            'detect-elements': 10,
            'edit': 30,
            'excel-headers': 5,
            'excel-row': 5,
            'furniture-extra': 5,
        },

        // 场景风格
        sceneStyles: [
            { id: 'auto', label: '自动', prompt: '' },
            { id: 'modern', label: '现代简约', prompt: 'Modern minimalist style interior with clean lines, neutral tones, and simple geometric forms.' },
            { id: 'new-chinese', label: '新中式', prompt: 'New Chinese style interior blending traditional Chinese elements with modern design, featuring rosewood accents, ink wash art, and zen aesthetics.' },
            { id: 'european', label: '欧式古典', prompt: 'European classical style interior with ornate moldings, rich fabrics, and antique furniture.' },
            { id: 'wabi-sabi', label: '侘寂', prompt: 'Wabi-sabi style interior with natural imperfections, organic textures, raw materials, and a serene minimalist atmosphere.' },
            { id: 'industrial', label: '工业风', prompt: 'Industrial loft style interior with exposed brick, metal pipes, and raw concrete.' },
            { id: 'nordic', label: '北欧', prompt: 'Scandinavian Nordic style interior with light wood, white walls, and cozy textiles.' },
            { id: 'vintage', label: '复古', prompt: 'Mid-century vintage style interior with retro furniture, warm wood tones, brass accents, and nostalgic decorative elements.' },
            { id: 'dark-wabi', label: '暗黑侘寂', prompt: 'Dark wabi-sabi style interior with moody tones, charcoal and black palette, raw textures, and dramatic shadow play.' },
        ],

        // CORS 白名单（可在管理面板开关和编辑）
        corsEnabled: false,  // 默认关闭白名单（允许所有 Origin）
        corsOrigins: (process.env.CORS_ORIGIN || '')
            .split(',')
            .map(o => o.trim())
            .filter(o => o && o !== '*'),
    }
}

// 缓存默认配置，避免每次 get() 未初始化时重复构造
const _defaults = getDefaults()

/**
 * 初始化：从DB加载配置，不存在则写入默认值
 */
async function init() {
    if (_initialized) return _configCache

    try {
        let dbConfig = await AdminConfig.findOne({ key: 'main' })

        if (!dbConfig) {
            // DB中无配置，写入默认值
            const defaults = getDefaults()
            dbConfig = await AdminConfig.create({ key: 'main', ...defaults })
            console.log('[ConfigManager] 首次初始化，已写入默认配置到DB')
        }

        _configCache = dbConfig.toObject()
        _initialized = true
        console.log('[ConfigManager] 配置加载完成 | concurrentMax=', _configCache.concurrentMax, '| apiTimeoutMs=', _configCache.apiTimeoutMs)

        // 启动配置校验，输出关键缺失项警告
        _validateConfig(_configCache)

        return _configCache
    } catch (err) {
        console.error('[ConfigManager] 初始化失败，使用默认配置:', err.message)
        _configCache = getDefaults()
        _initialized = true
        return _configCache
    }
}

/**
 * 配置校验：检查关键配置项是否完整，对缺失/异常值输出警告日志
 * 仅在启动和重载时执行，帮助管理员快速发现配置问题
 */
function _validateConfig(config) {
    const warnings = []

    // 检查通道配置
    const channels = config.channelPriority || []
    if (channels.length === 0) {
        warnings.push('⚠️ 未配置任何通道（channelPriority 为空），所有 API 调用将失败！请在管理面板 → 通道管理中添加至少一个通道。')
    } else {
        const enabledChannels = channels.filter(c => c.enabled)
        if (enabledChannels.length === 0) {
            warnings.push('⚠️ 所有通道都被禁用，API 调用将失败！请在管理面板启用至少一个通道。')
        }
        for (const ch of enabledChannels) {
            if (!ch.url) warnings.push(`⚠️ 通道 "${ch.name || ch.id}" 未设置 URL，该通道将无法使用。`)
            if (!ch.apiKey && ch.id !== 'google') warnings.push(`⚠️ 通道 "${ch.name || ch.id}" 未设置 API Key，该通道可能无法认证。`)
            if (!ch.imageModel && !ch.analysisModel) warnings.push(`⚠️ 通道 "${ch.name || ch.id}" 未设置任何模型名，该通道将无法处理请求。`)
        }
    }

    // 检查数值类配置的合理范围
    const numChecks = [
        { key: 'apiTimeoutMs', min: 5000, max: 600000, label: 'API超时时间', unit: 'ms', recommend: '60000-180000' },
        { key: 'taskTimeoutMs', min: 30000, max: 1800000, label: '任务超时时间', unit: 'ms', recommend: '120000-600000' },
        { key: 'concurrentMax', min: 1, max: 100, label: '最大并发数', unit: '', recommend: '3-20' },
        { key: 'maxTokens', min: 256, max: 100000, label: 'max_tokens', unit: '', recommend: '2048-8192' },
    ]
    for (const check of numChecks) {
        const val = config[check.key]
        if (val === undefined || val === null) {
            warnings.push(`⚠️ "${check.label}" 未设置，将使用系统默认值。建议范围: ${check.recommend}${check.unit}`)
        } else if (val < check.min || val > check.max) {
            warnings.push(`⚠️ "${check.label}" 的值 ${val} 超出合理范围 ${check.min}-${check.max}，可能导致异常。建议范围: ${check.recommend}${check.unit}`)
        }
    }

    // 检查重试延迟数组
    const delays = config.retryDelays
    if (!delays || !Array.isArray(delays) || delays.length === 0) {
        warnings.push('⚠️ 重试延迟数组（retryDelays）为空，API 调用失败后将无法重试。建议设置如: [2000, 4000, 8000, 16000]')
    }

    // 输出汇总
    if (warnings.length > 0) {
        console.warn('[ConfigManager] ========== 配置校验警告 ==========')
        for (const w of warnings) {
            console.warn('[ConfigManager]', w)
        }
        console.warn(`[ConfigManager] 共 ${warnings.length} 条警告，请在管理面板 → 系统设置中检查和修复。`)
        console.warn('[ConfigManager] ==========================================')
    } else {
        console.log('[ConfigManager] ✅ 配置校验通过，所有关键项正常。')
    }
}

/**
 * 获取配置项
 * @param {string} key - 配置键名，如 'channelMode'、'channelPriority'
 * @returns {*} 配置值
 */
function get(key) {
    if (!_configCache) {
        // 未初始化时使用默认值
        return key ? _defaults[key] : _defaults
    }
    if (!key) return _configCache
    return _configCache[key]
}

/**
 * 更新配置（热更新，不需要重启服务）
 * @param {Object} patch - 要更新的字段
 * @returns {Object} 更新后的完整配置
 */
async function update(patch) {
    try {
        // 只打印字段名，避免泄露 API Key 等敏感信息
        console.log('[ConfigManager] 更新 patch 字段:', Object.keys(patch).join(', '))
        const updated = await AdminConfig.findOneAndUpdate(
            { key: 'main' },
            { $set: patch },
            { new: true, upsert: true }
        )
        _configCache = updated.toObject()
        console.log('[ConfigManager] 配置已更新:', Object.keys(patch).join(', '), '| concurrentMax=', _configCache.concurrentMax, '| apiTimeoutMs=', _configCache.apiTimeoutMs)
        return _configCache
    } catch (err) {
        console.error('[ConfigManager] 更新配置失败:', err.message)
        throw err
    }
}

/**
 * 强制从DB重新加载配置
 */
async function reload() {
    _initialized = false
    return init()
}

module.exports = {
    init,
    get,
    update,
    reload,
    getDefaults,
}
