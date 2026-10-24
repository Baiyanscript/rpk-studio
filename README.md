# RPK Studio

浏览器里解析、修改并重新签名 Vela 发布版 RPK。全部计算在本机完成，文件不上传。

在线使用：**https://hrk666666.github.io/rpk-studio/**

界面遵循 Material Design 3，按任务而不是按功能分区：**包 / 编辑 / 导出 / 设置** 四个主页面，图片调整是真正意义上的二级页面，条目操作走底部弹层。

## 交互模型

| 层级 | 形态 | 进入 | 退出 |
|---|---|---|---|
| 主页面 | 四页横向分页 | 底部导航 / 左侧 rail / 左右滑动 / 方向键 | — |
| 二级页面 | 全屏层，从右滑入 | 图片卡片 | 左上返回、ESC、Android 返回键 |
| 底部弹层 | 从底部滑出，28dp 圆角 | 点文件项、点图片卡片 | 点遮罩、ESC |

**横向分页完全跟手**：`pointerdown` 记录起点，`pointermove` 直接改 track 的 `translate3d`，位移与手指 1:1；超过 22% 宽度或速度超过 0.45 px/ms 才吸附到相邻页，两端有 0.32 的阻尼。方向判定在 10px 内完成，纵向优先，所以上下滚动不会误触发翻页。起点在滑块、分段按钮、输入框上时不拦截。

**顶栏与底栏同步收放**：向下滚动超过 8px 一起收起，向上滚动展开，回到顶部或滚到底自动展开。顶栏固定在顶部，内容从它下方滚过，收起时正文顶到屏幕边缘。

**桌面**：≥600px 用左侧 Navigation rail，内容居中；<600px 用底部 Navigation bar，3 等分 grid + 安全区。

## 功能

**包**
- 解析 `manifest.json` / `manifest-watch.json`：包名、应用名、版本、页面数、文件数、体积
- 验签：RSA 签名、三段摘要、逐文件 SHA-256、证书主体与有效期
- 检测 `app.jsc` 内嵌的 manifest 副本，提示改包名/版本后的不一致

**编辑**
- 改应用名、包名、版本名、版本号
- 换图标（同名替换，可在编辑器里直接裁成圆形）
- 图片 / 文件两个视图，共用搜索框，按路径筛选
- 点图片卡片 → 弹层（调整 / 替换 / 还原），点文件 → 弹层（取出 / 复制路径）

**图片编辑器（二级页面）**
- 四种方式：适配（留透明）、裁剪（等比铺满，可拖动）、拉伸、原始
- **输出尺寸可手填**，宽高各自可改；锁定比例时改一边另一边按原图比例自动补齐
- **圆形裁剪**：输出带 alpha 的圆形 PNG，适合做图标
- 全程 canvas 处理，透明通道不丢；`toBlob('image/png')` 输出

**导出**
- 生成 RSA-2048 自签证书（CN 可填，10 年有效期），或导入已有 private.pem
- 导出身份：`private.pem` + `certificate.pem` + 说明打包成 zip
- 导出 RPK：重算 hash.json → 重打包 → 重建 `RPK Sig Block 42`，可选自检

**设置**
- 外观：跟随系统 / 浅色 / 深色
- 历史记录：载入与导出各记一条，可查看、删除单条、清空，最多 60 条
- 服务条款与隐私：随时回看，标记同意时间
- 隐私说明、安全提示、第三方许可、免责声明

## 首次启动

第一次打开会挡住界面，要求阅读《服务条款》《隐私政策》《风险与免责》三部分。**必须滚动到文末**，三项勾选框才会解锁；三项全部勾选后才能点「同意并继续」。同意记录写入 `rpk-consent-v1`（含时间与版本号），之后不再打扰，可在设置里回看。

## 大包不卡的做法

一个 211 条目、101 张图的包：

| 环节 | 做法 |
|---|---|
| 解析 | 只读中央目录，条目不提前解压；摘要每 24 个文件让出一次主线程 |
| 文件列表 | 每批 50 条插入，批间 `scheduler.yield()`，底部显示“已显示 x / y” |
| 图片网格 | 先插轻量骨架（每批 20 个），进入视口才解码；每 4 张让出一次 |
| 图片尺寸 | 不为读 PNG 头解压整张图，标签先显示体积，水合后换成宽高 |
| 导出图片 | fflate 流式 zip，逐张压缩，遮罩显示进度 |
| 导出 RPK | 摘要计算分批让出，遮罩显示“计算文件摘要 x / y” |
| 反馈 | 超过 140 ms 的操作才弹遮罩；按钮 loading 态防重复点击；横向拖动后吞掉误触 click |

实测（4 倍 CPU 降速，模拟中低端手机）：上传 467 ms、图片页出骨架 268 ms、导出图片 415 ms、导出 RPK 522 ms，**长任务（>50 ms）全部为 0**。

## 版本一致性

静态资源带构建时间戳（`?v=202610232313`），HTML 内联 `window.__PAGE_VERSION__` 与脚本里的 `BUILD` 必须相等；不相等时自动强刷一次（sessionStorage 防循环）。页面数量对不上时顶部提示强制刷新。

## 签名与重签名

签名算法固定为 RSA-2048 + SHA-256（PKCS#1 v1.5），与 `aiot release` 一致。

RPK 使用小米私有的 `RPK Sig Block 42`：签名块插在中央目录之前，覆盖 header / central / EOCD 三段哈希，外加每个文件的 `CRC32(路径) + SHA-256`。常见 APK 签名工具只认 JAR signing 与 APK Signing Block，无法处理这个结构。`aiot release` 产出的包，改完内容后用这里的身份重签即可。

命令行复现：

```bash
openssl pkcs12 -export -inkey private.pem -in certificate.pem -out key.p12
```

> 换签名后，与原手机端配对的应用（带同步器、依赖互联通信的快应用）会拒绝通信。改包名会让设备当成新应用，旧数据不继承。

## 安卓客户端

`android/` 是 Tauri 2 + Rust 的外壳，WebView 加载同一份页面资源。Rust 侧三个命令：

| 命令 | 作用 |
|---|---|
| `save_bytes` | 调系统文件管理器（SAF / ACTION_CREATE_DOCUMENT）选位置，再用 fs 插件写入。`content://` URI 由 ContentResolver 打开，不需要存储权限 |
| `share_bytes` | 写入应用缓存后交给系统「打开方式」，由系统列出可接收的应用 |
| `summarize` | 用纯 std 实现算整包 SHA-256 与条目统计，用于导出后核对 |

构建方式、职责边界与验证状态见 [android/README.md](android/README.md)；`.github/workflows/android.yml` 可手动触发产出 debug APK。

## 目录

```
index.html          页面（4 个主页面 + 1 个二级页面 + 弹层）
assets/md3.css      M3 tokens 与组件
assets/app.js       交互逻辑（源码）：分页手势、层级、渲染、编辑器
assets/rpk.js       签名块解析 / 生成、X.509 自签、重打包
assets/zip.js       ZIP 读写（基于 fflate）
assets/bundle.js    打包产物，页面实际加载它
vendor/fflate.js    DEFLATE / ZIP 实现
build.mjs           构建脚本：打包并同步版本号
docs/rpk-format.md  RPK 格式与签名的实测记录
android/            Tauri 2 + Rust 的安卓外壳
```

改完源码重新构建：

```bash
npm i
npm run build
```

## 已知边界

- JSC 包里 `app.jsc` 另存了一份编译时的 manifest，改包名/版本只改外层 JSON 时，应用内 `import { versionCode }` 仍读到旧值。界面会提示，但不改字节码——那需要等长替换或重新编译。
- 只处理 ZIP + 签名的结构，不做 dex/so 之类的内容修改。
- 依赖 `crypto.subtle`、`IntersectionObserver`、Pointer Events，需要较新浏览器。
