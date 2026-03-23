const mongoose = require('mongoose')

const aiMaterialSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title: { type: String, required: true },
  type: { type: String, enum: ['scene', 'furniture', 'texture', 'scheme'], required: true, index: true },
  image: { type: String, required: true },
  thumbnail: { type: String, default: '' },
  tags: [{ type: String }],
  sourceType: { type: String, enum: ['generate', 'upload', 'public'], default: 'generate' },
  sourceParams: { type: mongoose.Schema.Types.Mixed, default: {} },
  fileSize: { type: Number, default: 0 },
  width: { type: Number, default: 0 },
  height: { type: Number, default: 0 }
}, {
  timestamps: true
})

aiMaterialSchema.index({ userId: 1, type: 1, createdAt: -1 })

module.exports = mongoose.model('AiMaterial', aiMaterialSchema)
