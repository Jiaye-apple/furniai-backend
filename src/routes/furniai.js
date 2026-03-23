/**
 * FurnIAI — Routes
 * 独立 AI 生图模块路由，挂载到 /api/ai/furniai
 */
const express = require('express')
const router = express.Router()
const { auth } = require('../middleware/auth')
const ctrl = require('../controllers/furniaiController')

// ========== 公开接口 ==========
router.get('/config', ctrl.getConfig)

// ========== 需要登录的接口 ==========
router.use(auth)

// 分析
router.post('/analyze', ctrl.analyze)
router.post('/detect-elements', ctrl.detectElements)
router.post('/material/analyze', ctrl.analyzeMaterial)
router.post('/deep-analyze', ctrl.deepAnalyze)

// 生成
router.post('/generate', ctrl.generate)
router.post('/fuse', ctrl.fuse)
router.post('/material/apply', ctrl.applyMaterial)
router.post('/edit', ctrl.edit)

// Excel
router.post('/excel/analyze-headers', ctrl.analyzeExcelHeaders)
router.post('/excel/parse-row', ctrl.parseExcelRow)

// 新增：前端 prompt 迁移后的业务 API
router.post('/refine-plan', ctrl.refineExecutionPlan)
router.post('/segment-element', ctrl.segmentElement)
router.post('/selling-points', ctrl.generateSellingPoints)
router.post('/canvas-prompt', ctrl.extractCanvasPrompt)

// 批量任务
router.post('/batch/submit', ctrl.batchSubmit)
router.get('/batch', ctrl.batchList)
router.get('/batch/:taskId', ctrl.batchGet)
router.post('/batch/:taskId/retry', ctrl.batchRetry)
router.post('/batch/:taskId/cancel', ctrl.batchCancel)

module.exports = router
