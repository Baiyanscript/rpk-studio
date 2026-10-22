# RPK Studio

浏览器里解析、修改并重新签名 Vela 发布版 RPK。全部计算在本机完成，文件不上传。

在线使用：**https://hrk666666.github.io/rpk-studio/**

界面遵循 Material Design 3：桌面用导航栏（Navigation rail），手机用底部导航（Navigation bar），四个页面分开——概览 / 资源 / 信息 / 签名。

## 功能

**概览**
- 解析 `manifest.json` / `manifest-watch.json`：包名、应用名、版本、页面数、文件数、体积
- 验签：RSA 签名、三段摘要、逐文件 SHA-256、证书主体与有效期
- 检测 `app.jsc` 里内嵌的 manifest 副本，比对外层版本号是否一致
- 导出开关：导出后自动校验、是否同步 manifest-watch.json

**资源**
- 包内全部文件按路径筛选，任意条目单独取出
- 图片以缩略图列出，支持替换、调整、还原
- 调整提供四种方式：适配（留透明）/ 裁剪（等比铺满，可拖动）/ 拉伸 / 原尺寸；带缩放滑块
- 一键导出全部图片为 zip

**应用信息**
- 改应用名、包名、版本名、版本号
- 换图标（同名替换，自动转 PNG）

**签名**
- 生成 RSA-2048 自签证书（CN 可填，10 年有效期）
- 导入已有 private.pem（PKCS#8 / PKCS#1）
- **导出身份**：`private.pem` + `certificate.pem` + 说明打包成 zip，可留作以后发版
- 复制证书指纹

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
index.html          页面（M3 四个视图）
assets/md3.css      M3 tokens 与组件
assets/app.js       界面逻辑（源码）
assets/rpk.js       签名块解析 / 生成、X.509 自签、重打包
assets/zip.js       ZIP 读写（基于 fflate）
assets/bundle.js    打包产物，页面实际加载它
vendor/fflate.js    DEFLATE 实现
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
- 依赖 `crypto.subtle` 与 `dialog` 元素，需要较新浏览器。
