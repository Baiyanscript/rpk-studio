# RPK Studio

浏览器里解析、修改并重新签名 Vela 发布版 RPK。全部计算在本机完成，文件不上传。

在线使用：**https://hrk666666.github.io/rpk-studio/**

格式与签名机制的实测记录见 [docs/rpk-format.md](docs/rpk-format.md)。

## 打开

直接双击 `index.html` 即可（Chrome / Edge / 新版 Firefox / Safari 均可，`crypto.subtle` 在 `file://` 下可用）。

如果浏览器限制本地文件，起一个静态服务：

```bash
python3 -m http.server 8123
# 然后访问 http://localhost:8123
```

## 能做什么

**读包**
- 解析 `manifest.json` / `manifest-watch.json`，显示包名、应用名、版本、页面数、文件数、体积
- 解析签名块（`RPK Sig Block 42`）：验 RSA 签名、验三段摘要、验每个文件的 SHA-256、读取证书主体与有效期
- 读 `app.jsc` 里内嵌的 manifest 副本，比对外层版本号是否一致

**改包**
- 改应用名、包名、版本名、版本号
- 换应用图标：左侧入口，或「图片资源」里点同一张图
- 换任意图片资源：包内所有 PNG/JPEG 以缩略图列出（含尺寸与已改标记），点开即换，可还原
- 重算 `META-INF/CERT` 里的 hash.json，重建签名块

**图片处理规则**
- 上传 PNG 且尺寸与原图一致：按原字节写入，不重新编码，体积不变
- 尺寸不一致或格式为 JPG/WebP：Canvas 解码后等比缩放到原尺寸、居中、透明填充，输出 PNG
- 未改动的文件直接复用原始压缩数据，导出包只比原包多出改动部分的差值（实测换一张图 = -1.7 KB，不是整包重压）

**取信息**
- 导出整包信息为 JSON（manifest、签名、文件清单）
- 文件列表按路径筛选，任意条目单独取出

## 签名

两种身份：

1. **生成新身份** — 在浏览器里生成 RSA-2048 密钥，并自签一张 X.509 证书（CN 可自定义，有效期 10 年）
2. **用已有私钥** — 载入 `openssl` 生成的 `private.pem`（PKCS#8 或 PKCS#1），用它自签证书

签名算法固定为 RSA-2048 + SHA-256（PKCS#1 v1.5），与 AIoT Toolkit 的 `aiot release` 一致。

> 换签名后，与原手机端配对的应用（例如带同步器的快应用）会拒绝通信——握手前会校验两端证书。改包名也会让设备当成新应用，旧数据不继承。

## 目录

```
index.html          页面
assets/style.css    样式
assets/app.js       界面逻辑（源码）
assets/rpk.js       签名块解析 / 生成、X.509 自签、重打包
assets/zip.js       ZIP 读写（基于 fflate）
assets/bundle.js    上面三个文件的打包产物，页面实际加载它
vendor/fflate.js    DEFLATE 实现
```

页面加载的是 `bundle.js`。改完源码后重新构建：

```bash
npm i
npm run build
```

## 已知边界

- JSC 包（`app.jsc`）里另存了一份编译时的 manifest，改包名/版本只改外层 JSON 时，应用内 `import { versionCode } from "../manifest.json"` 仍读到旧值。界面会给出提示，但不会替你改字节码——那需要等长替换或重新编译。
- 只处理 ZIP + 签名的结构，不做 dex/so 之类的内容修改。
- 依赖 `crypto.subtle`，需要较新的浏览器。
