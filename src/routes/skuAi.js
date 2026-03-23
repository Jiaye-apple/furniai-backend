/**
 * FurnIAI — SKU AI Routes
 * SKU 批量生图路由，挂载到 /api/ai/sku-ai
 * 角色检查由 backend 代理层完成，furniai 仅做 JWT 验证
 */
const express = require('express')
const router = express.Router()
const { auth } = require('../middleware/auth')
const skuAiController = require('../controllers/skuAiController')

// 所有接口需要登录
router.use(auth)

// 提交批量生图任务
router.post('/submit', skuAiController.submitTask)

// 查询单个任务
router.get('/tasks/:taskId', skuAiController.getTask)

// 获取任务列表
router.get('/tasks', skuAiController.listTasks)

// 队列状态统计
router.get('/queue-stats', skuAiController.getQueueStats)

// 重试失败子任务
router.post('/tasks/:taskId/retry', skuAiController.retryTask)

// 重试单个失败子项
router.post('/tasks/:taskId/items/:itemId/retry', skuAiController.retryTaskItem)

module.exports = router
