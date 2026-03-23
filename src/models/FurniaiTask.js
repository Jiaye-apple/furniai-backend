/**
 * FurnIAI — Task Model
 * 独立于 SkuAiTask，字段更通用，支持所有 FurnIAI taskType
 */
const mongoose = require('mongoose')

const furniaiTaskItemSchema = new mongoose.Schema({
  taskType: { type: String, required: true },
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed', 'skipped'],
    default: 'pending',
  },
  options: { type: mongoose.Schema.Types.Mixed, default: {} },
  prompt: { type: String, default: null },         // 实际发给 AI 的提示词（执行时写入，供管理大盘展示）
  resultFileId: { type: String, default: null },
  resultBase64: { type: String, default: null },
  resultText: { type: String, default: null },   // API 返回的文本内容（无论是否有图片都保存）
  error: { type: String, default: null },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
}, { _id: true })

const furniaiTaskSchema = new mongoose.Schema({
  requestId: { type: String, required: true, index: true },
  operatorId: { type: String, required: true },
  source: { type: String, default: 'furniai' },

  referenceImages: [mongoose.Schema.Types.Mixed],
  analysisCache: { type: mongoose.Schema.Types.Mixed, default: null },

  items: [furniaiTaskItemSchema],

  options: {
    style: { type: String, default: '' },
    userContext: { type: String, default: '' },
    enableHD: { type: Boolean, default: false },
    lang: { type: String, default: 'en' },
    channel: { type: String, default: 'auto' },
  },

  status: {
    type: String,
    enum: ['queued', 'running', 'succeeded', 'failed', 'canceled'],
    default: 'queued',
  },
  progress: { type: Number, default: 0 },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  error: { type: String, default: null },
  retryCount: { type: Number, default: 0 },

  // 实际使用的模型名称（生图成功后由 taskQueue 回写）
  modelUsed: { type: String, default: null },

  // 详细流程日志（事无巨细记录任务每一步的时间戳和描述）
  timeline: [{
    ts: { type: Date, default: Date.now },   // 时间戳
    phase: { type: String },                 // 阶段标识
    msg: { type: String }                    // 人类可读描述
  }],

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
})

furniaiTaskSchema.index({ operatorId: 1, createdAt: -1 })
furniaiTaskSchema.index({ requestId: 1, createdAt: -1 })

module.exports = mongoose.model('FurniaiTask', furniaiTaskSchema)
