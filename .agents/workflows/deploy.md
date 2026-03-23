---
description: 部署后端项目到生产服务器（通过 GitHub 自动部署）
---
// turbo-all

## 部署方式

项目使用 **GitHub Actions 自动部署**，push 到 `main` 分支即自动部署到服务器。

- **GitHub 仓库**: `Jiaye-apple/furniai-backend`（Public）
- **服务器**: `root@8.216.41.149`，项目路径 `/root/furniai/`
- **部署流程**: git push → GitHub Actions SSH → `git pull + pm2 restart`

## 部署步骤

1. 确保所有修改已 commit
```powershell
cd "e:\Windsurf\windsurf_program\furniai---professional-furniture-visualizer\temp\backend_main\furniai-main"
git add -A
git commit -m "feat/fix/chore: 描述"
```

2. 推送到 GitHub（自动触发部署）
```powershell
git push origin main
```

3. 等待 15 秒后检查部署结果
```powershell
$headers = @{ "Authorization" = "Bearer $env:GH_TOKEN"; "Accept" = "application/vnd.github+json" }
$resp = Invoke-RestMethod -Uri "https://api.github.com/repos/Jiaye-apple/furniai-backend/actions/runs?per_page=1" -Headers $headers
$run = $resp.workflow_runs[0]
echo "Status: $($run.status) | Conclusion: $($run.conclusion)"
```
> 注意：需要先设置环境变量 `$env:GH_TOKEN`（GitHub PAT），或直接打开 Actions 页面查看。

4. 如果部署失败，检查 Actions 日志
```
https://github.com/Jiaye-apple/furniai-backend/actions
```

5. 确认服务器状态
```powershell
ssh root@8.216.41.149 "pm2 list | grep furniai"
```

## 紧急手动部署（GitHub Actions 不可用时的备用方案）

```powershell
scp -r "e:\Windsurf\windsurf_program\furniai---professional-furniture-visualizer\temp\backend_main\furniai-main\src\*" root@8.216.41.149:/root/furniai/src/
ssh root@8.216.41.149 "pm2 restart furniai"
```

## 关键信息

| 项目 | 值 |
|------|-----|
| 本地项目路径 | `e:\Windsurf\windsurf_program\furniai---professional-furniture-visualizer\temp\backend_main\furniai-main` |
| GitHub 仓库 | `Jiaye-apple/furniai-backend` |
| 服务器地址 | `root@8.216.41.149` |
| 服务器项目路径 | `/root/furniai/` |
| SSH 密钥 | `~/.ssh/id_rsa` |
| PM2 进程名 | `furniai` |
| 端口 | `3002` |
