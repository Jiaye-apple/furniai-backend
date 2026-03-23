/**
 * FurnIAI — Miniapp AI Routes
 * 小程序 AI 接口路由，挂载到 /api/ai/miniapp
 */
const express = require('express')
const router = express.Router()
const multer = require('multer')
const { auth } = require('../middleware/auth')
const aiController = require('../controllers/aiController')

// 图片上传配置（内存存储，最大 10MB）
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true)
    } else {
      cb(new Error('只支持图片格式'), false)
    }
  }
})

// ========== 配置数据（公开）==========
router.get('/config/styles', aiController.getStyleOptions)
router.get('/config/spaces', aiController.getSpaceOptions)
router.get('/config/fabrics', aiController.getFabricOptions)
router.get('/config/colors', aiController.getColorOptions)

// ========== 场景模板 ==========
router.get('/scene-templates', aiController.getSceneTemplates)

// ========== 需要登录的接口 ==========

// 素材管理
router.get('/materials', auth, aiController.getMaterials)
router.post('/materials', auth, aiController.saveMaterial)
router.delete('/materials/batch', auth, aiController.batchDeleteMaterials)
router.delete('/materials/:id', auth, aiController.deleteMaterial)

// AI 生成
router.post('/analyze', auth, aiController.analyzeImage)
router.post('/generate', auth, aiController.generateImage)
router.post('/upload-image', auth, upload.single('file'), aiController.uploadImage)

// 积分
router.get('/credits', auth, aiController.getCredits)
router.get('/credits/history', auth, aiController.getCreditHistory)

// 场景模板管理（角色检查由 backend 代理层完成）
router.post('/scene-templates', auth, aiController.createSceneTemplate)
router.put('/scene-templates/:id', auth, aiController.updateSceneTemplate)
router.delete('/scene-templates/:id', auth, aiController.deleteSceneTemplate)

// 使用到商品
router.post('/use-in-product', auth, aiController.useInProduct)

module.exports = router
