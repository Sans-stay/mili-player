# Mili 播放器

以**悬浮字幕**为核心的音乐播放器：歌词以透明、无边框、置顶的字幕浮在桌面上，
逐字点亮、跟随播放进度。视觉参考 Limbus Company 每章终战的背景歌词演出。

![效果预览](docs/preview.png)

<p align="center">
  <img src="docs/search.png" width="266" alt="搜索 QQ 音乐">
  <img src="docs/player-settings.png" width="266" alt="悬浮字幕样式面板">
</p>

## 功能

| | |
| --- | --- |
| **散落歌词**（默认） | 全屏随机落点、各自倾斜、逐字浮现、逐字微颤 |
| **底部字幕条** | 透明窄窗，上一行 / 当前行 / 下一行，可拖动 |
| **歌词色号** | 11 个内置主题色，可改名、可增删、可存新色 |
| **歌曲彩蛋** | 识别到特定曲目自动切主题色（Mili 曲子为主，也可配非 Mili） |
| **本地播放** | 打开或拖入音频文件，读 ID3 标签，自动去 QQ 音乐配歌词 |
| **在线播放** | 应用内登录 QQ 音乐，搜索后直接在线播放 |
| **逐字歌词** | LRC / 增强 LRC / QQ 音乐 QRC（自定义 3DES 解密） |
| 托盘 + 快捷键 | 托盘菜单控制播放；`Ctrl + Alt + L` 切换鼠标穿透 |

---

## 怎么打开

**方式一 · 双击启动脚本**（推荐）

| 文件 | 说明 |
| --- | --- |
| `启动 Mili 播放器（无窗口）.vbs` | 不弹控制台，日常用这个 |
| `启动 Mili 播放器.cmd` | 保留控制台，出问题时看日志 |

**方式二 · 打包版**

```bash
npm run package
```

产物在 `dist\Mili播放器-win32-x64\`，整个文件夹可独立运行，
设置与登录态写在该文件夹的 `data\` 下。

> ⚠️ 请双击同目录下的 `启动 Mili 播放器.vbs`，**不要直接双击 `Mili播放器.exe`**。

**方式三 · 命令行**

```bash
npm install
npm start          # 启动
npm run dev        # 带 DevTools
npm test           # 回归测试
```

<details>
<summary>为什么不能直接双击 exe / 为什么要加 <code>--no-sandbox</code></summary>

某些 Windows 环境里 Chromium 自己的沙箱起不来，启动会**瞬间崩溃**。
实测（`node scripts/probe-sandbox.js` 可复现）：崩溃发生在**主进程脚本执行之前** ——
连第一行 `console.log` 都没机会跑，所以应用内部无法自救，只能由命令行带上 `--no-sandbox`。

于是：

- **开发模式**：`scripts/start.js` 先按默认跑一次，8 秒内异常退出就自动加参数重试
- **打包版**：打包时自动在 exe 旁边放一个 `启动 Mili 播放器.vbs`，替你加上参数

环境修好了（换机器、关掉冲突的安全软件）的话，直接双击 `Mili播放器.exe` 即可恢复沙箱隔离。

</details>

---

## 界面与操作

**主窗口**：顶部是悬浮歌词开关 / 样式面板 / 最小化 / 退出；中部是封面、歌曲信息、
进度条、播放控制；下部是歌词列表，当前行逐字点亮，**点任意一行可跳转**。

| 快捷键 | 作用 |
| --- | --- |
| `空格` | 播放 / 暂停 |
| `←` `→` | 后退 / 前进 5 秒 |

点标题栏的文件夹按钮，或**把音频文件拖进窗口**即可播放。支持 mp3 / flac / m4a / aac / wav / ogg / opus。

### 散落歌词（默认）

每句在**屏幕内随机落点**、**各自倾斜**、**跟着歌声逐字浮现**，唱完停留一会儿再淡出。

- 悬浮窗铺满整个屏幕（透明 + 置顶），**强制鼠标穿透**且不可聚焦，不挡操作
- 落点按「倾斜后的外接矩形」计算并留边距，**整块文字永远不出屏**；新句子尽量不压已有的
- **倾角在「下限～上限」之间均匀随机**，正负方向也随机。改上下限时已有句子**原地平滑重落**，
  不会重掷角度或挪动落点
- **每个字都在微微颤抖**（周期 1.7–3.0 秒、相位随机），呈现游戏里那种不稳的手感
- **通篇不用白色**：正在唱的字也是主题色，只把外发光打得更烈
- 可调：倾角上下限、同屏句数、停留时长、字号随机、微颤开关

### 底部字幕条

一条透明窄窗，可拖动、位置会记住。

| 操作 | 说明 |
| --- | --- |
| 按住拖动 | 移动字幕 |
| 右键 | 打开主窗口 / 锁定 / 重置位置 / 隐藏 / 退出 |
| `Ctrl + Alt + L` | 全局快捷键，锁定或解锁鼠标穿透 |

### 搜索结果

| 点哪里 | 做什么 |
| --- | --- |
| 整行（封面歌名那块） | **只载入歌词**，不碰正在播的音频 |
| 右侧 ▶ 按钮 | **在线播放**（未登录时提示去登录） |

分开是刻意的：想给现有音频换一版歌词时，不该被迫开始播放。

---

## 色号与彩蛋

### 内置色号

| 色号 | 出处 | 色值 |
| --- | --- | --- |
| 斑驳紫 | Through Patches of Violet | `#a98bff` |
| 光明橙 | Hero | `#ffa24d` |
| 希望黄 | Fly, My Wings | `#fcfe8b` |
| 清流蓝 | TIAN TIAN | `#57c8ff` |
| 温暖红 | SAIKAI | `#ff6b6b` |
| 黯淡黑 | Gone Angels | `#303030` |
| 沧海蓝 | Compass | `#3224ff` |
| 涟漪粉 | What the Ripple Sees | `#f047ea` |
| 炼狱红 | In Hell We Live, Lament | `#b30000` |
| 清新绿 | 1000x1000 | `#4ede9f` |
| 燃烧红 | Iron Lotus | `#f00000` |

**跟随歌曲自动切色（彩蛋）**：开关打开后，识别到对应曲目就自动换成它的主题色。

内置规则默认**只在艺术家确实是 Mili 时才生效** —— 否则一首第五和弦的《Hero》
或者随便什么同名曲都会被染色。判定是按分隔符切开艺术家字段逐个比对，
所以 `Mili`、`Mili / KIHOW`、`Mili / 塞壬唱片-MSR` 都算，而 `Emilio` 不算。

想给**非 Mili** 的曲目配彩蛋，在规则里加 `miliOnly: false` 即可（内置和自定义规则都支持）。

### 面板上能做的

| 操作 | 说明 |
| --- | --- |
| 左键点色号胶囊 | 立即切换 |
| **双击已选中的胶囊** | **就地改名**（回车确认 / Esc 取消 / 失焦也算确认） |
| 右键点胶囊 | 删除该色号（内置的不能删，但可以改名） |
| 自定义颜色 | 用系统取色器任选，实时预览 |
| 存为色号 | 把当前颜色存成新胶囊，之后一键切换 |

改动存在 `data/settings.json`，重启后保持。

---

## 修改内置色号与彩蛋

### 先搞清楚三种改法的区别

| 你想干什么 | 改哪里 | 要重新打包? | 会进仓库? |
| --- | --- | --- | --- |
| 改名字 / 换颜色 / 删掉 | **软件面板** | 否 | ❌ 只存本机 |
| 加一个只有自己有的 | `data/color-theme.json` | 否 | ❌ 只存本机 |
| **加内置的（所有人都有）** | **改源码**（见下） | 是 | ✅ |

**一句话**：面板和 `data/color-theme.json` 只影响你这台机器；想让别人也有，必须改源码。

### 加一个自己的（不改源码）

编辑数据目录下的 `data/color-theme.json`（第一次运行自动生成，自带说明文字）：

```json
{
  "presets": [
    { "name": "海盐蓝", "color": "#7fd4ff", "song": "某首歌", "builtin": true }
  ],
  "rules": [
    { "label": "海阔天空", "preset": "海盐蓝", "match": "海阔天空|海闊天空" }
  ]
}
```

存盘后**重启播放器**生效。打包版改 `dist\Mili播放器-win32-x64\data\` 下的同名文件。

### 加内置的（改源码）

两个文件，靠**名字**互相咬合：

| 文件 | 管什么 |
| --- | --- |
| `src/main/color-presets.js` | **有哪些颜色** |
| `src/shared/theme-rules.js` | **听到哪首歌切到哪个颜色** |

#### 第 1 步 · 加色号

打开 `src/main/color-presets.js`，在 `COLOR_PRESETS` 数组**末尾**加一行：

```js
{ key: 'ironlotus', name: '铁莲金', song: 'Iron Lotus', color: '#ffd54a', builtin: true },
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `key` | 是 | 唯一标识，小写英文。**加完以后永远不要改** |
| `name` | 是 | 显示名，也是彩蛋规则要找的名字 |
| `color` | 是 | `#rrggbb` |
| `song` | 否 | 出处，只在悬停提示里显示，没有就写 `''` |
| `builtin` | 否 | `true` = 不允许右键删除（仍可双击改名） |

> `key` 为什么不能改：它是「这个色号就是那个色号」的凭据。用户双击改了名字之后，
> 系统靠 `key` 才能认出这还是原来那个内置色号，从而不会每次启动都重新塞一个原名的。
> **改了 `key`，老用户那边会多出一个重复色号。**

#### 第 2 步 · 加彩蛋

打开 `src/shared/theme-rules.js`，在 `RULES` 数组**末尾**加一条：

```js
{
  label: 'Iron Lotus',        // 曲名，触发时提示里显示
  preset: '铁莲金',            // 必须和上面色号的 name 完全一致
  color: '#ffd54a',           // 兜底用，preset 能查到就不需要
  match: /iron\s*lotus|铁血莲华/i,
},
```

**数组顺序就是优先级** —— 从头往后扫，第一条命中的胜出。所以特例要写在宽规则**上面**。

想给非 Mili 的曲子配，加一行 `miliOnly: false`：

```js
{ label: '某首歌', preset: '涟漪粉', color: '#f047ea', match: /某首歌/i, miliOnly: false },
```

#### 正则怎么写

`match` 是拿 **「标题 + 专辑」** 去匹配的（**不含艺术家**），大小写不敏感。

| 写法 | 含义 |
| --- | --- |
| `/compass/i` | 标题里含 compass 就行 |
| `/^compass$/i` | 必须整个标题就是 compass |
| `/fly,?\s*my\s*wings/i` | 逗号可选、空白任意，同时匹配 `Fly My Wings` 和 `Fly, My Wings` |
| `/gone\s*angels\|逝去的天使/i` | `\|` 是「或」 |
| `/(^\|[^a-z])hero([^a-z]\|$)/i` | 独立单词 hero，**不误伤 Heroic** |

两个最容易犯的错：

1. **忘了转义** —— `|` 是「或」，想匹配字面竖线要写 `\|`
2. **写太宽** —— `/hero/i` 会把 `Heroic`、`Heros` 全染上

QQ 音乐上带后缀的很多（`Gone Angels (Library Of Ruina)`、`In Hell We Live, Lament (feat. KIHOW)`），
所以「包含」式写法比 `^...$` 更保险。查真实标题：在软件里搜一下，或用 `npm run test:qq -- "曲名"`。

#### 第 3 步 · 验证并生效

```bash
npm run test:theme     # 校验规则指向的色号真实存在、规则能被自己的标题命中
npm start              # 开发模式看效果（改源码后必须重启）
npm run package        # 重新打包，打包版才会带上
git add . && git commit -m "新增 X 色号与 Y 彩蛋" && git push
```

`test:theme` 会替你抓出名字写错、正则写错这类问题，不用等运行起来才发现。

---

## 目录结构

### 哪些上传，哪些不上传

仓库里只放**源码**，下面这些东西被 `.gitignore` 排除：

| 目录 | 是什么 | 怎么重建 |
| --- | --- | --- |
| **`data/`** | **设置、自定义色号、QQ 音乐登录 Cookie** | 运行程序自动生成 |
| `node_modules/` | 依赖包（约 300 MB） | `npm install` |
| `.electron-cache/` | Electron 运行时压缩包（约 260 MB） | `npm run setup:electron` |
| `dist/` | 打包产物 | `npm run package` |
| `shots/` `testdata/` | 截图、测试音频 | `npm run shot` / `npm run testdata` |
| `.reference/` | 第三方 QRC 解密参考实现（GPL-3.0，仅对照） | `node scripts/fetch-qrc-reference.js` |

> `data/qqmusic-session.json` 是登录凭据。提交前用 `git ls-files | findstr /i "data session"` 扫一眼。

### 目录说明

```
mili播放器/
├── 启动 Mili 播放器.cmd / （无窗口）.vbs   # 双击入口
├── docs/                     # 截图 + 技术细节 + 上传指南
├── assets/                   # 封面、图标、托盘图标
├── scripts/                  # 开发与测试脚本（不是程序的一部分）
└── src/
    ├── main/                 # 主进程
    │   ├── main.js           #   窗口、状态中枢、托盘、快捷键、IPC
    │   ├── qqmusic.js        #   QQ 音乐客户端（搜索 / 歌词 / 播放地址）
    │   ├── qqmusic-session.js#   登录窗口 + 登录态存取
    │   ├── qrc.js / qrc-des.js   # QRC 解密（自定义 3DES，自动生成勿手改）
    │   ├── audio-proxy.js    #   mili-audio:// 代理，媒体请求头可控
    │   ├── audio-meta.js     #   ID3v2 标签解析 + 文件名推断
    │   ├── color-presets.js  #   ★ 内置色号
    │   └── defaults.js       #   默认设置
    ├── shared/               # 两个窗口共用的纯逻辑（无 Electron 依赖，可直接单测）
    │   ├── lyric-parser.js   #   歌词解析（LRC / 增强 LRC / QRC）
    │   ├── theme-rules.js    #   ★ 内置彩蛋规则
    │   └── color-util.js
    └── renderer/
        ├── player/           # 主窗口
        └── overlay/          # 悬浮歌词窗口
```

---

## 开发与测试

```bash
npm test             # 回归测试（真实拉起两个窗口）
npm run test:theme   # 彩蛋规则 + 规则到颜色的解析
npm run test:presets # 色号合并逻辑（纯 Node）
npm run test:qq      # QQ 音乐链路：搜索 -> 解密 QRC -> 解析时间轴
npm run test:qrc     # 校验 JS 版 3DES 与 Python 参考实现逐字节一致
npm run test:audio   # 本地播放全链路
npm run test:online  # 在线播放全链路（需先登录）
npm run test:login   # 登录窗口能打开
```

回归测试覆盖四个容易回退的点：主窗口隐藏后进度仍推进、改设置不重掷落点、
倾角区间真的随机、真换歌时字幕必须重建。其中「真换歌必须重建」和
「角度互不相同」是刻意加的反向用例 —— 修 A 很容易矫枉过正成 B。

详细的架构说明、QQ 音乐接口与解密细节、踩过的坑，都在
[`docs/技术细节.md`](docs/技术细节.md)。
上传到 GitHub 的步骤见 [`docs/如何上传到 GitHub.md`](docs/如何上传到%20GitHub.md)。
