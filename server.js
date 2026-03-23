require('dotenv').config()
const connectDB = require('./src/config/database')
const app = require('./src/app')

const PORT = process.env.FURNIAI_PORT || 3002

// 校验必需环境变量
const validateEnv = () => {
  const required = ['FURNIAI_MONGODB_URI', 'JWT_SECRET']
  const missing = required.filter(key => !process.env[key])

  if (missing.length > 0) {
    console.error(`❌ 缺少必需环境变量: ${missing.join(', ')}`)
    process.exit(1)
  }
}

// 启动服务器
const startServer = async () => {
  validateEnv()
  await connectDB()

  // 初始化管理面板配置（从DB加载，不存在则写入默认值）
  // 必须在重新调度之前完成，因为 taskQueue.enqueue 需要读取 configManager 的并发配置
  const configManager = require('./src/services/configManager')
  await configManager.init()

  // 执行所有按需的一次性启动校验、补偿与初始化任务（含任务重新队列、IP拉黑加载、自动密钥等）
  const bootstrapHacks = require('./src/services/bootstrapHacks')
  await bootstrapHacks.runInitializations()

  // 保存 HTTP server 引用到模块级变量，用于优雅关闭（不污染 global）
  _httpServer = app.listen(PORT, () => {
    console.log(`[FurnIAI] 服务运行在端口 ${PORT}`)
    console.log(`[FurnIAI] 环境: ${process.env.NODE_ENV || 'development'}`)
    console.log(`[FurnIAI] 健康检查: http://localhost:${PORT}/health`)
    console.log(`[FurnIAI] 管理面板: http://localhost:${PORT}/admin`)
  })
}

// 模块级 HTTP server 引用（供优雅关闭使用，不污染 global）
let _httpServer = null

startServer()

// 优雅关闭：先停止接受新连接，再关闭数据库
function gracefulShutdown(signal) {
  console.log(`\n📛 [FurnIAI] 收到 ${signal} 信号，正在优雅关闭...`)
  const mongoose = require('mongoose')
  if (_httpServer) {
    _httpServer.close(async () => {
      console.log('[FurnIAI] HTTP 服务已停止接受新连接')
      await mongoose.connection.close()
      console.log('[FurnIAI] 数据库连接已关闭，进程退出')
      process.exit(0)
    })
    // 5 秒后强制退出（防止长连接卡住）
    setTimeout(() => {
      console.warn('[FurnIAI] ⚠️ 强制退出（超时 5s）')
      process.exit(1)
    }, 5000)
  } else {
    mongoose.connection.close().then(() => {
      console.log('[FurnIAI] 数据库连接已关闭，进程退出')
      process.exit(0)
    })
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'))
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))

process.on('uncaughtException', (err) => {
  console.error('\n📛 [FurnIAI] 捕获到未处理的致命同步异常 (uncaughtException):', err)
  gracefulShutdown('UNCAUGHT_EXCEPTION')
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('\n📛 [FurnIAI] 捕获到未处理的异步拒绝 (unhandledRejection):', reason)
  gracefulShutdown('UNHANDLED_REJECTION')
})
