/**
 * AdminConfig — 管理面板配置持久化模型
 * 存储通道配置、模型选择、积分成本、风格Prompt等可视化管理的配置
 * 整个系统只有一条记录（singleton），通过 key='main' 标识
 */
const mongoose = require('mongoose')

// 通道条目 schema
const channelEntrySchema = new mongoose.Schema({
    // 通道唯一标识（concurrent / g3pro / google / 自定义名）
    id: { type: String, required: true },
    // 显示名称
    name: { type: String, required: true },
    // 端点URL
    url: { type: String, default: '' },
    // API Key（加密存储更好，这里先明文）
    apiKey: { type: String, default: '' },
    // 备用URL
    backupUrl: { type: String, default: '' },
    // 备用Key
    backupKey: { type: String, default: '' },
    // 协议格式：openai / anthropic / google / openrouter
    protocol: { type: String, enum: ['openai', 'anthropic', 'google', 'openrouter'], default: 'openai' },
    // 是否启用
    enabled: { type: Boolean, default: true },
    // 分析模型名
    analysisModel: { type: String, default: '' },
    // 图生成模型名
    imageModel: { type: String, default: '' },
    // 备用图生成模型名（主模型失败时自动切换）
    backupImageModel: { type: String, default: '' },
    // 备用分析模型名（主模型失败时自动切换）
    backupAnalysisModel: { type: String, default: '' },
    // 图片分辨率：''(默认1K) / '512px' / '1K' / '2K' / '4K'
    imageSize: { type: String, default: '' },
    // 宽高比：''(默认1:1) / '1:1' / '16:9' / '9:16' 等
    aspectRatio: { type: String, default: '' },
    // 从端点获取的可用模型列表（持久化缓存，刷新时更新）
    availableModels: [{
        id: { type: String },
        name: { type: String },
        _id: false,
    }],
}, { _id: false })

// 场景风格 schema
const sceneStyleSchema = new mongoose.Schema({
    // 风格标识（如 modern / new-chinese）
    id: { type: String, required: true },
    // 风格显示名称
    label: { type: String, required: true },
    // Prompt 文本
    prompt: { type: String, default: '' },
}, { _id: false })

// 主配置 schema
const adminConfigSchema = new mongoose.Schema({
    // 单例标识，固定为 'main'
    key: { type: String, default: 'main', unique: true },

    // === 通道配置 ===
    // 通道模式：auto / google / proxy / concurrent
    channelMode: { type: String, default: 'auto' },
    // 通道优先级列表（有序数组，索引越小优先级越高）
    channelPriority: [channelEntrySchema],

    // === Google Key池 ===
    googleApiKeys: [{ type: String }],
    // Key池参数
    keyPoolConfig: {
        cooldownThreshold: { type: Number, default: 3 },
        cooldownWindowMs: { type: Number, default: 60000 },
        cooldownDurationMs: { type: Number, default: 60000 },
    },

    // === 并发与限流 ===
    concurrentMax: { type: Number, default: 5 },
    concurrentMaxConcurrency: { type: Number, default: 4 },
    apiTimeoutMs: { type: Number, default: 120000 },
    retryCount: { type: Number, default: 2 },
    taskTimeoutMs: { type: Number, default: 600000 },
    tokenBucketConfig: {
        capacity: { type: Number, default: 5 },
        refillRate: { type: Number, default: 1 },
        refillInterval: { type: Number, default: 1000 },
    },
    // 重试退避延迟（ms 数组，按重试次数递增）
    retryDelays: { type: [Number], default: [2000, 4000, 8000, 16000] },
    // Anthropic 协议 max_tokens 上限
    maxTokens: { type: Number, default: 4096 },

    // === 高级调度参数 ===
    // 默认平均任务耗时预估（毫秒），冷启动时用于预estimateEstimate等待时间
    defaultAvgDurationMs: { type: Number, default: 60000 },
    // 耗时统计采样数量（保留最近 N 个任务的耗时用于计算平均值）
    maxDurationSamples: { type: Number, default: 20 },
    // 参考图预处理缓存过期时间（毫秒）
    imagePreprocessTTLMs: { type: Number, default: 1800000 },
    // 参考图预处理缓存最大条数
    imagePreprocessMaxSize: { type: Number, default: 100 },

    analysisCacheSize: { type: Number, default: 200 },
    analysisCacheTTLMs: { type: Number, default: 3600000 },

    // === 成本核算 ===
    // 积分单价：1积分 = 多少元
    creditUnitPrice: { type: Number, default: 0.1 },
    // 通道×模型成本 { "通道id:模型名": { imageCost, analysisCost } }
    modelCosts: { type: mongoose.Schema.Types.Mixed, default: {} },
    // 历史成本核算起点
    accountingStartDate: { type: String, default: null },

    // === 积分成本 ===
    creditCosts: { type: mongoose.Schema.Types.Mixed, default: {} },

    // === 场景风格 ===
    sceneStyles: [sceneStyleSchema],

    // === Prompt 模板覆盖 ===
    // 存储用户自定义的 prompt 覆盖值，key 为模板 id，value 为 prompt 文本
    // 仅存储用户修改过的条目，未修改的使用代码默认值
    promptTemplates: { type: mongoose.Schema.Types.Mixed, default: {} },

    // === CORS ===
    corsOrigin: { type: String, default: '*' },

}, { timestamps: true })

/**
 * 获取全局配置（单例模式，不存在则自动创建默认配置）
 */
adminConfigSchema.statics.getConfig = async function () {
    let config = await this.findOne({ key: 'main' })
    if (!config) {
        config = await this.create({ key: 'main' })
    }
    return config
}

/**
 * 更新全局配置（部分更新）
 * @param {Object} patch - 要更新的字段
 */
adminConfigSchema.statics.updateConfig = async function (patch) {
    const config = await this.findOneAndUpdate(
        { key: 'main' },
        { $set: patch },
        { new: true, upsert: true }
    )
    return config
}

module.exports = mongoose.model('AdminConfig', adminConfigSchema)
