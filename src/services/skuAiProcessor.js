/**
 * SkuAI — Task Processor
 * 从 skuAiController 中提取的任务处理逻辑，由 taskQueue 统一调度
 */
const SkuAiTask = require('../models/SkuAiTask')
const PlatformKey = require('../models/PlatformKey')
const jwtCounter = require('../utils/jwtCounter')
const geminiClient = require('./geminiClient')
const promptBuilder = require('./promptBuilder')
const imageProcessor = require('./imageProcessor')
const taskQueue = require('./taskQueue')

// taskType 前端 key → FurnIAI promptBuilder taskType 映射
const TASK_TYPE_MAP = {
  whiteBg: 'white-bg',
  effect: 'scene',
  dimension: 'dimensions',
  multiAngle: 'cad-views',
  crossSection: 'cross-section',
  sixViews: 'six-views',
  scaleDrawing: 'scale-drawing',
  video: null,
}

/**
 * 解析前端 taskType（支持 baseType:subType 格式）→ promptBuilder taskType
 * - whiteBg:{view} → multi-view:{view}（6 种视角）
 * - whiteBg:collage → multi-view:collage
 * - whiteBg:original-hd → white-bg（方案C走标准白底图流程）
 * - effect:{style} → scene（风格通过 options 传递）
 * - 不带子类型的基础类型映射到原有 TASK_TYPE_MAP
 * - 无法识别的基础类型返回 null
 */
function resolveTaskType(frontendKey) {
  const [base, sub] = frontendKey.split(':')
  const furniaiBase = TASK_TYPE_MAP[base]
  if (!furniaiBase) return null

  // 白底图子类型 → multi-view:subType 或特殊类型
  if (base === 'whiteBg' && sub) {
    if (sub === 'collage') return 'multi-view:collage'
    if (sub === 'original-hd') return 'white-bg'
    return `multi-view:${sub}`
  }
  // 效果图子类型 → scene（风格通过 options 传递）
  if (base === 'effect') {
    return 'scene'
  }
  return furniaiBase
}

const fileIdToBase64 = imageProcessor.fileIdToBase64
const saveBase64ToFile = (base64Data, prefix) => imageProcessor.saveBase64ToGridFS(base64Data, prefix)

/**
 * 异步处理单个 SkuAI 任务的所有子项
 * 由 taskQueue 调度调用
 */
async function processTask(taskId, controlFlow = { isTimeout: false }) {
  const task = await SkuAiTask.findById(taskId)
  if (!task || task.status === 'canceled') return

  // 防重复执行：如果任务已成功完成（可能被重调度），直接跳过，不覆盖状态
  if (task.status === 'succeeded') {
    console.log(`[SkuAI] 任务 ${taskId} 已成功完成，跳过重复执行`)
    return
  }

  // timeline 快捷写入
  const _tl = (phase, msg) => taskQueue.pushTimeline(taskId, 'skuai', phase, msg)
  const _fmtErr = (err) => taskQueue.formatError(err)

  try {
    const startedAt = new Date();
    const updatedAt = new Date();
    const updateData = {
      status: 'running',
      startedAt,
      updatedAt
    };

    // 预写入当前活跃通道和模型，使任务处理中阶段前端就能显示（API 返回后会覆盖为实际值）
    const configMgr = require('./configManager')
    const activeChannels = configMgr.get('channelPriority')?.filter(c => c.enabled) || []
    const primaryCh = activeChannels[0]
    if (primaryCh) {
      updateData['options.channel'] = primaryCh.name;
      updateData.modelUsed = primaryCh.imageModel || null;
      if (!task.options) task.options = {};
      task.options.channel = primaryCh.name;
      task.modelUsed = primaryCh.imageModel || null;
    }

    await SkuAiTask.updateOne({ _id: taskId }, { $set: updateData });
    task.status = 'running';
    task.startedAt = startedAt;
    task.updatedAt = updatedAt;

    _tl('task_start', `任务开始执行，通道=${primaryCh?.name || 'auto'}，模型=${primaryCh?.imageModel || '-'}，共 ${task.items.length} 个子项`)
    const taskStartTime = Date.now()

    // 加载关联的平台密钥（用于子任务完成后异步更新调用统计）
    let platformKey = null
    if (task.platformKeyId) {
      try {
        platformKey = await PlatformKey.findById(task.platformKeyId)
        _tl('platform_key', `平台密钥已加载: ${platformKey?.name || '-'}`)
      } catch (e) {
        _tl('platform_key', `平台密钥加载失败（不影响生图）: ${e.message}`)
        console.warn('[SkuAI] 加载平台密钥失败（不影响生图）:', e.message)
      }
    }

    // 读取第一张参考图的 base64（优先使用预处理缓存）
    let referenceBase64 = null
    if (task.referenceImages.length > 0) {
      _tl('ref_load_start', `开始加载参考图 ${String(task.referenceImages[0]).slice(0, 12)}...`)
      try {
        const refId = String(task.referenceImages[0])
        const cached = taskQueue.getPreprocessedImage(refId)
        if (cached) {
          referenceBase64 = imageProcessor.toDataUrl(cached)
          _tl('ref_load_done', `参考图加载完成（命中预处理缓存）`)
          console.log(`[SkuAI] Using preprocessed reference image: ${refId.slice(0, 12)}...`)
        } else {
          const refLoadStart = Date.now()
          referenceBase64 = await fileIdToBase64(task.referenceImages[0])
          _tl('ref_load_done', `参考图加载完成（从存储读取），耗时 ${Date.now() - refLoadStart}ms`)
        }
      } catch (err) {
        _tl('ref_load_fail', `参考图加载失败: ${_fmtErr(err)}`)
        console.error(`[SkuAI] 读取参考图失败: ${err.message}`)
        await SkuAiTask.updateOne({ _id: taskId }, {
          $set: {
            status: 'failed',
            error: '参考图读取失败: ' + (err.message || String(err)),
            completedAt: new Date(),
            updatedAt: new Date()
          }
        });
        return
      }
    }

    // 并行处理子项
    let completedCount = 0
    let failedCount = 0
    const totalItems = task.items.length

    for (const item of task.items) {
      if (item.status === 'completed' || item.status === 'skipped') {
        completedCount++
      }
    }

    const pendingItems = task.items.filter(
      item => item.status !== 'completed' && item.status !== 'skipped'
        && !item.resultFileId  // 已有图片结果的子项不重复处理
    )

    const processableItems = []
    for (const item of pendingItems) {
      if (item.taskType === 'video' || !resolveTaskType(item.taskType)) {
        item.status = 'skipped'
        item.error = '暂不支持此生成类型'
        item.completedAt = new Date()
        completedCount++
      } else {
        processableItems.push(item)
      }
    }

    if (processableItems.length > 0) {
      const itemPromises = processableItems.map(item => {
        const itemIndex = task.items.findIndex(i => i._id.toString() === item._id.toString())

        return (async () => {
          try {
            const analysis = null

            const furniaiType = resolveTaskType(item.taskType)
            const genOptions = {
              userContext: task.options.userContext || '',
              enableHD: task.options.enableHD || false,
            }

            // 解析子类型
            const [baseType, subType] = item.taskType.split(':')

            // 效果图：将风格传入 options
            if (baseType === 'effect' && subType) {
              genOptions.sceneStyle = subType
            }

            // 白底图方案B：将视角信息传入 options
            if (baseType === 'whiteBg' && subType && subType !== 'collage' && subType !== 'original-hd') {
              genOptions.angleName = subType
            }

            // 白底图方案A：拼图模式
            if (baseType === 'whiteBg' && subType === 'collage') {
              genOptions.collageMode = true
            }

            if (item.taskType === 'dimension' && task.options.userContext) {
              genOptions.userContext = `尺寸标注图。${task.options.userContext}`
            }

            const prompt = promptBuilder.buildVisualPrompt(furniaiType, analysis || {}, genOptions)
            _tl('prompt_built', `子项 [${item.taskType}] Prompt 已构建，长度=${prompt.length} 字符`)

            // 合并写入：status=processing + startedAt + prompt 一次性写入，减少一次 DB roundtrip
            // 同时使用位置操作符 items._id 匹配，确保 prompt 写入不受数组索引漂移影响
            const promptWriteResult = await SkuAiTask.findOneAndUpdate(
              { _id: taskId, 'items._id': item._id },
              {
                $set: {
                  'items.$.status': 'processing',
                  'items.$.startedAt': new Date(),
                  'items.$.prompt': prompt,
                  updatedAt: new Date(),
                }
              },
              { new: true }
            )
            // 校验 prompt 是否真正写入成功
            if (promptWriteResult) {
              const writtenItem = promptWriteResult.items?.find(i => i._id.toString() === item._id.toString())
              if (!writtenItem?.prompt) {
                console.error(`[SkuAI] ⚠️ Prompt 写入异常：findOneAndUpdate 返回的 item.prompt 为空！taskId=${taskId}, itemId=${item._id}`)
              } else {
                console.log(`[SkuAI] Prompt 已持久化: taskId=${taskId}, itemId=${item._id}, promptLen=${writtenItem.prompt.length}`)
              }
            } else {
              console.error(`[SkuAI] ⚠️ Prompt 写入失败：findOneAndUpdate 返回 null（未匹配到文档）！taskId=${taskId}, itemId=${item._id}`)
            }

            console.log(`[SkuAI] 生成图片: taskId=${taskId}, type=${item.taskType}, furniaiType=${furniaiType}`)
            _tl('api_call', `子项 [${item.taskType}] 正在调用 AI 生图 API...`)
            const startTime = Date.now()

            const pureRef = imageProcessor.extractPureBase64(referenceBase64)
            const result = await geminiClient.generateImage(prompt, pureRef, {
              enableHD: genOptions.enableHD,
            })

            // 熔断点1：API 返回后检查外层是否已宣布超时，避免覆盖 _markTaskFailed 的正确状态
            if (controlFlow.isTimeout) {
              console.warn(`[SkuAI] 任务 ${taskId} 子项 [${item.taskType}] 超时中断，跳过保存`)
              return
            }

            const elapsed = Date.now() - startTime
            const elapsedSec = (elapsed / 1000).toFixed(1)
            _tl('api_done', `子项 [${item.taskType}] API 响应返回，耗时 ${elapsed}ms，hasImage=${!!result.image}，通道=${result.channel || '-'}，模型=${result.model || '-'}`)
            console.log(`[SkuAI] ⏱️ 图片生成完成: type=${item.taskType}, 耗时=${elapsedSec}s (${elapsed}ms), hasImage=${!!result.image}, taskId=${taskId}`)

            if (result.image) {
              _tl('save_image', `子项 [${item.taskType}] 正在保存图片到存储...`)
              const dataUrl = imageProcessor.toDataUrl(result.image)
              const fileId = await saveBase64ToFile(dataUrl, `ai-${task.skuCode}-${item.taskType}`)
              _tl('save_done', `子项 [${item.taskType}] 图片已保存, fileId=${fileId}`)
              completedCount++

              // 使用位置操作符精确匹配子项，冗余写入 prompt 确保记录不丢失
              const updateData = {
                'items.$.resultFileId': fileId,
                'items.$.status': 'completed',
                'items.$.completedAt': new Date(),
                'items.$.prompt': prompt,  // 冗余写入 prompt，防止之前的写入被覆盖或丢失
                progress: Math.round(((completedCount + failedCount) / totalItems) * 100),
                updatedAt: new Date(),
              }
              // 始终写入通道和模型（不再依赖 falsy 检查，避免空字符串导致跳过写入）
              updateData['options.channel'] = result.channel || primaryCh?.name || 'unknown'
              updateData['modelUsed'] = result.model || primaryCh?.imageModel || 'unknown'

              const completedWriteResult = await SkuAiTask.findOneAndUpdate(
                { _id: taskId, 'items._id': item._id },
                { $set: updateData },
                { new: true }
              )
              // 校验关键字段写入
              if (completedWriteResult) {
                console.log(`[SkuAI] 完成状态已写入: channel=${completedWriteResult.options?.channel}, model=${completedWriteResult.modelUsed}, promptLen=${completedWriteResult.items?.find(i => i._id.toString() === item._id.toString())?.prompt?.length || 0}`)
              } else {
                console.error(`[SkuAI] ⚠️ 完成状态写入失败：findOneAndUpdate 返回 null！taskId=${taskId}, itemId=${item._id}`)
              }
              // 异步更新调用统计（成功），不阻塞生图流程
              if (platformKey) {
                platformKey.recordSuccess(promptBuilder.calculateCreditCost(furniaiType)).catch(e =>
                  console.error('[SkuAI] 平台统计更新失败:', e.message)
                )
              } else {
                jwtCounter.recordSuccess().catch(e => console.error('[SkuAI] JWT统计更新失败:', e.message))
              }
            } else {
              _tl('item_failed', `子项 [${item.taskType}] 失败: 生成结果无图片数据`)
              failedCount++
              await SkuAiTask.findOneAndUpdate(
                { _id: taskId, 'items._id': item._id },
                {
                  $set: {
                    'items.$.status': 'failed',
                    'items.$.error': '生成结果无图片数据',
                    'items.$.completedAt': new Date(),
                    'items.$.prompt': prompt,  // 失败时也保留 prompt 记录
                    progress: Math.round(((completedCount + failedCount) / totalItems) * 100),
                    updatedAt: new Date(),
                  }
                }
              )
              // 异步更新调用统计（失败），不阻塞生图流程
              if (platformKey) {
                platformKey.recordFailure().catch(e =>
                  console.error('[SkuAI] 平台统计更新失败:', e.message)
                )
              } else {
                jwtCounter.recordFailure().catch(e => console.error('[SkuAI] JWT统计更新失败:', e.message))
              }
            }
          } catch (err) {
            const errMsg = err.message || String(err) || '未知生成错误'
            _tl('item_failed', `子项 [${item.taskType}] 异常: ${_fmtErr(err)}`)
            console.error(`[SkuAI] 生成失败: taskId=${taskId}, type=${item.taskType}, error=${errMsg}`)

            // 🛡️ 防御性检查：超时中断后不覆盖已成功的子项状态
            if (controlFlow.isTimeout) {
              console.warn(`[SkuAI] 任务 ${taskId} 已超时，跳过子项 [${item.taskType}] 错误状态写入`)
              return
            }
            // 🛡️ 防御性检查：从 DB 读取最新子项状态，如果已被其他执行标记为 completed（有图片），不覆盖
            const freshTask = await SkuAiTask.findById(taskId, 'items').lean()
            const freshItem = freshTask?.items?.[itemIndex]
            if (freshItem?.status === 'completed' && freshItem?.resultFileId) {
              console.warn(`[SkuAI] 子项 [${item.taskType}] 在 DB 中已成功（fileId=${freshItem.resultFileId}），跳过覆盖`)
              completedCount++
              return
            }

            failedCount++
            await SkuAiTask.findOneAndUpdate(
              { _id: taskId, 'items._id': item._id },
              {
                $set: {
                  'items.$.status': 'failed',
                  'items.$.error': errMsg,
                  'items.$.completedAt': new Date(),
                  progress: Math.round(((completedCount + failedCount) / totalItems) * 100),
                  updatedAt: new Date(),
                }
              }
            )
            // 异步更新调用统计（异常失败），不阻塞生图流程
            if (platformKey) {
              platformKey.recordFailure().catch(e =>
                console.error('[SkuAI] 平台统计更新失败:', e.message)
              )
            } else {
              jwtCounter.recordFailure().catch(e => console.error('[SkuAI] JWT统计更新失败:', e.message))
            }
          }
        })()
      })

      await Promise.allSettled(itemPromises)
    } else {
      await SkuAiTask.updateOne({ _id: taskId }, {
        $set: {
          progress: Math.round(((completedCount + failedCount) / totalItems) * 100),
          updatedAt: new Date()
        }
      });
    }

    // 熔断点2：所有子任务完毕后，若外层已宣布超时，跳过最终状态更新，避免覆盖 _markTaskFailed 的正确状态
    if (controlFlow.isTimeout) {
      console.warn(`[SkuAI] 任务 ${taskId} 已超时，跳过最终状态更新（_markTaskFailed 已处理）`)
      return
    }

    // 🛡️ 防御性检查：从 DB 重新读取任务最新状态
    // 防止二次执行（因竞态产生的幽灵执行）覆盖已成功的任务状态
    const latestTask = await SkuAiTask.findById(taskId, 'status items').lean()
    if (latestTask?.status === 'succeeded') {
      console.warn(`[SkuAI] 任务 ${taskId} 在 DB 中已标记为 succeeded，跳过本次最终状态更新（可能是竞态重复执行）`)
      return
    }
    // 从 DB 重新统计实际完成数——不依赖内存变量（可能被竞态执行污染）
    const dbCompletedCount = latestTask?.items?.filter(i => i.status === 'completed' && i.resultFileId)?.length || 0
    const actualCompleted = Math.max(completedCount, dbCompletedCount)

    // ═══ Prompt 最终保障：并发写入可能导致 prompt 丢失，这里做最终兜底修复 ═══
    if (latestTask?.items) {
      const bulkPromptOps = []
      for (const dbItem of latestTask.items) {
        // 只修复已处理但 prompt 丢失的子项
        if ((dbItem.status === 'completed' || dbItem.status === 'failed') && !dbItem.prompt) {
          const ft = resolveTaskType(dbItem.taskType)
          if (!ft) continue
          const opts = { userContext: task.options?.userContext || '', enableHD: task.options?.enableHD || false }
          const [bt, st] = dbItem.taskType.split(':')
          if (bt === 'effect' && st) opts.sceneStyle = st
          if (bt === 'whiteBg' && st && st !== 'collage' && st !== 'original-hd') opts.angleName = st
          if (bt === 'whiteBg' && st === 'collage') opts.collageMode = true
          if (dbItem.taskType === 'dimension' && task.options?.userContext) opts.userContext = `尺寸标注图。${task.options.userContext}`
          try {
            const rebuilt = promptBuilder.buildVisualPrompt(ft, {}, opts)
            bulkPromptOps.push({
              updateOne: {
                filter: { _id: taskId, 'items._id': dbItem._id },
                update: { $set: { 'items.$.prompt': rebuilt } }
              }
            })
          } catch (e) { /* 构建失败则跳过 */ }
        }
      }
      if (bulkPromptOps.length > 0) {
        await SkuAiTask.bulkWrite(bulkPromptOps)
        console.log(`[SkuAI] Prompt 兜底修复: taskId=${taskId}, 修复 ${bulkPromptOps.length} 个子项`)
      }
    }

    const finalStatus = actualCompleted === 0 ? 'failed' : 'succeeded'
    const finalError = actualCompleted === 0 ? '所有子任务均失败' : undefined
    const finalUpdate = {
      $set: {
        progress: 100,
        completedAt: new Date(),
        updatedAt: new Date(),
        status: finalStatus,
      }
    }
    if (finalError) finalUpdate.$set.error = finalError

    await SkuAiTask.findByIdAndUpdate(taskId, finalUpdate)
    const totalElapsed = ((Date.now() - taskStartTime) / 1000).toFixed(1)
    _tl('task_completed', `任务完成: status=${finalStatus}, 成功=${actualCompleted}, 失败=${failedCount}, 总耗时=${totalElapsed}s`)
    console.log(`[SkuAI] ✅ 任务完成: taskId=${taskId}, status=${finalStatus}, completed=${actualCompleted}, failed=${failedCount}, 总耗时=${totalElapsed}s`)
  } catch (err) {
    const errMsg = err.message || String(err) || '任务处理异常'
    _tl('task_failed', `任务异常: ${_fmtErr(err)}`)
    console.error(`[SkuAI] 任务处理异常: taskId=${taskId}, error=${errMsg}`)
    await SkuAiTask.findByIdAndUpdate(taskId, {
      $set: {
        status: 'failed',
        error: errMsg,
        completedAt: new Date(),
        updatedAt: new Date(),
      }
    })
  }
}

// Register with taskQueue
taskQueue.registerHandler('skuai', processTask)

module.exports = { processTask, resolveTaskType }
