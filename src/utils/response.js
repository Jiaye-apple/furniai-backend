// Unified response format - 前端期望的格式
const successResponse = (data = null, message = '操作成功') => {
  return {
    success: true,
    data,
    message
  }
}

const errorResponse = (message = '错误', code = 400, data = null) => {
  return {
    success: false,
    message,
    error: data,
    code
  }
}

const paginatedResponse = (list = [], total = 0, page = 1, pageSize = 10) => {
  return {
    success: true,
    data: list,
    pagination: {
      page: parseInt(page),
      limit: parseInt(pageSize),
      total,
      totalPages: Math.ceil(total / pageSize)
    }
  }
}

// Helpers for controllers that want to operate directly on res
const sendResponse = (res, data = null, message = '操作成功', status = 200) => {
  return res.status(status).json(successResponse(data, message))
}

const sendError = (res, message = '错误', status = 400, data = null) => {
  return res.status(status).json(errorResponse(message, status, data))
}

module.exports = {
  successResponse,
  errorResponse,
  paginatedResponse,
  sendResponse,
  sendError
}
