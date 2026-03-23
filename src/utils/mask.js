/**
 * 通用 Token/Key 部分隐藏工具
 * 显示前 8 位 + **** + 后 4 位，短 token 只显示前 4 位
 */
function maskToken(token) {
    if (!token) return '****'
    if (token.length >= 12) return token.slice(0, 8) + '****' + token.slice(-4)
    if (token.length >= 4) return token.slice(0, 4) + '****'
    return '****'
}

module.exports = { maskToken }
