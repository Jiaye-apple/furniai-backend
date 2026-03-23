/**
 * FurnIAI — API接口模型
 * 将已完成的任务提炼为可复用的 API 接口（内置提示词 + 参考图模板）
 * 外部用户通过 slug 调用接口，只需传入待处理图片即可
 */
const mongoose = require('mongoose')

const apiEndpointSchema = new mongoose.Schema({
    // 接口名称，如"沙发材质替换"
    name: { type: String, required: true, trim: true },
    // 接口标识符（URL路径），唯一索引，如 "sofa-material-change"
    slug: { type: String, required: true, unique: true, index: true, trim: true },
    // 接口描述
    description: { type: String, default: '' },
    // 启用/禁用
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },

    // ========== 从任务提炼的核心数据 ==========
    // 内置提示词（可编辑，支持 {{变量名}} 模板语法）
    prompt: { type: String, default: '' },
    // 参考图片列表（base64/GridFS ID/URL）
    referenceImages: [mongoose.Schema.Types.Mixed],

    // ========== Prompt 模板参数定义 ==========
    // 存储 prompt 中 {{变量名}} 对应的参数配置
    promptParams: [{
        key: { type: String, required: true },        // 模板变量名，如 "材质名"
        description: { type: String, default: '' },   // 参数说明
        defaultValue: { type: String, default: '' },  // 默认值（可选）
        required: { type: Boolean, default: false },  // 是否必填
    }],

    // ========== 调用配置 ==========
    // 指定通道ID（可选，空=auto）
    channelId: { type: String, default: 'auto' },
    // 指定模型（可选）
    model: { type: String, default: '' },

    // ========== 来源追溯 ==========
    // 来源任务ID（FurniaiTask 的 _id）
    sourceTaskId: { type: String, default: null },

    // ========== 统计 ==========
    stats: {
        totalCalls: { type: Number, default: 0 },
        successCalls: { type: Number, default: 0 },
        failedCalls: { type: Number, default: 0 },
        lastCallAt: { type: Date, default: null },
    },
}, {
    timestamps: true, // 自动 createdAt / updatedAt
})

/**
 * 根据名称自动生成 slug（中文转拼音太复杂，这里用时间戳+随机数）
 */
apiEndpointSchema.statics.generateSlug = function (name) {
    // 把名称中的特殊字符替换掉，保留英文字母和数字
    const base = name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
    const suffix = Date.now().toString(36).slice(-4)
    return (base || 'api') + '-' + suffix
}

/**
 * 渲染 prompt 模板：将 {{变量名}} 替换为传入的参数值或默认值
 * @param {Object} params - 调用方传入的参数键值对，如 { "材质名": "真皮", "部件": "扶手" }
 * @returns {string} 渲染后的 prompt 字符串
 */
apiEndpointSchema.methods.renderPrompt = function (params = {}) {
    let result = this.prompt || ''
    const paramDefs = this.promptParams || []

    // 将参数定义转为 key → defaultValue 映射
    const defaults = {}
    for (const p of paramDefs) {
        defaults[p.key] = p.defaultValue || ''
    }

    // 替换所有 {{变量名}}，优先使用传入值，其次使用默认值
    result = result.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, key) => {
        if (params[key] !== undefined && params[key] !== null) {
            return String(params[key])
        }
        if (defaults[key] !== undefined && defaults[key] !== '') {
            return defaults[key]
        }
        // 没有传值也没有默认值，保留原样（方便调试发现遗漏）
        return match
    })

    return result
}

/**
 * 自动生成对接文档（根据接口配置动态拼装）
 * @param {string} baseUrl - 服务基础URL，如 https://hzh.sealos.run
 * @returns {object} 对接文档对象
 */
apiEndpointSchema.methods.generateDoc = function (baseUrl = '') {
    const endpoint = this
    const callUrl = `${baseUrl}/proxy/v1/endpoints/${endpoint.slug}`

    // 参数说明
    const params = [
        { name: 'images', type: 'array<string>', required: true, description: '待处理图片列表（base64 格式，如 "data:image/png;base64,..."）' },
    ]
    // 如果没有内置 prompt，允许外部传入
    if (!endpoint.prompt) {
        params.push({ name: 'prompt', type: 'string', required: true, description: '提示词（该接口未内置提示词，需外部传入）' })
    } else {
        params.push({ name: 'prompt', type: 'string', required: false, description: '自定义提示词（可选，传入后会覆盖内置提示词）' })
    }

    // 如果有模板参数定义，将其加入对接文档的参数列表
    const promptParamDefs = endpoint.promptParams || []
    if (promptParamDefs.length > 0) {
        params.push({ name: 'params', type: 'object', required: false, description: '模板参数键值对，用于替换内置 Prompt 中的 {{变量名}} 占位符。详见下方「模板参数」列表' })
    }

    // curl 示例（如果有模板参数，示例中带上 params）
    const hasTemplateParams = promptParamDefs.length > 0
    const sampleParamsJson = hasTemplateParams
        ? `,\n    "params": {${promptParamDefs.slice(0, 3).map(p => `"${p.key}": "${p.defaultValue || '示例值'}"`).join(', ')}}`
        : ''
    const curlExample = `curl -X POST "${callUrl}" \\
  -H "Authorization: Bearer pk-你的密钥" \\
  -H "Content-Type: application/json" \\
  -d '{
    "images": ["data:image/png;base64,iVBORw0KGgo..."]${sampleParamsJson}
  }'`

    // Python 示例
    const pythonExample = `import requests
import base64

# 读取图片并转为 base64
with open("input.jpg", "rb") as f:
    img_b64 = "data:image/jpeg;base64," + base64.b64encode(f.read()).decode()

resp = requests.post(
    "${callUrl}",
    headers={
        "Authorization": "Bearer pk-你的密钥",
        "Content-Type": "application/json"
    },
    json={"images": [img_b64]${hasTemplateParams ? ', "params": {' + promptParamDefs.slice(0, 3).map(p => `"${p.key}": "${p.defaultValue || '示例值'}"`).join(', ') + '}' : ''}}
)
print(resp.json())`

    // Node.js 示例
    const nodeExample = `const fs = require('fs');

const imgBuffer = fs.readFileSync('input.jpg');
const imgB64 = 'data:image/jpeg;base64,' + imgBuffer.toString('base64');

const resp = await fetch("${callUrl}", {
    method: "POST",
    headers: {
        "Authorization": "Bearer pk-你的密钥",
        "Content-Type": "application/json"
    },
    body: JSON.stringify({ images: [imgB64]${hasTemplateParams ? ', params: {' + promptParamDefs.slice(0, 3).map(p => `"${p.key}": "${p.defaultValue || '示例值'}"`).join(', ') + '}' : ''} })
});
const result = await resp.json();
console.log(result);`

    // 响应格式说明
    const responseFormat = {
        success: true,
        data: {
            requestId: '任务ID',
            status: 'succeeded',
            results: [
                {
                    taskType: '任务类型',
                    status: 'completed',
                    resultBase64: 'data:image/png;base64,...（生成结果图片）',
                }
            ]
        }
    }

    return {
        name: endpoint.name,
        slug: endpoint.slug,
        description: endpoint.description || '暂无描述',
        status: endpoint.status,
        callUrl,
        method: 'POST',
        auth: {
            type: 'Bearer Token',
            header: 'Authorization: Bearer pk-你的密钥',
            description: '需要在管理面板「密钥管理」中创建平台密钥',
        },
        params,
        // 模板参数定义（供文档展示）
        promptParams: promptParamDefs.map(p => ({
            key: p.key,
            description: p.description || '',
            defaultValue: p.defaultValue || '',
            required: !!p.required,
        })),
        hasBuiltinPrompt: !!endpoint.prompt,
        builtinPromptPreview: endpoint.prompt ? (endpoint.prompt.length > 100 ? endpoint.prompt.slice(0, 100) + '...' : endpoint.prompt) : null,
        hasReferenceImages: endpoint.referenceImages && endpoint.referenceImages.length > 0,
        referenceImageCount: endpoint.referenceImages ? endpoint.referenceImages.length : 0,
        examples: {
            curl: curlExample,
            python: pythonExample,
            nodejs: nodeExample,
        },
        responseFormat,
        stats: endpoint.stats,
    }
}

module.exports = mongoose.model('ApiEndpoint', apiEndpointSchema)
