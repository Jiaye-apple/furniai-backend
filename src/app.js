const express = require('express')
const cors = require('cors')

const app = express()

// CORS 中间件（从 configManager 动态读取白名单，支持管理面板热更新）
app.use(cors({
  origin: (origin, callback) => {
    // 运行时动态读取配置（支持管理面板热更新，无需重启）
    let corsEnabled = false
    let corsOrigins = []
    try {
      const configManager = require('./services/configManager')
      corsEnabled = configManager.get('corsEnabled') || false
      corsOrigins = configManager.get('corsOrigins') || []
    } catch (e) { /* 未初始化时默认允许所有 */ }

    // 无 Origin 的请求（如服务端调用、curl）始终放行
    if (!origin) return callback(null, true)

    // 白名单关闭 → 允许所有 Origin
    if (!corsEnabled) return callback(null, true)

    // 白名单为空 → 等同于关闭
    if (corsOrigins.length === 0) return callback(null, true)

    // 白名单匹配
    if (corsOrigins.includes(origin)) return callback(null, true)

    // 不在白名单 → 拒绝
    console.warn(`⚠️ [CORS] 拒绝非白名单 Origin: ${origin}`)
    return callback(new Error(`CORS blocked: ${origin}`))
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Internal-Key', 'x-user-id'],
  optionsSuccessStatus: 200
}))

// JSON 解析中间件 - 50MB 限制（足够放 2-3 张高分辨率 base64 图片）
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ extended: true, limit: '50mb' }))

// 路由挂载
app.use('/health', require('./routes/health'))
app.use('/api/ai/furniai', require('./routes/furniai'))
app.use('/api/ai/sku-ai', require('./routes/skuAi'))
app.use('/api/ai/miniapp', require('./routes/miniappAi'))
app.use('/proxy', require('./routes/proxy'))

// 管理面板路由（静态页面 + 管理API）
app.use('/admin', require('./routes/admin'))

// 404 处理（统一使用 errorResponse 格式）
const { errorResponse } = require('./utils/response')
app.use((req, res) => {
  res.status(404).json(errorResponse('Not Found', 404))
})

// 错误处理中间件（统一使用 errorResponse 格式）
app.use((err, req, res, _next) => {
  console.error('[FurnIAI] Error:', err.message)
  const status = err.status || 500
  res.status(status).json(errorResponse(err.message || 'Internal Server Error', status))
})

module.exports = app
