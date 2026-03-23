/**
 * FurnIAI — File Service
 * GridFS 文件上传/下载/删除，与 backend FileService 保持一致
 */
const mongoose = require('mongoose')
const { v4: uuidv4 } = require('uuid')
const path = require('path')

// GridFS Bucket 初始化
let bucket
const conn = mongoose.connection

const initGridFSBucket = () => {
  try {
    if (!bucket && conn.db) {
      bucket = new mongoose.mongo.GridFSBucket(conn.db, {
        bucketName: 'uploads'
      })
      console.log('✅ [FurnIAI] GridFSBucket 初始化成功')
    }
  } catch (err) {
    console.warn('❌ [FurnIAI] GridFSBucket 初始化失败:', err.message)
  }
}

conn.once('open', () => {
  initGridFSBucket()
})

const ensureGridFSBucket = () => {
  if (!bucket) {
    initGridFSBucket()
  }
  return bucket
}

class FileService {
  static async uploadToGridFS(fileBuffer, originalName, mimeType, extraMetadata = {}) {
    return new Promise((resolve, reject) => {
      const gridFSBucket = ensureGridFSBucket()
      if (!gridFSBucket) {
        return reject(new Error('GridFSBucket 未初始化，请确保 MongoDB 已连接'))
      }

      const ext = path.extname(originalName)
      const filename = `${uuidv4()}${ext}`

      const uploadStream = gridFSBucket.openUploadStream(filename, {
        metadata: {
          originalName: originalName,
          uploadedAt: new Date(),
          mimeType: mimeType,
          ...(extraMetadata && typeof extraMetadata === 'object' ? extraMetadata : {}),
        },
      })

      const timeout = setTimeout(() => {
        uploadStream.destroy()
        reject(new Error('文件上传超时（120秒）'))
      }, 120000)

      uploadStream.on('finish', () => {
        clearTimeout(timeout)
        const fileId = uploadStream.id.toString()
        resolve({
          fileId,
          filename,
          originalName,
          url: `/api/files/${fileId}`,
          size: fileBuffer.length,
          mimeType,
          uploadedAt: new Date(),
        })
      })

      uploadStream.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })

      try {
        uploadStream.end(fileBuffer)
      } catch (err) {
        clearTimeout(timeout)
        reject(err)
      }
    })
  }

  static async downloadFromGridFS(fileId, downloadOptions = {}) {
    const gridFSBucket = ensureGridFSBucket()
    if (!gridFSBucket) {
      throw new Error('GridFSBucket 未初始化')
    }

    const objectId = new mongoose.Types.ObjectId(fileId)
    const files = await gridFSBucket.find({ _id: objectId }).toArray()
    if (!files || files.length === 0) {
      throw new Error('文件不存在')
    }

    const file = files[0]
    const downloadStream = gridFSBucket.openDownloadStream(objectId, downloadOptions)

    return {
      stream: downloadStream,
      filename: file.filename,
      mimeType: file.metadata?.mimeType || 'application/octet-stream',
      size: file.length,
    }
  }

  static async deleteFromGridFS(fileId) {
    const gridFSBucket = ensureGridFSBucket()
    if (!gridFSBucket) {
      throw new Error('GridFSBucket 未初始化')
    }

    const objectId = new mongoose.Types.ObjectId(fileId)
    await gridFSBucket.delete(objectId)
    return true
  }

  static async upload(fileBuffer, originalName, mimeType, storage = 'gridfs') {
    const maxSize = 2 * 1024 * 1024 * 1024
    if (fileBuffer.length > maxSize) {
      throw new Error('文件过大，最大允许 2GB')
    }

    const allowedMimes = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
      'application/pdf', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo',
      'application/octet-stream', 'application/x-dwg', 'application/acad', 'model/vnd.dwf',
    ]

    const designFileExts = ['dwg', 'max', 'fbx', 'obj', '3ds', 'dxf', 'skp', 'blend', 'ma', 'mb', 'c4d']
    const ext = originalName.split('.').pop()?.toLowerCase()
    const isDesignFile = designFileExts.includes(ext || '')

    if (!allowedMimes.includes(mimeType) && !isDesignFile) {
      throw new Error(`不支持的文件类型: ${mimeType}`)
    }

    return await this.uploadToGridFS(fileBuffer, originalName, mimeType)
  }

  static async getFile(fileId) {
    const downloadOptions = arguments.length >= 2 ? arguments[1] : undefined
    return await this.downloadFromGridFS(fileId, downloadOptions || {})
  }

  static async deleteFile(fileId) {
    return await this.deleteFromGridFS(fileId)
  }
}

module.exports = FileService
