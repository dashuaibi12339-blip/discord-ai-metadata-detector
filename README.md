# Discord AI 元数据检测器

在 **Discord 网页版**里检测图片附件是否带 AI 绘图元数据，并直接读出提示词、参数与来源 —— 不用再一张张保存到本地去看。

Chrome / Edge 扩展（Manifest V3），全部解析在本地完成，不依赖任何第三方解析库。

> English: A Chrome/Edge (MV3) extension that shows the AI-drawing metadata (prompt, parameters, source) of Discord image attachments inline, without downloading every image first. All parsing happens locally.

---

## 功能

- **图片徽章**：图片左上角直接标注有没有提示词、是 NovelAI 还是本地工具（ComfyUI / A1111 / Forge / Fooocus / SwarmUI / InvokeAI）。
- **就地查看**：点徽章即在图片旁边弹出完整的正向 / 负面提示词、参数与来源。
- **面板汇总**：分类标签、缩略图、关键词筛选、悬停高亮定位、一键复制、下载原图、导出 CSV / JSON。
- **省流量**：默认只读每个文件开头 128 KB，只有确认后面还有元数据才继续读。
- **alpha 通道隐写**：可检测 NovelAI 写在像素最低位的提示词（默认关闭，先做低成本预检，命中才下载整份）。
- **可选「识别中」徽章**：区分「这张图没有元数据」与「这张图还在识别中」，避免多余的等待。
- **停止识别总开关**：一键暂停，立即移除徽章、清空队列，并拒绝一切抓取请求。

## 安装

**方式一（推荐）**：到 [Releases](https://github.com/dashuaibi12339-blip/discord-ai-metadata-detector/releases) 下载最新的 zip 并解压，然后执行下面第 2–4 步。

**方式二**：git clone 本仓库，或用页面右上角 Code → Download ZIP 下载源码，然后执行下面第 2–4 步。

1. 打开 Chrome，地址栏输入 chrome://extensions/（Edge 为 edge://extensions/）。
2. 打开右上角 **开发者模式**。
3. 点 **加载已解压的扩展程序**，选择含 manifest.json 的那一层目录。
4. 打开 discord.com 的任意频道页：右下角出现圆形悬浮球，图片左上角开始出现徽章。

## 界面与使用

### 图片徽章

| 徽章 | 含义 |
| --- | --- |
| 绿底 **NAI** | NovelAI（含 V4 / V4.5 的 caption 结构与 alpha 通道隐写） |
| 蓝底 **CF** | 本地 AI 工具：ComfyUI / A1111(Forge) / Fooocus / SwarmUI / InvokeAI，悬停可看具体是哪个 |
| 红底 **!** | 抓取失败（附件失效、网络错误），保留它是为了说明「这张图为什么一直没结果」 |
| 灰底 **…** | **识别中**（可选项）：请求已发出、还没拿到结果。用来区分「没有元数据」和「还在检测」 |
| 无徽章 | 没有 AI 提示词（无元数据 / 只有普通 EXIF / 被 Discord 剥离）。设置里可改成显示全部状态 |

**点一下徽章**即在图片旁边弹出：完整正向 / 负面提示词、参数、来源，以及「复制正向 / 复制负面 / 复制正+负 / 下载原图 / 打开链接 / 重新检测 / 隐写检测 / 在面板中查看」。

复制按钮**默认只复制正向提示词**，不会把 Steps / Sampler / CFG 之类的参数混进去；需要负面提示词请用「复制负面」。

### 面板

点悬浮球展开。面板里每一条带分类色块（**NAI** / **本地** / **无** / **失败**）与实时计数，顶部可切换标签、按关键词筛选。

- **缩略图**：使用页面已经加载过的图片地址，直接命中浏览器缓存，不额外消耗流量。
- **悬停高亮**：鼠标划过某一行，频道里对应的图片会被蓝色外框标出；点缩略图或「定位」会滚动到那张图。
- **展开**：显示完整正向提示词、负面提示词、参数与备注，可滚动、可选中复制。
- **扫描已加载的图**：把当前页面上已加载的图片加入检测队列。Discord 是虚拟滚动，页面上只保留视口附近的消息，所以这个按钮扫不到频道历史；往下滚动时 Discord 会加载更多消息，扩展会自动补测。已检测过的直接命中缓存，不会重新下载。
- **关键词筛选**：模糊匹配，输入 blue archive 也能命中 blue_archive；大小写不敏感，多个词需要全部命中。
- **导出**：CSV / JSON（时间、文件名、来源、工具、参数、提示词、链接）。
- **暗淡没有提示词的图**：所有没有 AI 提示词的图片变暗，一眼看出哪些能复刻。

### 悬浮球与开关

- **悬浮球**：按住可拖到任意位置（位置会记住），双击回到默认位置，右键或悬停出现的 × 可隐藏；隐藏后检测照常工作，可从弹窗的「打开检测面板」进入。
- **弹窗**：本页统计 + 快捷开关（启用检测 / 浏览时自动检测 / 显示徽章 / 显示「识别中」徽章 / 隐藏悬浮球 / 暗淡无提示词的图）。
- **设置页**：抓取参数（首段大小、并发、请求间隔、**扫描 / 重扫防抖**、每页流量预算）、缓存上限、隐写检测模式、直链检测工具、导出。

### alpha 通道隐写检测

NovelAI 会把提示词额外写进 PNG 的 **alpha 通道最低位**（stealth_pngcomp / stealth_pnginfo）。有些图经过重新封装后连 Comment 文字块都没有，提示词只剩这份数据。

| 模式 | 何时自动检测 | 代价 |
| --- | --- | --- |
| **off（默认）** | 从不。只在点图上的「隐写检测」、右键菜单或面板的「隐写检测可见图」时执行 | 0 |
| **auto** | 只对首段扫完完全没有文字元数据的 PNG；已经有 tEXt 的图不碰 | 没有 alpha 通道 → 0 额外字节；有 alpha 但没隐写 → 预检即停；命中才下载整份 |
| **always** | 每张 PNG 都预检 | 同上，覆盖面最大 |

预检原理：隐写的 magic 与长度字段按逐栏排布，只落在第 0 列，因此解出**前 152 行**就足以判断有没有；确认命中才下载整份去还原提示词。解码是纯 JS 实现（只解 alpha、不碰 RGB，也不需要 canvas）。

## 支持的元数据格式

- **PNG / APNG**：tEXt、zTXt、iTXt（含 UTF-8 中文）、eXIf。
- **WebP**：RIFF 容器中的 EXIF、XMP chunk。
- **JPEG**：APP1 EXIF（IFD0 + Exif SubIFD）、APP1 XMP、COM 注释；UserComment / XPComment 的 ASCII 与 UNICODE 两种编码。
- **提示词抽取**：
  - A1111 / Forge / Fooocus / SwarmUI：按 Prompt / Negative prompt / Steps 等分段切出参数与提示词。
  - ComfyUI：解析 prompt（API 格式）节点图，从采样器沿 positive / negative 链接回溯到文本节点，附带 steps / cfg / sampler / scheduler / seed / denoise / 模型 / LoRA；没有 prompt 时回退到 workflow（UI 格式）。
  - NovelAI：Comment / Description JSON；支持 V4 / V4.5 的 caption 结构（取 caption.base_caption，并把 char_captions 逐条列出）。
  - InvokeAI：sd-metadata / invokeai_metadata / invokeai_graph（含新旧结构）。
  - 其他结构化 JSON 与纯文本兜底。
- **隐写**：stealth_pngcomp（gzip 压缩的 JSON）与 stealth_pnginfo（原文 JSON），逐栏与逐列两种排布都会尝试。

## 来源判定

| 来源 | 判定要点 |
| --- | --- |
| **novelai** | 文字块 Software 含 NovelAI；Source 含 NovelAI / novelai.net；Comment 是含 prompt + steps 的 JSON；EXIF Comment / UserComment 是同类 JSON；或 alpha 通道隐写 |
| **comfyui**（含本地工具） | 文字块含 prompt / workflow / generation_data / ComfyScript；parameters 含 Steps: 或 sui_image_params；sd-metadata / invokeai_metadata / invokeai_graph；WebP 的 EXIF Make / Model / ImageDescription 以 prompt:{ 或 workflow:{ 开头；UserComment 含 class_type |
| **none** | 以上都不满足 |

注意：**不能**把 Generation time 当作 ComfyUI 特征 —— NovelAI V4.5 之后也有这个键，会误判。

## 抓取策略与流量

1. **首段 128 KB**（Range 请求）—— AI 元数据几乎都写在 PNG 的 IHDR 之后、JPEG 的 APP1 里。
2. **精准补抓**：如果首段正好切在某个元数据块中间，解析器会报出该块的精确结束位置，只补抓到那里。典型场景：一张 2.6 MB、文字块有 500 KB 的图，只读约 500 KB，不下载像素数据。
3. **小文件直下**：≤ 256 KB 的文件整份读取，省一次往返。
4. **不碰像素**：首段若停在图像数据块内部，说明后面都是像素，不再继续。
5. **可选尾段扫描**（默认关闭）：能读到少数工具写在图像数据之后的文字块，每张多约 128 KB。
6. **每页流量预算**（默认 30 MB）：达到后自动停止自动检测并提示。
7. **防抖可调**：图片进入视野后默认等 250 ms 再开始检测（把快速滚动产生的多个请求并成一批），页面变动后默认等 500 ms 再重新扫描。设置页可把这两个值调小，**0 = 立即检测**，代价是滚动时请求更零碎、页面频繁变动时 CPU 占用更高（默认值适用于大多数情况）。

抓的始终是 **CDN 原图**：扩展会把媒体代理地址（media.discordapp.net）替换为 cdn.discordapp.com，并只去掉会导致重新编码的缩放参数（width / height / quality / format），签名参数 ex / is / hm 原样保留；CDN 失败会自动退回代理地址。页面上的 <img> 可能已被转成 WebP 并丢掉元数据，直接读它拿不到原始信息。

限流：默认并发 3、请求间隔 120 ms，遇到 429 会退避；自动检测只针对进入视野的图片（每页默认上限 60 张）。

## 隐私与权限

- **权限**：storage / unlimitedStorage / contextMenus / downloads；主机权限为 cdn.discordapp.com 与 media.discordapp.net，内容脚本注入 discord.com / ptb / canary。
- **不读取账号信息**：不读取 Cookie、不读取登录令牌、不调用 Discord API、不向任何第三方服务器发送数据。
- **数据流向**：只对图片地址发起匿名 GET 请求读取字节，解析全部在本地完成；结果缓存在浏览器本地的 chrome.storage.local，可在设置页或弹窗随时清空。
- **网络节流**：按照上面的并发与间隔发请求，并受每页流量预算约束；也可以随时用「停止识别」完全停掉。

## 常见问题

**为什么有些图有提示词，扩展却显示没有元数据？**
两种常见原因：一是该图片被 Discord 重新编码或重封装，文字块被去掉了（PNG 尤其常见）；二是它的提示词只存在于 alpha 通道隐写里，用单张「隐写检测」可以验证。扩展已经会改抓 CDN 原图并去掉缩放参数，能拿到的才是真的能拿到。

**为什么「扫描已加载的图」只能扫到十几张？**
Discord 使用虚拟滚动，页面上只保留视口附近的消息。往下滚动会自动补测，不建议反复点这个按钮。

**提示词显示到一半就断了？**
有三种已知上限，都与抓取阶段无关（抓取是按块声明长度精准补抓的）：
- 单个文字块超过 **256 KB** 的部分会被截断；
- 完全无法结构化识别时，会退化为「最长的文字值当作提示词」，上限 **4000 字符**；
- JPEG 的单个 APP1 段本身容量有限（约 64 KB），写入方超长时可能在保存时就已截断，无法恢复。

**会不会因为自动抓取被 Discord 限流？**
扩展只读取公开的 CDN 图片资源，不登录、不调用 API，并按并发 3 / 间隔 120 ms 节流、每页有流量预算、遇 429 退避。任何自动化访问都受 Discord 服务条款约束，建议保持默认节流设置。

## 开发与测试

解析库是纯 ESM、不依赖 chrome API，可以直接在 Node 里跑（Node 18+，使用 Web 标准的 DecompressionStream）。

    npm test                                # 依次跑下面 5 个测试

    node test/run-tests.mjs                 # 71 项解析回归（A1111 / NovelAI / ComfyUI / InvokeAI / WebP / JPEG / 相机 EXIF / 截断 / IDAT 之后再写 tEXt / alpha 隐写 / 隐写低成本预检）
    node test/badge-test.mjs                # 36 项 DOM 回归（徽章唯一性、面板滚动保持、悬浮球拖动归位隐藏、识别中徽章、扫描防抖可调），用最小 DOM 与 chrome 桩真实加载 content.js
    node test/sw-harness.mjs "<图片直链>"    # 50 项 Service Worker 端到端（本机 HTTP 夹具；含分阶段抓取、隐写预检、停止识别总开关）
    node test/consistency-test.mjs          # 35 项一致性（内容脚本里重复实现的 URL 正规化 / 关键词匹配必须与 lib 完全一致）
    node test/check-manifest.mjs            # manifest 引用、HTML id 引用、Service Worker 相容性静态检查
    node test/stealth-url.mjs "<图片直链或本地文件>"   # 命令行单独验证某张图的 alpha 隐写
    node test/live-test.mjs "<Discord 原图直链>"       # 真实链接端到端
    python tools/make_icons.py              # 重新生成 icons/（需要 Pillow）

测试夹具由脚本按规范生成（PNG chunk + CRC、TIFF IFD0 / Exif SubIFD、RIFF、JPEG APP1），覆盖真实工具写出的元数据布局；Service Worker 相容性检查会阻止在 background / lib 里出现动态 import 或页面 API（这两个在 MV3 里不可用，且 Node 测试发现不了）。

## 项目结构

    manifest.json                 扩展清单（MV3）
    background/service_worker.js  抓取、解析、缓存、限流、右键菜单、导出
    content/content.js            徽章、悬浮面板、可见范围自动扫描
    content/content.css           全部使用 dmd- 前缀，降低与 Discord 样式的冲突
    popup/                        工具栏弹窗：本页统计与快捷开关
    options/                      设置页：抓取参数、缓存、直链检测、导出
    lib/metadata.js               统一入口：字节 -> 规范化元数据模型
    lib/png.js  lib/png-alpha.js  lib/webp.js  lib/jpeg.js  lib/exif.js  lib/xmp.js  lib/zlib.js
    lib/a1111.js  lib/novelai.js  lib/comfyui.js  lib/invokeai.js
    lib/classify.js               来源判定
    lib/analyze.js                来源与提示词抽取的编排
    lib/filter.js                 关键词模糊匹配
    lib/stealth.js                alpha 通道隐写解码（纯函数部分）
    lib/discord-url.js            附件 URL 正规化与原图候选
    test/                         回归测试与夹具生成
    tools/make_icons.py           图标生成

## 已知限制

- 只支持 **Discord 网页版**（discord.com / ptb / canary）；桌面客户端与手机 App 无法注入扩展。
- AVIF / HEIC 容器暂不解析；视频附件不做检测。
- ComfyUI 节点种类极多，只覆盖常见路径（KSampler 家族 + CLIPTextEncode 回溯），非常规自定义节点可能只给出提示词而缺少部分参数。
- 图片处于 spoiler 折叠或尚未加载时读不到，点开后会自动补测。
- 单个文字块超过 256 KB 会被截断（见常见问题）。

## 许可

本仓库未声明开源许可证。
