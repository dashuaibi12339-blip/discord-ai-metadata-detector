# Discord 元数据检测器（AI 绘图提示词）

一个 Chrome / Edge 浏览器扩展（Manifest V3）：在 **Discord 网页版**里自动检测图片附件是否带 AI 绘图元数据，并直接读出提示词、参数与来源，不用再一张张保存到本地去看。

判定与提取只依赖各工具写进图片里的公开元数据格式：A1111 / Forge / Fooocus / SwarmUI 的 parameters 文本、ComfyUI 的 prompt / workflow JSON、NovelAI 的 Comment / Description JSON（含 V4/V4.5 的 caption 结构）与 alpha 通道隐写、InvokeAI 的 sd-metadata / invokeai_metadata，以及通用的 PNG tEXt / zTXt / iTXt / eXIf、WebP 与 JPEG 的 EXIF / XMP。全部解析逻辑都在本项目的 lib/ 下，不依赖任何第三方解析库。

---

## 一、它解决什么问题

你在 Discord 社区里看到一张图，想复刻，但必须先"右键 → 保存 → 打开看图工具 → 看有没有 parameters"。
本扩展把这一步变成：**图片左上角直接显示一个徽章**（有无元数据、是 NovelAI 还是 ComfyUI / A1111），鼠标悬停就能看到模型、采样器、步数、CFG、Seed、提示词预览；点面板里的按钮即可复制提示词。

## 二、界面含义

图片徽章（**只有三类**，其余一律不打扰）：

| 徽章 | 含义 |
| --- | --- |
| 绿底 **NAI** | NovelAI（含 V4/V4.5 的 caption 结构与 alpha 通道隐写） |
| 蓝底 **CF** | 本地 AI 工具：ComfyUI / A1111(Forge) / Fooocus / SwarmUI / InvokeAI（鼠标悬停看具体是哪个、以及模型/采样器/步数/CFG/Seed） |
| 红底 **!** | 抓取失败（附件失效、网络错误）—— 保留它是为了让你知道"为什么这张图一直没结果" |
| **没有徽章** | 没有 AI 提示词（无数据 / 只有普通 EXIF / 被 Discord 剥离），默认不显示；设置页可改成"显示全部状态的徽章" |

**点一下徽章**，就在这张图旁边弹出说明：完整正向/负面提示词、参数、来源，带「复制正向 / 复制负面 / 复制正+负 / 复制原图链接 / 下载原图 / 重新检测 / 隐写检测 / 在面板中查看」。**复制按钮默认只复制正向提示词**（不会把 Steps/Sampler/CFG 这些参数混进去）；要负面提示词用「复制负面」或展开后的独立按钮。没有元数据的图不会多出任何东西（徽章只在有元数据或抓取失败时出现）。

面板里每一条仍然带完整分类色块：**NAI**（绿）、**本地**（蓝）、**无**（灰）、**其他**（黄，有元数据但非 AI）、**被剥离**（橙）、**失败**（红）、**不支持**（灰）。

## 三、安装

1. 打开 Chrome，地址栏输入 **chrome://extensions/**（Edge 是 **edge://extensions/**）。
2. 打开右上角 **开发者模式**。
3. 点 **加载已解压的扩展程序**，选择本目录（含 manifest.json 的那一层）。
4. 打开 **discord.com** 的任意频道页，右下角会出现圆形按钮 **AI**，图片左上角开始出现徽章。

## 四、使用

- **自动检测**：默认开启。图片滚动进入视野时才抓取（省流量），结果按附件缓存，刷新或滚回去不会重复下载。
- **一眼对上号**：面板每行左侧是**缩略图**（用的是页面已经加载过的地址，直接命中浏览器缓存，**不额外耗流量**）；**鼠标划过某一行，频道里对应的那张图会被蓝色外框高亮**；点缩略图或「定位」会滚动到那张图并闪一下。
- **点徽章就地查看**：不用滚回面板 —— 点图片左上角的徽章，提示词会直接弹在图旁边。
- **面板分类标签页**：全部 / NovelAI / 本地工具 / 无数据 / 其他元数据 / 失败，每个标签带实时计数，点一下只看这一类。
- **点任意一行展开**：显示完整正向提示词、负面提示词、参数与备注（可滚动、可选中复制），并带"复制提示词（含负面与参数）""打开原图链接""定位到图片"。收起状态下只显示两行摘要，所以列表不会被长提示词撑爆。
- **扫描已加载的图**：把「当前已加载消息」里的所有图片加入检测队列。注意 Discord 是**虚拟滚动**，只把视口附近的消息留在页面上，所以这个按钮**扫不到频道历史**，通常只有十几张；往下滚动时 Discord 会加载更多消息，扩展会**自动补测**。已经检测过的直接命中缓存，不会重新下载（按钮会告诉你"命中缓存 N 张"）。想覆盖更多内容就往下翻，而不是反复点按钮。
- **关键词筛选**：面板顶部搜索框，支持模糊匹配 —— 输入 "blue archive" 也能命中 "blue_archive"，大小写不敏感，多个词需要全部命中（分词后按分隔符归一化比较，多个词需全部命中）；会在正向/负面/参数/文件名里一起搜。
- **悬浮球**：左下角那个圆球可以**按住拖动**到任何位置（位置会记住）；**双击**回到默认的右下角；**右键**或鼠标悬停时出现的 **× ** 可以**隐藏**它（弹窗与设置页的「隐藏悬浮球」都能重新显示）。隐藏后检测照常工作，面板可从弹窗的「打开检测面板」进入。
- **停止识别（总开关）**：弹窗顶部「启用检测」取消勾选，或面板里的「暂停检测」按钮 —— 扩展会**立刻移除所有徽章、清空队列、断开观察器**，并且 Service Worker **拒绝一切抓取请求**（不再产生任何网络请求）；面板顶部出现横幅，点「恢复检测」即可（恢复时只用本地缓存重画徽章，不重新下载）。设置页也能开关，状态持久保存。
- **暗淡没有提示词的图**：打开后，所有"没有 AI 提示词"的图（无数据 / 其他元数据 / 被剥离）会直接变暗，一眼就能看出哪些能复刻。
- **下载原图**：由扩展自己抓原始字节再交给浏览器下载，**保证是 CDN 原图（PNG 就是 PNG），不会被内容协商或代理转成 webp**；"打开原图链接"给的也是去掉缩放参数后的原图地址。
- **隐写检测（默认关闭；有省流量的预检，不必整份下载才判断）**：NovelAI 会把提示词额外写进 PNG 的 **alpha 通道最低位**（stealth_pngcomp / stealth_pnginfo）。有些图（被重新封装、或 Discord 重编码过）连 "Comment" 文字块都没有，提示词只剩这份隐写数据。
  - **省流量方案（已实现）**：隐写的前 152 bit（magic + 长度）按逐栏排布只落在**第 0 列**，所以只要解出**前 152 行**就能判断"到底有没有"。扩展先用现有字节做预检，不够就按估算逐步补抓（每次翻倍，上限 1 MB）——实测 626 KB 的图**只读 256 KB** 就判定"没有隐写"；导出 JPEG/WebP（本来就没 alpha）与**没有 alpha 通道的 PNG 连一个额外位元组都不用读**。**只有预检命中才下载整份**去解出提示词。
  - 另外预检与解码用的是**纯 JS 的 alpha 通道解码**（只解 alpha、不碰 RGB，也不需要 canvas），内存占用也小。
  - 默认**关闭**：PNG 行右侧有「隐写检测」按钮（展开后也会提示"这张 PNG 没有文字元数据，可能要试隐写检测"），点一下只对**这一张**生效；
  - **在哪里调**：扩展弹窗顶部的下拉「alpha 隐写检测（off / auto / always）」，设置页第一屏也有同一个选项。三档的确切含义：

| stealthScan | 什么时候**自动**做隐写预检 | 实际代价 |
| --- | --- | --- |
| **off（默认）** | **从不**。只有你点图上的「隐写检测」按钮、右键菜单、或面板的「隐写检测可见图」才做 | 0 |
| **auto** | 只对**首段扫完完全没有文字元数据**的 PNG（也就是本来会标成"无提示词"的那些）自动预检；已经读到 tEXt（A1111 / ComfyUI / NovelAI 带 Comment）的图**完全不碰** | 没有 alpha 通道 → 0 额外字节；有 alpha 但没隐写 → 预检即停；命中才下整份 |
| **always** | 每张 PNG 都预检，哪怕已经有文字元数据（基本没必要） | 同上，但覆盖面最大 |

  面板顶部的「隐写检测可见图」是对当前可见 PNG 批量做，同样按需。
- **导出**：面板或设置页可导出 CSV / JSON（含时间、文件名、来源、工具、参数、提示词、链接）。
- **直链检测**：设置页有"检测一个图片直链"工具，粘贴任意图片 URL（Discord 或其他站点都行）即可验证，用来排查"这张图到底有没有元数据"。

## 五、判定规则

只分三类来源，另加"有元数据但非 AI"一档：

- **novelai** — PNG 文字块 Software 含 "NovelAI"；Source 含 "NovelAI" / "novelai.net"；Comment 是含 prompt + steps 的 JSON；EXIF Comment / User Comment 是同类 JSON；或 alpha 通道隐写。
  注意：**不能**把 "Generation time / Generation_time" 当作 ComfyUI 特征 —— NovelAI V4.5 之后也有这个键，会误判。
- **comfyui**（含 A1111、InvokeAI 等本地工具）— PNG 文字块含 prompt / workflow / generation_data / ComfyScript；parameters 含 "Steps: " 或 "sui_image_params"；sd-metadata / invokeai_metadata / invokeai_graph / Dream；WebP 的 EXIF Make/Model/Image Description 以 "prompt:{" 或 "workflow:{" 开头；User Comment 以 {""prompt"" 开头且含 class_type；Comment / User Comment / Windows XP Comment / Image Description 含 "Steps: " 且含 Size: / Samplers: / Model:。
- **none** — 以上都不满足。

## 六、支持的元数据格式

- **PNG / APNG**：tEXt、zTXt、iTXt（含 UTF-8 中文提示词）、eXIf。
- **WebP**：RIFF 容器里的 EXIF、XMP chunk（也支持从文件尾段兜底扫描）。
- **JPEG**：APP1 EXIF（IFD0 + Exif SubIFD）、APP1 XMP、COM 注释；UserComment / XPComment 的 ASCII / UNICODE 两种编码。
- **提示词抽取**：
  - A1111 / Forge / Fooocus / SwarmUI：按 "Prompt: … Negative prompt: … Steps: …" 分段并切出每个参数。
  - ComfyUI：解析 prompt（API 格式）节点图，从采样器的 positive / negative 链接递归回溯到文本节点，附带 steps / cfg / sampler / scheduler / seed / denoise / 模型 / LoRA；没有 prompt 时退回到 workflow（UI 格式）。
  - NovelAI：Comment / Description JSON（prompt、uc、steps、sampler、scale、seed、尺寸）。**V4 / V4.5 的嵌套结构也支持** —— 当 Comment 里出现 v4_prompt / v4_negative_prompt 这种 caption 物件时，会取 caption.base_caption 作为主提示词，并把 char_captions 逐条追加为 "[坐标] 角色提示词"，不会再显示成一整坨 JSON。
  - InvokeAI：sd-metadata / invokeai_metadata（含新旧两种结构）。
  - 其他 JSON 与纯文本兜底。
- **隐写**：**stealth_pngcomp / stealth_pnginfo** 的 alpha 通道 LSB（前者是 gzip 压缩的 JSON，后者是原文 JSON）。位址算法为逐栏排布：bit k 落在第 floor(k/rows) 栏、第 k%rows 列，其中 rows = min(图像高度, 总位数)；同时也试逐列排布以兼容其他写入方式。解出的内容通常是 {Description, Software, Source, Generation time, Comment} 包装，会拆开取 Comment 与 Description。

## 七、关键设计

- **抓原图而不是预览图**：页面上 <img> 的地址是媒体代理（media.discordapp.net），可能已被重编码成 WebP 而丢掉 tEXt/EXIF。扩展会把主機换成 **cdn.discordapp.com**，并**只去掉会让代理重新编码的缩放参数（width / height / quality / format）**，ex / is / hm（还有 backend）等签名参数原样保留；若 CDN 失败会自动退回代理地址。
- **分阶段抓取（省流量，默认每张约 128 KB）**：
  1. 先拿 **首段 128 KB**（Range）—— AI 提示词几乎都写在 PNG 的 IHDR 之后、JPEG 的 APP1 里，一个请求就能读完；
  2. 如果首段**正好切在一个元数据 chunk 中间**（例如 ComfyUI 的 workflow 有几百 KB），解析器会报出该 chunk 的**精确结束位置**，扩展只补抓到那里 —— 实测一张 2.6 MB、tEXt 有 500 KB 的图，只读了约 500 KB，**没有下载 IDAT 影像数据**；
  3. 如果首段停在影像数据 chunk 内部，说明后面都是像素，**不再继续抓**；WebP 会按 chunk 表跳到下一个 chunk 头抓 64 KB 找 EXIF / XMP；
  4. 很小的文件（≤ 256 KB）直接整份抓，成本可忽略；
  5. 「**额外扫描文件末尾**」默认**关闭**（设置页可开）：能抓到少数工具写在 IDAT 之后的 tEXt，代价是每张多约 128 KB；
  6. **每页流量预算**（默认 30 MB）：达到后自动停止自动检测并提示，手动「扫描已加载的图」仍可继续。
  实测：一张 4.9 MB 的 Discord 原图，默认只读 **128 KB**（早期版本是 384 KB，现在是 1/38）。
- **附件失效要小心**：签名过期回 **404**，附件已删但签名合法时 Discord 会回 **200 + 36 字节 text/plain（"This content is no longer available."）**。扩展会看 content-type 与内容，两种情况都标成失败（**!**），不会误判成"无元数据"。
- **缓存**：按附件路径（去掉签名参数）缓存结果，最多 2500 条，LRU 淘汰，存在 chrome.storage.local。签名会过期，但路径不变，所以缓存长期有效。
- **限流与节流**：默认并发 3、请求间隔 120 ms，遇到 429 会退避；只对进入视野的图自动检测（每页默认上限 60 张），并受每页流量预算约束。
- **权限**：只用 storage / unlimitedStorage / contextMenus / downloads，加上 cdn.discordapp.com 与 media.discordapp.net 两个域。**不读取你的 Discord 登录令牌，不向任何第三方服务器发送数据**，所有解析都在本地完成。

## 八、关于"Discord 会不会剥离元数据"

实测与查证结论（都写在这里，避免你踩坑）：

1. Discord 的 CDN **支持 Range（返回 206，带 content-range 与 accept-ranges）**，并带 **access-control-allow-origin: \***，所以扩展可以只取文件开头那一小段，不必整张下载。
2. **附件原图**（cdn.discordapp.com）与**媒体代理图**（media.discordapp.net）是两份不同的东西。实测同一张 4,945,219 字节的原图：media 加 width=800&height=800 变成 867,281，加 width=80&height=80 变成 14,791，加 format=webp 变成 image/webp 537,560，加 format=jpeg 变成 image/jpeg；而 **cdn.discordapp.com 完全忽略这些参数**，参数怎么变都是原来的 image/png 4,945,219 字节。**所以必须抓原图、并去掉 width / height / format / quality 这类参数**，否则拿到的是重编码件、元数据必丢 —— 这正是本扩展的做法。
   另外：签名 **ex / is / hm 三者缺一不可**，少一个 / 改错一个 / 整体去掉查询串都会变成 404。扩展只删缩放参数、其余原样保留，不会破坏签名。
3. Discord 官方社区有专门的长贴 **"Image metadata getting removed"**，其中明确提到 Stable Diffusion 社区依赖图片里的文本元数据，并抱怨更新后元数据被移除；网上也普遍认为 Discord 会对（部分）上传做重新编码、剥离 EXIF。
4. 我们扫描了 127 个真实 Discord CDN 样本（44 PNG / 33 WebP / 11 JPEG）：**JPEG 的 EXIF 与 COM 段是被保留的** —— 11 张 JPEG 里有 4 张带完整 APP1/EXIF 与 COM，内容分别是 **"uid:…" / "Optimized for web" / "Processed by MediaService"**。可见 (a) 不能假设 Discord 对所有格式都剥离元数据，**JPEG / WebP 里的 AI 参数是有机会被读到的**；(b) 那几条 Discord 自己写的标记说明**确实存在被重新编码、原元数据被剥掉的图**（扩展会标成橙色 **剔**）。
5. 已失效的附件要特别小心：签名过期回 **404**，附件已删但签名合法时 Discord 会回 **200 + 36 字节 text/plain（"This content is no longer available."）**。扩展会检查 content-type 与内容，两种情况都标成失败（**!**），不会误判成"无元数据"。
6. **一个实测发现（值得知道）**：那张 Discord 直链图（1.74 MB、832×1152）**完全没有 tEXt 文字块**，但 alpha 通道里有 12035 个像素的 LSB 被改写 —— 解出来正是 NovelAI 的 {Description, Software, Source, Generation time, Comment} 包装结构。这说明 **Discord 对 PNG 做的是无损重编码（zlib 重压）：文字块会被丢掉，但像素数据（连同 alpha LSB 隐写）原样保留**。所以"频道里显示无提示词"的图，有一部分其实能救回来 —— 用那张图上的「隐写检测」按钮单张验证即可。
7. **仍未验证的一点**：44 张真实 PNG 里没有任何一张带 tEXt/iTXt/zTXt（但那些本来就是截图、普通照片，源图也没有）；而网上那些"确实带提示词的 Discord 链接"已全部过期（404），所以目前**既不能证明也不能否证"带提示词的 PNG 上传到 Discord 后 tEXt 是否还在"**。要确认只花一分钟：把自己一张确定带提示词的 PNG 上传到 Discord 任意频道，再用设置页的"检测一个图片直链"检测它的原图链接即可。如果你社区里能下到带元数据的图，说明那条上传路径是保留元数据的，插件就会标绿。

实践建议：**同一张图，"有元数据的那部分"就是插件标绿的图**；标橙 **剔** 的说明是 Discord 剥离的（不是插件没读到）；标 **无** 则表示这张图本身没有可读元数据。你可以用设置页的"检测一个图片直链"拿一张你确定带提示词的图做一次对照（把 Discord 原图链接粘进去）。

## 九、开发与测试

解析库是纯 ESM、无 chrome API 依赖，可以直接在 Node 里跑（Node 18+，用 Web 标准 DecompressionStream）：

    node test/stealth-url.mjs "<图片直链>"   # 命令行验证某张图有没有 alpha 隐写，并打印解析出的提示词
    node test/run-tests.mjs               # 71 项解析回归测试（含隐写低成本预检：无 alpha 通道 / 位数不足 / 无隐写 / 有隐写）（A1111 / NovelAI / ComfyUI / InvokeAI / WebP / JPEG / 相机EXIF / 截断 / IDAT 之后才写 tEXt / alpha 隐写 / Discord 重编码标记）
    node test/sw-harness.mjs "<图片直链>"  # 50 项端到端（含：2.6MB 图只读 500KB、隐写预检只读 256KB、停止识别总开关、尾段扫描开关）
    node test/badge-test.mjs              # 23 项：徽章唯一性（同一附件多个节点只出一个徽章）+ 面板滚动位置保持 + 悬浮球拖动/归位/隐藏：用 chrome API 桩在 Node 里真跑 Service Worker（本机 HTTP 夹具 + 真实 Discord 链接 + 快取落盘）
    node test/check-manifest.mjs          # 校验 manifest 引用的文件是否都在
    node test/consistency-test.mjs        # 35 项：校验内容脚本里重复实现的 URL 正规化 / 关键词匹配与 lib 版本完全一致，并验证原图 URL 改写（丢缩放参数、保留 ex/is/hm）
    node test/live-test.mjs "https://cdn.discordapp.com/attachments/.../file.png?ex=..&is=..&hm=.."   # 真实链接端到端
    python tools/make_icons.py   # 重新生成 icons/（需要 Pillow）

测试夹具是脚本按规范生成的（PNG chunk + CRC、TIFF IFD0/Exif SubIFD、RIFF、JPEG APP1），覆盖真实工具写出的元数据布局。

另外用自建 DOM / chrome 桩**真实加载过 content.js**（_research/verify/content-harness.mjs）跑 boot、面板渲染、导出、扫描、storage 变更，最终 unhandledRejection = 0。

另外做过一轮**破坏性输入测试**（脚本在 _research/verify/，属验证过程产物）：chunk 长度谎报 0xFFFFFFFF、8MB 巨型 tEXt、5000 个垃圾 tEXt、zip bomb（64MB 解压炸弹）、iTXt 缺少 NUL、zTXt method≠0、大端 MM TIFF、IFD0 越界 offset、count=0xFFFF、WebP size=0 死循环、ComfyUI 节点图循环引用/自我引用、stealth magic 伪造 + bitLen=0xFFFFFFFF —— **0 个用例抛异常或超时**；解压输出上限已收紧到 8MB、单个文字区块上限 256KB，坏 zlib 数据不再产生未处理的 Promise 拒绝。

## 十、目录结构

    manifest.json                 扩展清单（MV3）
    background/service_worker.js  抓取、解析、缓存、限流、右键菜单、导出
    content/content.js            徽章、悬浮面板、可见范围自动扫描（classic script）
    content/content.css           全部以 dmd- 前缀命名，降低与 Discord 样式冲突
    popup/                        工具栏弹窗：本页统计 + 快捷开关
    options/                      设置页：参数、缓存、直链检测、导出
    lib/metadata.js               统一入口：字节 -> 规范化元数据模型
    lib/png.js  lib/webp.js  lib/jpeg.js  lib/exif.js  lib/xmp.js  lib/zlib.js
    lib/a1111.js  lib/novelai.js  lib/comfyui.js  lib/invokeai.js
    lib/classify.js               来源判定（novelai / 本地 AI 工具 / 无）
    lib/analyze.js                来源 + 提示词抽取的编排
    lib/filter.js                 关键词模糊匹配（分词 + 分隔符归一化）
    lib/stealth.js                NovelAI alpha 通道隐写（纯函数 + 浏览器解码两段）
    lib/discord-url.js            附件 URL 正規化与"原图"候选
    test/                         回归测试与合成夹具
    tools/make_icons.py           图标生成

## 十一、已知限制

- 只支持 **Discord 网页版**（discord.com / ptb / canary）。桌面客户端与手机 App 无法注入扩展。
- **AVIF / HEIC** 容器暂不解析（Discord 转码后的预览图通常是 WebP/AVIF，这些本来也没有原始元数据）；视频附件不做提示词检测。
- ComfyUI 节点种类极多，只覆盖常见路径（KSampler 家族 + CLIPTextEncode 回溯），遇到非常规自定义节点可能只给出提示词而缺少部分参数。
- alpha 通道隐写检测只有「确认有隐写」时才会下载整份（默认关闭，按需单张触发；预检很便宜）。
- 图片在 Discord 里被"spoiler"折叠或尚未加载时，扩展无法读到，点开后会自动补测。

## 十二、判定与解析依据

本扩展为独立实现，只依赖各工具写进图片里的公开元数据格式：

- **A1111 / Forge / Fooocus / SwarmUI**：PNG tEXt 的 parameters 文本（Prompt / Negative prompt / Steps / Sampler / CFG scale / Seed / Size / Model 等键值段），以及 JPEG / WebP 的 EXIF UserComment、ImageDescription 里的同一段文本。
- **ComfyUI**：prompt（API 格式的节点图 JSON）与 workflow（UI 格式）；WebP 会把它写进 EXIF 的 Make / Model / ImageDescription。
- **NovelAI**：Comment / Description 的 JSON（V4 / V4.5 是 caption 结构，含 base_caption 与 char_captions），以及 alpha 通道最低位的 stealth_pngcomp / stealth_pnginfo 隐写。
- **InvokeAI**：sd-metadata / invokeai_metadata / invokeai_graph。
- **通用容器**：PNG 的 tEXt / zTXt / iTXt / eXIf，WebP 的 RIFF EXIF / XMP chunk，JPEG 的 APP1 EXIF / COM / XMP。

不含任何外部解析库：PNG chunk、zlib 解壓、TIFF/EXIF、WebP RIFF、JPEG 段掃描、alpha 通道隱寫全部自己實現，見 lib/ 目錄，且可在 Node 裡單獨跑測試。
