const mongoose = require('mongoose')

const skuAiTaskItemSchema = new mongoose.Schema({
  taskType: { type: String, required: true }, // whiteBg, effect, dimension, multiAngle, video
  status: { type: String, enum: ['pending', 'processing', 'completed', 'failed', 'skipped'], default: 'pending' },
  prompt: { type: String, default: null },    // 实际发给 AI 的提示词（执行时写入，供管理大盘展示）
  resultFileId: { type: String, default: null },
  error: { type: String, default: null },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  retryCount: { type: Number, default: 0 },
}, { _id: true })

const skuAiTaskSchema = new mongoose.Schema({
  requestId: { type: String, required: true, index: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  skuId: { type: String, required: true },
  skuCode: { type: String, default: '' },
  operatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  source: { type: String, default: 'admin_sku' },

  referenceImages: [String], // fileId 列表
  taskTypes: [String],

  options: {
    style: { type: String, default: '' },
    userContext: { type: String, default: '' },
    enableHD: { type: Boolean, default: false },
    lang: { type: String, default: 'zh' },
    channel: { type: String, default: 'auto' },
  },

  status: {
    type: String,
    enum: ['queued', 'running', 'succeeded', 'failed', 'canceled'],
    default: 'queued',
  },
  items: [skuAiTaskItemSchema],

  progress: { type: Number, default: 0 },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  error: { type: String, default: null },
  retryCount: { type: Number, default: 0 },

  // 实际使用的模型名称（生图成功后由 skuAiProcessor 回写）
  modelUsed: { type: String, default: null },

  // 关联的平台密钥 ID（用于子任务完成后异步更新平台调用统计）
  platformKeyId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlatformKey', default: null },

  // 详细流程日志（事无巨细记录任务每一步的时间戳和描述）
  timeline: [{
    ts: { type: Date, default: Date.now },   // 时间戳
    phase: { type: String },                 // 阶段标识
    msg: { type: String }                    // 人类可读描述
  }],

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
})

skuAiTaskSchema.index({ operatorId: 1, createdAt: -1 })
skuAiTaskSchema.index({ productId: 1, createdAt: -1 })
skuAiTaskSchema.index({ requestId: 1, createdAt: -1 })

module.exports = mongoose.model('SkuAiTask', skuAiTaskSchema)
