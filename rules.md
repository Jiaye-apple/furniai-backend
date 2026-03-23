## 沟通与协作
- 使用中文回答
- 非必要不使用花里胡哨的Markdown回复我，清楚、明了才是关键
- 任务汇报与总结应在聊天中完成，而非创建文件。严禁在未经用户明确要求的情况下，创建任何 .md 文件来报告、总结或记录任务过程。这种行为会制造不必要的“垃圾文件”，污染项目。
- 任务完成后不要写总结文档、不要写说明文档md，除非用户主动、明确要求
- 写入plan的时候请始终使用中文
- 和你交流协作的人类是一位软件开发工程师
- 面对复杂问题，请主动将其拆解为“可解决”和“待讨论/较难解决”的部分，以聚焦优化方向
- 尽可能以最小的代码修改原则实现开发需求，不允许推倒之前的项目或代码文件重构，只允许在源代码之上寻找最优解决方案，如有必要重构项目代码，需要询问

## 代码规范与注释
- 总是使用中文清楚但简洁地注释代码
- 所有代码应该使用中文尽可能清楚地注释，方便人类review相关流程/逻辑
- 每次对代码文件进行修改后，都应该主动检查修改后代码是否有错误（验证完整性和语法错误）
- 删除逻辑时，应该把相关的逻辑删除干净，减少项目的复杂度。有需要保留的内容时，用户会特别说明。
PowerShell 对 && 语法有问题，直接使用分号;去分隔就好

## 工具与操作
- 使用你觉得最擅长、准确的方式/工具来执行增/删/改代码
- 为了节省token消耗和耗时，单次阅读文件时至少阅读200行以上，如果要阅读多个代码文件应该优先并行阅读而不是一个一个阅读
- 写入To-dos的时候请使用中文
## 临时文件与迁移操作规范
- 迁移、测试、临时脚本等文件必须放在单独的文件夹（如 `temp/`、`migration/`），禁止在主项目根目录创建
- 任务完成后主动清理临时文件，保持项目目录整洁
- SSH 远程执行复杂命令时，应先将命令写入 .sh 脚本文件，上传后再执行，避免引号转义问题
## 命令执行规则 (强制！)

**必须使用 MCP 工具 `mcp_shell_run_shell` 执行所有 shell 命令！**

```
mcp_shell_run_shell(command="要执行的命令", cwd="工作目录", shell="powershell")
```

**重要约束：**
- 使用 `curl.exe` 而不是 `curl`（避免 PowerShell alias 导致输出截断）
- 复杂多行脚本应先写入文件（.ps1 或 .py）再执行，避免引号嵌套问题
- PowerShell 对 && 语法有问题，使用分号 ; 分隔命令

## ⛔ 部署与版本控制安全规则 (CRITICAL! ZERO TOLERANCE!)
- **绝对禁止未经用户明确同意就上传任何文件到服务器或执行任何部署操作！这是最高优先级的红线规则！**
- **禁止的操作包括但不限于：SCP 上传、SSH 执行脚本、pm2 restart、git push 到远程**
- 即使用户说了“部署”两个字，也需要先列出具体要部署哪些文件和改动内容，获得用户确认后再执行
- 只有在得到用户的**明确同意/直接指令**（如“部署吧”、“可以上传”、“发布”）之后，才可以执行
- 违反此规则将被视为**严重的重大失误**
- **每次执行部署前，必须先在相关的文件中迭代/增加版本号**（例如从 V2.0.1 升至 V2.0.2），并将对应的版本修改情况与用户进行说明。

## 📌 项目关键路径速查（固定信息，无需重新搜索）

**版本号位置：** 每次发版部署时，**必须同时更新以下两处**的版本号信息，以保持前后端显示一致！
1. `src/routes/health.js`（后端的健康检查接口返回的版本，如 `version: 'x.x.x'`）
2. `src/public/admin.html`（前端管理界面的左下角静态文本，搜索当前版本号如 `Vx.x.x`）

- 当前版本：**V3.4.5**

**服务端口：3002**（不是3000！健康检查地址 `http://localhost:3002/health`）

**SSH连接（当前生产服务器）：** `scp <本地文件> root@8.216.41.149:/root/furniai/<对应路径>`
- 服务器地址：`root@8.216.41.149`
- 服务器项目路径：`/root/furniai/`
- 部署方式：SCP 上传文件 + SSH 执行 `pm2 restart furniai`

**部署流程：**
1. 修改 `src/routes/health.js` **和** `src/public/admin.html` 中的版本号
2. 用 SCP 上传修改的文件到服务器 `/tmp/`
3. 更新 `temp/deploy.sh`（修改头部注释版本并在代码中添加本次变动的文件）并上传
4. SSH 执行 `bash /tmp/deploy.sh`（自动复制文件并 pm2 restart）
5. 验证：`curl -s http://localhost:3002/health`（端口 3002！）

## 🔌 协议架构（通道管理支持的协议格式）

- `openai`：标准 OpenAI Chat Completions（`/v1/chat/completions`），现有中转平台使用；有 imageConfig 时走 Native REST（`/v1beta/models/...`）
- `anthropic`：Anthropic Messages API（`/v1/messages`），G3Pro 代理使用
- `google`：Google Gemini 原生 REST（`/v1beta/models/...:generateContent`），Google 官方使用
- `openrouter`：OpenRouter API（`/v1/chat/completions` + `modalities: ["image","text"]` + `image_config`），图片在 `message.images[]` 中返回

## ⚠️ 前端自定义组件注意事项

- `admin.html` 中所有 `<select>` 被 `initCustomSelects()` 包装为自定义下拉组件
- 通过 JS 设置 `select.value` 后，**必须调用 `refreshCustomSelect(sel)` 同步 UI 显示**，否则用户看到的文本不会更新
- 涉及的典型场景：编辑弹窗回填数据时（如 `showEditChannelDialog`）