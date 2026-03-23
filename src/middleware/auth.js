const crypto = require('crypto')
const { errorResponse } = require('../utils/response')
const PlatformKey = require('../models/PlatformKey')

/**
 * FurnIAI API 认证中间件
 * 
 * 仅接受以下认证方式（已禁用 JWT 认证）：
 * 1. X-Internal-Key 头 → 内部服务间调用
 * 2. Authorization: Bearer pk-xxx → 平台密钥认证
 */
const auth = async (req, res, next) => {
  try {
    // 1. 内部服务调用认证（使用常量时间比较，防止时序攻击）
    const internalKey = req.headers['x-internal-key']
    const expectedKey = process.env.FURNIAI_INTERNAL_KEY
    if (internalKey && expectedKey &&
      internalKey.length === expectedKey.length &&
      crypto.timingSafeEqual(Buffer.from(internalKey), Buffer.from(expectedKey))) {
      req.userId = req.headers['x-user-id'] || 'internal'
      req.user = { _id: req.userId, role: 'internal' }
      return next()
    }

    // 提取 Bearer token
    const token = req.headers.authorization?.split(' ')[1]
    if (!token) {
      return res.status(401).json(errorResponse('No token provided', 401))
    }

    // 2. 平台密钥认证（仅接受 pk- 前缀的密钥）
    if (token.startsWith('pk-')) {
      const platformKey = await PlatformKey.findOne({ key: token })
      if (!platformKey) {
        return res.status(401).json(errorResponse('Invalid platform key', 401))
      }
      if (platformKey.status !== 'active') {
        return res.status(401).json(errorResponse('Platform key is disabled', 401))
      }
      // 注入平台信息到请求对象
      req.userId = 'platform:' + platformKey.name
      req.user = { _id: req.userId, role: 'platform' }
      req.platformKey = platformKey  // 供 controller 更新统计
      return next()
    }

    // JWT 认证已禁用 — 非 pk- 前缀的 token 一律拒绝
    return res.status(401).json(errorResponse('Invalid token. Only platform keys (pk-xxx) are accepted.', 401))
  } catch (err) {
    return res.status(401).json(errorResponse('Invalid token', 401))
  }
}

module.exports = { auth }
