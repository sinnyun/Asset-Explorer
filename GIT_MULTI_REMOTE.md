# 多远程仓库操作指南

本文档说明本项目的双远程仓库配置，指导日常推送与切换拉取源。

---

## 远程仓库配置

| 别名 | 地址 | 说明 |
|------|------|------|
| `origin` | `https://cnb.cool/sinnyun/Asset-Explorer` | 默认主仓库（CodeNB） |
| `github` | `https://github.com/sinnyun/Asset-Explorer.git` | 镜像仓库（GitHub） |

> `origin` 为本项目默认推送与拉取目标。

---

## 日常推送（同步到两个仓库）

每次提交后，将 `main` 分支同时推送到两个远程：

```powershell
# 分别推送
git push origin main
git push github main

# 或一次性推送全部远程
git push --all
```

推荐将以下脚本保存为 `scripts/push-all.ps1`，方便一键推送：

```powershell
# push-all.ps1 — 一键推送到所有远程仓库
Write-Host "正在推送到所有远程仓库..." -ForegroundColor Cyan
git push origin main
git push github main
Write-Host "推送完成。" -ForegroundColor Green
```

使用方式：
```powershell
powershell -File scripts/push-all.ps1
```

---

## 日常拉取（默认从 origin/cnb 拉取）

默认从 CodeNB（`origin`）拉取最新代码：

```powershell
git pull origin main
```

---

## 切换拉取源到 GitHub

当需要从 GitHub 拉取时使用：

```powershell
# 从 GitHub 拉取
git pull github main

# 或者临时将 origin 指向 GitHub
git remote set-url origin https://github.com/sinnyun/Asset-Explorer.git
git pull origin main

# 恢复 origin 为 CodeNB
git remote set-url origin https://cnb.cool/sinnyun/Asset-Explorer
```

---

## 推荐 Git 别名（可选配置）

将以下内容加入 `~/.gitconfig` 可简化操作：

```ini
[alias]
    push-all = "!git push origin main && git push github main"
    pull-cnb = pull origin main
    pull-github = pull github main
    switch-origin-to-github = !git remote set-url origin https://github.com/sinnyun/Asset-Explorer.git
    switch-origin-to-cnb  = !git remote set-url origin https://cnb.cool/sinnyun/Asset-Explorer
```

配置别名后常用命令：

```powershell
git push-all          # 推送两个仓库
git pull-cnb          # 从 cnb 拉取（默认）
git pull-github       # 从 github 拉取
git switch-origin-to-github   # 临时切换 origin 到 GitHub
git switch-origin-to-cnb      # 恢复 origin 到 cnb
```

---

## 注意事项

- `origin` 始终指向 CodeNB，这是项目的默认仓库。
- GitHub 仓库仅作为镜像备份，不建议直接推送 GitHub 来代替 `origin`。
- 两个仓库应保持同步，建议每次推送前确认本地 `main` 分支状态干净：
  ```powershell
  git status
  git log --oneline -3
  ```



# 推送两个仓库
git push-all

# 默认拉取（从 cnb）
git pull-cnb

# 切换拉取源到 GitHub
git pull-github