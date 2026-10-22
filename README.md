# RPK Studio

浏览器里解析、修改并重新签名 Vela 发布版 RPK。全部计算在本机完成，文件不上传。

在线使用：**https://hrk666666.github.io/rpk-studio/**

界面遵循 Material Design 3：桌面用 Navigation rail，手机用 Navigation bar，五个页面分开——概览 / 资源 / 信息 / 签名 / 设置。

## 功能

**概览**
- 解析 `manifest.json` / `manifest-watch.json`：包名、应用名、版本、页面数、文件数、体积
- 验签：RSA 签名、三段摘要、逐文件 SHA-256、证书主体与有效期
- 检测 `app.jsc` 里内嵌的 manifest 副本，比对外层版本号是否一致

**资源**
- 包内全部文件按路径筛选，任意条目单独取出
- 图片以缩略图列出，支持替换、调整、还原
- 调整提供四种方式：适配（留透明）/ 裁剪（等比铺满，可拖动）/ 拉伸 / 原尺寸；带缩放滑块
- 同名图片（不同目录）在缩略图下方标出父目录，避免混淆
- 一键导出全部图片为 zip

**应用信息**
- 改应用名、包名、版本名、版本号
- 换图标（同名替换，自动转 PNG）

**签名**
- 生成 RSA-2048 自签证书（CN 可填，10 年有效期）
- 导入已有 private.pem（PKCS#8 / PKCS#1）
- 导出身份：`private.pem` + `certificate.pem` + 说明打包成 zip，留作以后发版
- 复制证书指纹

**设置**
- 外观：跟随系统 / 浅色 / 深色（记住选择）
- 导出后自动校验签名、是否同步 manifest-watch.json

## 大包不卡的做法

一个 211 条目、101 张图的包，早期版本上传要卡半秒、点图片页要冻 200 ms。现在：

| 环节 | 做法 |
|---|---|
| 解析 | 只读中央目录，条目不提前解压；校验摘要每 24 个文件让出一次主线程 |
| 文件列表 | 每批 60 条插入，批间 `scheduler.yield()`，底部显示“已显示 x / y” |
| 图片网格 | 先插轻量骨架（每批 30 个），进入视口才解码；`IntersectionObserver` + 队列，每 6 张让出一次 |
| 图片尺寸 | 不再为了读 PNG 头解压整张图，标签先显示体积，水合后再换成宽高 |
| 导出图片 | fflate 流式 zip，逐张压缩、每 6 张让出，遮罩上显示进度 |
| 导出 RPK | 摘要计算分批让出，遮罩显示“计算文件摘要 x / y” |
| 反馈 | 超过 140 ms 的操作才弹遮罩，短操作不闪屏；按钮进入 loading 态并防重复点击 |

实测（4 倍 CPU 降速，模拟中低端手机）：上传 467 ms、图片页出骨架 224 ms、导出图片 453 ms、导出 RPK 532 ms，**长任务（>50 ms）全部为 0**。

## 布局

- 手机（<840px）：底部导航 5 等分 grid，`min-width: 0` 防挤压；顶部留 `env(safe-area-inset-top)`，底部 `env(safe-area-inset-bottom)`；列表与网格不做内部滚动，交给页面，避免被底栏截断
- 桌面（≥840px）：Navigation rail 88px，内容 `max-width: 1040px` 居中，列表与网格内部滚动并给 FAB 留出呼吸位
- Snackbar 出现时 FAB 自动上移，两者不再互相压
- 导出 FAB 只在“已载包 + 已设身份”时淡入，不可用时完全隐藏，不占视觉

## 版本一致性

静态资源带构建时间戳（`?v=202610230004`），HTML 内联 `window.__PAGE_VERSION__` 与脚本里的 `BUILD` 必须相等；不相等时自动强刷一次（用 sessionStorage 防循环）。视图数量对不上时顶部提示强制刷新，不会出现“点了没反应”的空白页。

## 签名与重签名

签名算法固定为 RSA-2048 + SHA-256（PKCS#1 v1.5），与 `aiot release` 一致。

**MT 管理器不能重签 RPK**：它只认 APK 的 v1/v2/v3 签名方案，RPK 用的是小米私有的 `RPK Sig Block 42`（签名块插在中央目录之前，覆盖三段哈希 + 逐文件摘要）。这个页面本身就是重签工具——载入 rpk、设好身份、导出即可。

需要命令行复现时，可以把导出的身份转成 keystore：

```bash
openssl pkcs12 -export -inkey private.pem -in certificate.pem -out key.p12
```

> 换签名后，与原手机端配对的应用（带同步器、依赖互联通信的快应用）会拒绝通信。改包名会让设备当成新应用，旧数据不继承。

## 目录

```
index.html          页面（M3 五个视图）
assets/md3.css      M3 tokens 与组件
assets/app.js       界面逻辑（源码）
assets/rpk.js       签名块解析 / 生成、X.509 自签、重打包
assets/zip.js       ZIP 读写（基于 fflate）
assets/bundle.js    打包产物，页面实际加载它
vendor/fflate.js    DEFLATE / ZIP 实现
build.mjs           构建脚本：打包并同步版本号
docs/rpk-format.md  RPK 格式与签名的实测记录
```

改完源码重新构建：

```bash
npm i
npm run build
```

## 已知边界

- JSC 包里 `app.jsc` 另存了一份编译时的 manifest，改包名/版本只改外层 JSON 时，应用内 `import { versionCode }` 仍读到旧值。界面会提示，但不会替你改字节码——那需要等长替换或重新编译。
- 只处理 ZIP + 签名的结构，不做 dex/so 之类的内容修改。
- 依赖 `crypto.subtle`、`<dialog>`、`IntersectionObserver`，需要较新浏览器。
