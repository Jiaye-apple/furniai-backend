/**
 * Admin — 管理面板路由
 * 挂载在 /admin 下，提供管理API和静态页面
 * 所有 /admin/api/* 接口（除 login 外）需要管理员认证
 */
const express = require('express')
const path = require('path')
const jwt = require('jsonwebtoken')
const router = express.Router()
const adminController = require('../controllers/adminController')

// ==================== 管理员认证中间件 ====================
/**
 * 验证管理员 JWT token
 * 从 Authorization: Bearer <token> 或 query 参数 ?token=xxx 中提取
 */
function adminAuth(req, res, next) {
    // 优先从 Authorization header 获取 token；
    // 对 /api/file/ 路径允许 query 参数传 token（因为 <img src> 无法设置 HTTP header）
    const token = req.headers.authorization?.split(' ')[1] || req.query.token
    if (!token) {
        return res.status(401).json({ success: false, message: '未登录，请先登录' })
    }
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET)
        // 确保是管理员 token（非普通用户 token）
        if (decoded.role !== 'admin') {
            return res.status(403).json({ success: false, message: '权限不足' })
        }
        req.adminUser = decoded.username
        next()
    } catch (err) {
        return res.status(401).json({ success: false, message: 'Token 无效或已过期，请重新登录' })
    }
}

// ==================== 静态页面 ====================
// GET /admin → 返回管理面板HTML（页面本身不需要认证，认证在前端 JS 中处理）
router.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/admin.html'))
})

// ==================== 登录接口（无需认证） ====================
router.post('/api/login', adminController.login)

// ==================== 以下接口需要管理员认证 ====================
router.use('/api', adminAuth)

// 获取全部配置
router.get('/api/config', adminController.getConfig)
// 更新配置（热更新）
router.put('/api/config', adminController.updateConfig)
// 用量统计（积分/图片数/用时/成功率）
router.get('/api/stats', adminController.getStats)
// 实时状态（队列/Key池/通道）
router.get('/api/status', adminController.getStatus)
// 代理获取端点模型列表
router.post('/api/models', adminController.getModels)
// 最近任务列表
router.get('/api/tasks', adminController.getRecentTasks)
// 批量删除任务
router.post('/api/tasks/batch-delete', adminController.batchDeleteTasks)
// 流式输出 GridFS 文件（任务详情里的图片预览）
router.get('/api/file/:fileId', adminController.serveFile)
// 重载配置（从DB刷新内存缓存）
router.post('/api/reload', adminController.reloadConfig)
// 测试喵提醒推送
router.post('/api/test-push', adminController.testMiaoPush)

// 平台鉴权密钥管理
router.get('/api/platform-keys', adminController.listPlatformKeys)
router.post('/api/platform-keys', adminController.createPlatformKey)
router.put('/api/platform-keys/:id', adminController.updatePlatformKey)
router.delete('/api/platform-keys/:id', adminController.deletePlatformKey)
router.post('/api/platform-keys/:id/regenerate', adminController.regeneratePlatformKey)

// 成本核算
router.get('/api/cost-report', adminController.getCostReport)

// API 接口管理
router.get('/api/endpoints', adminController.listApiEndpoints)
router.post('/api/endpoints', adminController.createApiEndpoint)
router.post('/api/endpoints/extract', adminController.extractApiEndpoint)
router.put('/api/endpoints/:id', adminController.updateApiEndpoint)
router.delete('/api/endpoints/:id', adminController.deleteApiEndpoint)
router.get('/api/endpoints/:id/doc', adminController.getApiEndpointDoc)

module.exports = router
