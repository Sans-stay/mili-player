# 把 Mili 播放器上传到 GitHub

本地这边**已经准备好了**（仓库已初始化、第一次提交已完成），
所以只剩「建远程仓库 + 推上去」这一步。

---

## 第 0 步：确认没有敏感文件

**这一步最重要，别跳。** 你的 `data/qqmusic-session.json` 里是 QQ 音乐的登录 Cookie，
传上去等于把账号交出去。`.gitignore` 已经把 `data/` 整个排除掉了，可以这样确认：

```bash
git check-ignore -v data/qqmusic-session.json
```

看到输出了 `.gitignore:16:data/` 就说明被忽略了。再看一眼将要提交的清单：

```bash
git add --dry-run .
```

**清单里不该出现 `data/`、`node_modules/`、`dist/`、`.electron-cache/`。**
（正常应该是 59 个文件左右，全在 `src/`、`scripts/`、`assets/`、`docs/` 里。）

---

## 第 1 步：在 GitHub 上建一个空仓库

1. 打开 https://github.com/new
2. **Repository name** 填 `mili-player`（或你喜欢的名字）
3. **Description** 可填：`以悬浮字幕为核心的音乐播放器`
4. 选 **Public**（公开）或 **Private**（私有）都行
5. **下面三个勾全部不要打**：
   - ❌ Add a README file
   - ❌ Add .gitignore
   - ❌ Choose a license

   因为本地已经有 README 和 .gitignore 了，勾了会产生冲突，第一次推送就得先合并，很麻烦。
6. 点 **Create repository**

创建完会跳到一个「Quick setup」页面，上面有一串 `git remote add origin ...` 命令 —— 下面要用到。

---

## 第 2 步：把本地仓库和远程关联

在项目目录里执行（**把 `<你的用户名>` 换成你的 GitHub 用户名**）：

```bash
cd "D:\Cats\新编程应用\work\mili播放器"

git remote add origin https://github.com/<你的用户名>/mili-player.git
git branch -M main
```

- `git remote add origin ...` 只是记下「远程仓库在哪」，不涉及网络
- `git branch -M main` 把分支名统一成 `main`（GitHub 的默认叫法）

检查一下有没有配错：

```bash
git remote -v
```

---

## 第 3 步：推送

```bash
git push -u origin main
```

第一次会**弹出登录窗口**（Windows 版的 Git 自带 Git Credential Manager）：

1. 选 **Sign in with your browser**（用浏览器登录）
2. 浏览器里点 Authorize 授权
3. 回到命令行，推送自动继续

> **重要**：GitHub 从 2021 年起就不支持用账号密码推送了。
> 如果弹出的窗口让你输密码，输账号密码一定失败 ——
> 要么用上面的浏览器登录，要么去
> https://github.com/settings/tokens 生成一个 **Personal Access Token**（勾 `repo` 权限），
> 在弹出的窗口里把 **token 当密码**填进去。

推送成功后刷新仓库页面，就能看到代码和 README 里的截图了。

---

## 以后每次改完代码

```bash
git add .
git commit -m "改了什么的简短说明"
git push
```

就这么三步。`git push` 之后不用再加 `-u origin main`（第一次已经记下来了）。

看当前状态随时用：

```bash
git status          # 哪些文件被改过、没提交
git log --oneline   # 提交历史
```

---

## 常见问题

### 推送卡住 / 超时

国内直连 GitHub 经常不稳。如果你有代理，可以让 git 走代理：

```bash
git config --global http.proxy http://127.0.0.1:7890
git config --global https.proxy http://127.0.0.1:7890
```

（端口按你自己代理软件的来。）取消代理：

```bash
git config --global --unset http.proxy
git config --global --unset https.proxy
```

实在不行，也可以传到国内的 **Gitee**（码云），流程几乎一样。

### 提示 `remote origin already exists`

说明之前加过了。先删再加：

```bash
git remote remove origin
git remote add origin https://github.com/<你的用户名>/mili-player.git
```

### 不小心把 data/ 提交上去了

```bash
git rm -r --cached data
git commit -m "移除误提交的个人数据"
git push
```

**但要注意**：如果 Cookie 已经推上去过，**它已经泄露了**，光删掉不够 ——
git 历史里还留着。稳妥做法是：
1. 去 QQ 音乐退出登录，让那个 Cookie 失效
2. 重新登录 QQ 音乐（应用里点「登录」）
3. 按上面命令把 `data/` 从索引里移除并推送

想彻底清掉历史记录要用 `git filter-repo`，比较麻烦；对个人项目来说，
**让 Cookie 失效**是最直接有效的做法。

### 想让仓库带上截图

截图在 `docs/` 目录里，是直接从 `shots/` 复制过去的。
`shots/` 本身被忽略了（它是每次跑 `npm run shot` 都会重新生成的），
所以 README 里引用的是 `docs/` 下那份稳定副本。

改了截图后同步过去：

```bash
npm run shot
copy shots\preview.png docs\preview.png
```

---

## 这个仓库里都有什么

| 目录 / 文件 | 上传 | 说明 |
| --- | --- | --- |
| `src/` | ✅ | 程序全部代码（主进程 / 两个窗口 / 共用逻辑） |
| `scripts/` | ✅ | 开发与测试脚本，不是程序的一部分 |
| `assets/` | ✅ | 封面与图标，程序运行要用 |
| `docs/` | ✅ | README 里引用的截图 |
| `package.json` `package-lock.json` | ✅ | 依赖清单 |
| `README.md` `.gitignore` `.npmrc` | ✅ | 说明与配置 |
| `启动 Mili 播放器.cmd` `.vbs` | ✅ | 双击启动入口 |
| `node_modules/` | ❌ | `npm install` 能装回来，几百 MB |
| `.npm-cache/` `.electron-cache/` | ❌ | 下载缓存，几百 MB |
| `dist/` | ❌ | 打包出来的 exe，`npm run package` 能重建 |
| `shots/` `testdata/` | ❌ | 截图与测试音频，脚本能重建 |
| `.reference/` | ❌ | 第三方的 QRC 解密参考实现（GPL-3.0），只用于对照 |
| **`data/`** | ❌ | **个人数据，含登录 Cookie，绝对不能传** |
