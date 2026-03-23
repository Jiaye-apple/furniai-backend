const mongoose = require('mongoose')

const connectDB = async () => {
  // 根据环境自动选择数据库地址：development 用外网地址，production 用内网地址
  const isDev = process.env.NODE_ENV !== 'production'
  const uri = isDev
    ? (process.env.FURNIAI_MONGODB_URI_LOCAL || process.env.FURNIAI_MONGODB_URI)
    : process.env.FURNIAI_MONGODB_URI
  if (!uri) {
    console.error('❌ FURNIAI_MONGODB_URI 未配置')
    process.exit(1)
  }
  console.log(`[FurnIAI] 数据库模式: ${isDev ? '本地开发(外网)' : '线上(内网)'}`)

  try {
    // 显式设置连接超时（默认 30s 太久，容器健康检查可能先超时）
    const conn = await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 })
    console.log(`[FurnIAI] MongoDB connected: ${conn.connection.host}`)
    return conn
  } catch (err) {
    console.error(`[FurnIAI] MongoDB connection error: ${err.message}`)
    process.exit(1)
  }
}

module.exports = connectDB
