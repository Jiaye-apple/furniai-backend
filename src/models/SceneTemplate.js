const mongoose = require('mongoose')

const sceneTemplateSchema = new mongoose.Schema({
  name: { type: String, required: true },
  style: { type: String, required: true, index: true },
  space: { type: String, required: true, index: true },
  image: { type: String, required: true },
  thumbnail: { type: String, default: '' },
  orientation: { type: String, enum: ['landscape', 'portrait', 'squarish'], default: 'landscape' },
  popular: { type: Boolean, default: false },
  sortOrder: { type: Number, default: 0 },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  tags: [{ type: String }],
  description: { type: String, default: '' }
}, {
  timestamps: true
})

sceneTemplateSchema.index({ status: 1, sortOrder: -1, createdAt: -1 })

module.exports = mongoose.model('SceneTemplate', sceneTemplateSchema)
