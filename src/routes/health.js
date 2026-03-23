const express = require('express')
const router = express.Router()

// Lazy-load services with try/catch — they have complex dependencies
// that may not be available in all environments (e.g. tests)
let geminiClient = null
let taskQueue = null

try {
  geminiClient = require('../services/geminiClient')
} catch (e) {
  console.warn('[FurnIAI] Health: geminiClient not available:', e.message)
}

try {
  taskQueue = require('../services/taskQueue')
} catch (e) {
  console.warn('[FurnIAI] Health: taskQueue not available:', e.message)
}

router.get('/', (req, res) => {
  const health = {
    status: 'ok',
    service: 'furniai',
    version: '3.4.5',
    timestamp: new Date().toISOString()
  }

  // Gemini config
  try {
    if (geminiClient && typeof geminiClient.getConfig === 'function') {
      const config = geminiClient.getConfig()
      health.gemini = {
        channel: config.channel,
        keyPoolSize: config.keyPoolSize,
        concurrentAvailable: config.concurrentAvailable
      }
    }
  } catch (e) {
    health.gemini = { error: e.message }
  }

  // Queue stats
  try {
    if (taskQueue && typeof taskQueue.getQueueStats === 'function') {
      const stats = taskQueue.getQueueStats()
      health.queue = {
        running: stats.running,
        pending: stats.pending,
        maxConcurrency: stats.maxConcurrency
      }
    }
  } catch (e) {
    health.queue = { error: e.message }
  }

  res.json(health)
})

module.exports = router
