# Vela RPK 打包机制与二次修改可行性分析

**对象**：`youshen2/com.bandbbs.ebook`（弦电子书，分支 `n67`，适用于小米手环 8/9/10 Pro、REDMI Watch 5/6）
**分析目标**：同样内容用 AIoT Toolkit 打发布版（带签名）→ 多次打包的字节差异；改图标/应用名/包名后产物变动；脱离 AIoT Toolkit 改包并重签的可行性；JSC 开关的影响。
**结论基于本机实测**（Ubuntu 22.04 / Node 22.13 / aiot-toolkit 2.0.5 / 自签 RSA-2048 证书），不是推测。

---

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 同样的源码、同样的证书，打两次包，文件一样吗 | **不一样**。实测 A≠B，且 211 个 zip 条目全部换时间戳、3 个文件内容变化；但所有**业务文件内容**（154 个）完全相同 |
| 差异的根因 | 打包器把 `new Date()` 写进了 4 个地方：`manifest.json` 的 `packageInfo.timeStamp`、`META-INF/build.txt`、ZIP 注释、每个条目的 DOS 时间戳 |
| 签名是不是随机的 | **不是**。RSA-2048 + SHA-256（PKCS#1 v1.5，确定性算法）。签名变化 100% 来自"被签内容变了"，不是签名本身随机 |
| 改图标/名字/包名后重新打包，变什么 | 文件名、`manifest.json`、`manifest-watch.json`、`app.jsc`（内嵌元数据）、`META-INF/CERT`、`META-INF/build.txt`、图标文件；**其余 200 余个文件字节不变** |
| 不用 AIoT Toolkit 能不能改 | **能**。已实测：解包 → 改 `manifest.json`/`manifest-watch.json`/图标 → 重算 `hash.json` → 重生成签名块，产物签名、三段摘要、逐文件摘要全部校验通过 |
| 门槛在哪 | ① 必须有私钥（可自签，但不能伪造原发布者签名）；② JSC 包内 `app.jsc` 还嵌了一份 manifest，只改外部 JSON 会不一致；③ 与手机端互联的应用，改包名/换证书会直接断连 |
| JSC 打开影响吗 | **对 manifest/图标本身没影响**（都是明文）；**对 JS 代码有影响**：代码变 QuickJS 字节码，且**内嵌了一份 UTF-16LE 的 manifest 明文**，长度改动需重写字节码，实际只能等长替换或重编译。JSC 还让压缩后包体从 612 KB 涨到 688 KB |

---

## 1. 环境与方法

```text
源码: youshen2/com.bandbbs.ebook @ n67（package: com.bandbbs.ebook.plus / 电子书 / V26.4.3.BAND / versionCode 260510）
工具: npm i aiot-toolkit@2.0.5（项目 package.json 声明 ^2.0.4）+ @aiot-toolkit/jsc 1.0.x
签名: openssl genrsa 2048 → sign/private.pem + sign/certificate.pem（AIoT Toolkit 的 release 模式固定读 sign/ 目录）
命令: npx aiot release --enable-jsc   /   npx aiot release（不带 JSC）
```

Toolkit 的构建不直接写在项目目录，而是复制到 `/workspace/.temp_<项目名>/` 里跑，产物落在项目 `dist/`。产物命名规则：`{package}.{debug|release}.{versionName}.rpk`。

---

## 2. RPK 容器解剖

RPK 是 **ZIP + APK v2 式签名块**，不是加密包。

```text
┌──────────────────────────────┐
│ local file header + data ×211│  ← 未签名时的 header 段
├──────────────────────────────┤
│ RPK Sig Block 42（7685 B）    │  ← 签名块插在中央目录之前
├──────────────────────────────┤
│ central directory            │
├──────────────────────────────┤
│ EOCD（CD offset 已被改写）    │
└──────────────────────────────┘
```

签名块实测结构（本包，RSA-2048）：

| 字段 | 值 | 说明 |
|---|---|---|
| magic | `RPK Sig Block 42` | 16 字节，位于中央目录前 16 B |
| overall block | len 1489 / signed-data 915 B | 私钥签名对象 = `[size][signdata]` 这 915 字节 |
| signdata | `digests.size(40) + 0x0103 + SHA256(32) + certs.size + X.509 DER(855) + 0` | 内含三段摘要的最终 SHA-256 |
| signature | 256 B，id `0x0103` | RSA-2048 / SHA-256（PKCS#1 v1.5） |
| pubkey | 294 B（SubjectPublicKeyInfo DER） | 与包内证书公钥严格相等 |
| 文件摘要块 | id `0x01000201`，154 条 | 每条 = `CRC32(路径) + int16 摘要长度 + SHA256(文件内容)`，再整体签名 |

**签名覆盖三处**，每处先做 `SHA256(0xA5 + int32(len) + 段内容)`，再把三段拼成 `0x5A + int32(3) + h1 + h2 + h3` 做 SHA-256，最后 RSA 签名：

1. **header 段**：`[0, 中央目录偏移)`，即全部 local header + 数据；
2. **central 段**：整个中央目录；
3. **footer 段**：EOCD（校验时必须把 EOCD 里的 CD offset 还原成"插入签名块之前"的值）。

这意味着：**改动任何一个字节（哪怕文件名的大小写、一个时间戳），签名必然失效**。签名算法是确定性的，无私钥无法伪造——只能整体换成自己的私钥 + 自签证书。

---

## 3. 实验一：同内容同证书，连续打两次包

```
A.rpk  688,135 B  211 条目  sha256 66aa8c92…
B.rpk  688,128 B  211 条目  sha256 b4553a4b…
```

**逐条目比对结果**：

| 维度 | 结果 |
|---|---|
| 条目名称集合 | 完全一致（211 个） |
| **内容变化** | 仅 3 个：`manifest.json`、`META-INF/build.txt`、`META-INF/CERT` |
| **时间戳变化** | **211 / 211 全部变化** |
| ZIP 注释 | 变化，内含 `timeStamp` |

三处内容差异都是同一个东西——时间戳：

```diff
  manifest.json
   "packageInfo": {
     "toolkit": "2.0.5",
-    "timeStamp": "2026-10-20T15:14:58.706Z",
+    "timeStamp": "2026-10-20T15:15:17.315Z",

  META-INF/build.txt
- timeStamp=2026-10-20T15:14:58.707Z
+ timeStamp=2026-10-20T15:15:17.316Z
```

`META-INF/CERT` 里的 `hash.json` 是逐文件 SHA-256 表，本身不含时间戳，但它所在的 ZIP 被重新生成 + 注释带时间戳，所以整块也变。

**结论**：所谓"同样内容打两次包不一样"，不是签名随机，而是**打包器没有做可复现构建**——`new Date()` 被写进了 4 处。对于"发布版包体比对/溯源"来说，这反而是好事：每个 rpk 都带构建时间、toolkit 版本、Node 版本、平台、架构（`packageInfo` + `build.txt` + ZIP 注释三重冗余），很容易判断两个包是不是同一次构建、用什么环境构建的。

> 顺带验证：用脚本把条目时间戳、ZIP 注释固定后再打，两次输出就趋于一致（我的 replay 实验做到字节数相同、仅剩约 400–500 字节差异，来源是 JSZip 对 Date 对象的 DOS 时间取整与压缩边界），说明**流水线本身确定，变量只有时间戳**。

---

## 4. 实验二：改图标 / 应用名 / 包名 / 版本号后重新打包

改动：`package` → `com.example.reader`，`name` → `测试电子书`，`versionName` → `V26.4.4.DEMO`，`versionCode` → 260511，`icon` → 新图（另存 `icon_demo.png`）。

```
C.rpk  688,466 B  212 条目  sha256 8f0703fb…
文件名: com.example.reader.release.V26.4.4.DEMO.rpk
```

| 变化项 | 细节 |
|---|---|
| 包文件名 | 由 `package + versionName` 决定，直接改名 |
| 条目数 | 211 → 212（新增 `common/icon_demo.png`） |
| 内容变化条目 | `manifest.json`、`manifest-watch.json`、`app.jsc`、`META-INF/CERT`、`META-INF/build.txt` |
| 签名块 | 7685 → 7723 B（多 1 个文件摘要 = 6 + 32 = 38 B，正好对上） |
| 其余 200+ 文件 | 字节不变（图片、页面字节码全部原样） |

两个值得注意的点：

1. **manifest 是双份的**。包里同时有 `manifest.json` 和 `manifest-watch.json`（toolkit 按 `deviceTypeList` 生成的终端专用副本，字段完全一样但少 `minAPILevel/packageInfo`）。只改一个会导致两份元数据打架。
2. **旧图标不会消失**。`icon` 指向新文件时，`common/icon.png` 仍作为资源被打进包（源码里还在），只是没人引用——白占体积，也留下了"原图标"的痕迹。
3. **`app.jsc` 也会变**。原因见第 6 节：源码里 `import { versionCode } from "../manifest.json"`，rspack 把整份 manifest 当模块塞进了 `app.js`，改版本号自然改字节码。

---

## 5. 实验三：不用 AIoT Toolkit 的离线改包 + 重签名

### 5.1 流程（实测可跑通）

```
1. 读 rpk → 按原顺序取出全部条目
2. 改 manifest.json / manifest-watch.json（package、name、versionName、versionCode、icon）
3. 同名替换 common/icon.png（保持 100×100 PNG）
4. 重算 META-INF/CERT：对"除 META-INF 外"的 154 个文件逐个 SHA-256，写成 hash.json，再压成 CERT（内层 zip）
5. 重建 rpk（顺序：CERT 在最前，其余按原顺序，DEFLATE level 9，ZIP 注释写自己的）
6. 生成签名块：三段摘要 + 154 条文件摘要 → RSA-SHA256 → 插入 central 之前，回写 EOCD 的 CD offset
```

产物 `M_modify.rpk`（684,008 B，211 条目）自校验结果：

| 校验项 | 结果 |
|---|---|
| 整体 RSA 验签（openssl dgst -verify） | **Verified OK** |
| 三段摘要重算 vs 包内摘要 | **匹配** |
| 证书公钥 == 签名块公钥 | **True** |
| 文件摘要列表 RSA 验签（154 条） | **Verified OK** |
| 154 条逐文件 SHA-256 | **0 条不符** |
| 与 A 的差异 | 仅 4 个条目：`manifest.json`、`manifest-watch.json`、`common/icon.png`、`META-INF/CERT` |

作为对照，`aiot release` 打的 A / C / D 三个包跑同一套校验，也全部通过（说明分析出的格式定义是对的，不是自说自话）。

### 5.2 可行性判定

| 项目 | 判定 | 说明 |
|---|---|---|
| 改 manifest 里的名字/包名/版本 | **可行** | 纯明文 JSON，无加密、无校验和绑定 |
| 换图标 | **可行** | `manifest.icon` 指向的 PNG，同名替换即可；尺寸建议保持 100×100 |
| 改页面逻辑/文案 | **JSC 关闭时可行**（`app.js` 是明文 `JSON.parse('{...}')` 与普通 JS）；**JSC 打开时基本不可行**（见第 6 节） | |
| 保持原发布者签名 | **不可行** | RSA-2048 PKCS#1 v1.5，无私钥不能伪造；只能"换签名" |
| 重签名后能被设备接受 | **大概率可以，但需真机确认** | 官方 FAQ 明确：不涉及手表-手机通信时"对证书无特殊要求，按文档步骤生成即可"；自签开发者证书能装自己设备的包，说明系统只做"包内自洽校验"，不做 CA 链校验 |
| 重签名后还能手机同步 | **不行** | 官方 FAQ：通信前会检查应用签名，rpk 证书必须与手机 App 证书一致；本项目 `handshake.js` 还用 `manifest.versionCode` 做协议版本校验 |
| 上架/被平台识别 | **不行** | 换证书"可能无法上架"（官方原话）；包名变了等于新应用 |

### 5.3 最大的坑：JSC 包里有两份 manifest

`M_modify.rpk` 里 `manifest.json` 已经是新名字，但 `app.jsc` 内嵌的那份还是旧的：

```
manifest.json    : "package":"com.example.reader","name":"测试电子书","versionCode":260511
app.jsc 内嵌     : "package":"com.bandbbs.ebook.plus","name":"电子书","versionCode":260510
```

后果：

- 系统层面（安装、列表、`app.getInfo()`）读外部 `manifest.json` → 显示新名字；
- 应用自己 `import { versionCode } from "../manifest.json"` 用的是**编译进字节码的那份** → 握手仍报 260510，与手机端协商的版本对不上；
- 两份元数据不一致，属于典型的"改了一半"。

要彻底一致，必须让 `app.jsc` 里那份也改——而它是 QuickJS 字节码，字符串以 UTF-16LE 存在常量池里，长度变化要重写长度字段与后续偏移，实际只能**等长替换**或**关掉 JSC 重新打包**。

---

## 6. JSC 开关到底影响什么

| 维度 | JSC 关闭 | JSC 打开 |
|---|---|---|
| 代码文件 | `app.js` + `pages/*/xxx.js`（可读） | `app.jsc` + `pages/*/xxx.jsc`（QuickJS 字节码） |
| 未压缩总量 | 1,208,869 B | 1,109,534 B（−8.2%） |
| 压缩后 rpk | 611,576 B | 688,135 B（**+12.5%**） |
| manifest 存储 | `manifest.json` + `app.js` 内 `JSON.parse('{"package":...}')` 明文 | `manifest.json` + `app.jsc` 内的 UTF-16LE 常量 |
| 改名字/版本 | 直接改两处文本，长度随意 | 只能等长替换，或重编译 |
| 改业务逻辑 | 直接改 JS | 不可行（需源码重编） |

字节码里能直接搜到的东西（说明 JSC 只是"编译"，不是"加密"）：

```
"package":"com.bandbbs.ebook.plus","name":"电子书","versionName":"V26.4.3.BAND","versionCode":260510,...
rv*bundler=rspack@1.7.12
@aiot/app  $app_require$  manifest $translateStyle$
internal://files/books/bookshelf.json
```

**所以**：

- 只想改**图标/名字/包名**：JSC 开不开都不影响正确做法（改 manifest + 重打包），但**JSC 打开时会多出一份内嵌副本**，必须同步，否则出现 5.3 的不一致；
- 想改**代码**：JSC 是硬门槛，只能等长替换字符串或拿源码重编；
- 想**审计**别人发布的包：JSC 打开时仍可从字节码常量池提取包名、版本、路径、字符串常量，只是拿不到控制流结构。

---

## 7. 实用结论

1. **"同内容多次打包"的差异是可解释、可枚举的**：4 处时间戳 + 由此级联的 `META-INF/CERT` 与签名。业务文件一格没动。
2. **应用信息（图标/名称/包名/版本）全部集中在 manifest，且是明文**，因此"改信息"这件事本身没有任何密码学保护；保护只落在签名上，而签名只能"换"，不能"伪造"。
3. **不依赖 AIoT Toolkit 完全可以重打包**：签名格式公开可解析（`RPK Sig Block 42` + 三段摘要 + 文件摘要表 + RSA-SHA256），实测自实现的重签包能通过全部自校验。真正的工作量在三处：重算 `hash.json`、同步双 manifest、处理 JSC 内嵌元数据。
4. **真正的边界不是技术，而是信任链**：自签证书能装自己设备，但装不进"通信配对"和"上架校验"。对本项目这种带手机同步器的应用，换包名/换证书 = 同步功能直接废掉（这也是米坛第三方封装工具明确点名"环间电子书可能无法正常使用"的原因）。
5. **如果目的是自己改个名字自用**：最稳的是拿源码改 `src/manifest.json` + 换 `src/common/icon.png`，用自己的证书跑 `aiot release --enable-jsc`，让 `app.js` 内嵌元数据跟着一起更新——而不是改打好的 rpk。

---

## 8. 风险提示（非技术）

- 本项目是 **AGPL-3.0**，修改后分发（含以 rpk 形式发布）需要同样开源，且需保留原作者署名。
- 米坛社区的发布规则要求使用自己的证书、自己的包名；用他人包名/图标发布属于冒名，会被下架并可能封号。
- 改包后签名变化会让"手机端同步器"拒绝通信，用户侧表现为"装了但用不了"，容易被认为是投毒包。

---

## 附录：本报告用到的脚本

| 文件 | 用途 |
|---|---|
| `scripts/verify3.py` | 独立解析 RPK 签名块，验 RSA 签名、三段摘要、逐文件摘要（纯 Python + openssl，不依赖 toolkit） |
| `scripts/cmp.py` | 两个 rpk 的逐条目对比（内容 SHA-256 / CRC / 时间戳） |
| `scripts/repack.js` | 离线改包 + 重签名（改 manifest、换图、重算 CERT、插入签名块） |
| `scripts/replay_fixed.js` | 固定时间戳重打，验证"差异只来自时间戳"的可复现性实验 |

---

## 9. 能否保留签名重新打包

结论：**不能保留签名块本身，只能保留证书身份**。以下是实测数据。

### 9.1 覆盖边界

| 项 | 实测值 |
|---|---|
| 首个 local header 偏移 | 0（文件开头没有未被覆盖的空洞） |
| header 段 | `[0, 中央目录偏移)`，含全部 211 个条目的头与数据 |
| central 段 | 整个中央目录，含每个条目的 local header 偏移字段 |
| footer 段 | EOCD 及其注释 |
| 逐文件摘要 | 154 条，覆盖除 `META-INF/CERT` 外的**全部**文件 |

没有"白改区"：`META-INF/build.txt` 这类元数据文件同样在逐文件摘要里；即使不在，它也在 header 段内。

### 9.2 篡改一个字节

把 `common/images/back.png` 的压缩流改 8 个字节，不重签：

```
摘要=false  RSA=true  坏文件=1/154
```

RSA 仍然"有效"是因为验签只针对签名块自身的 signdata；而 signdata 里的三段摘要是重算比对的，第一处就已不符。

### 9.3 签名是否随机

同一份输入、同一把私钥，连续签两次：

```
r1 = 504b0304…  688264 B
r2 = 504b0304…  688264 B
两次完全一致: true
```

RSA PKCS#1 v1.5 是确定性算法。签名变化 100% 来自被签内容变化，不是随机数。

### 9.4 用同一张证书重签

```
原包证书公钥 == 重签包证书公钥: true
原包签名值   == 重签包签名值:   false
原包三段摘要 == 重签包三段摘要: false
重签包自身校验: 摘要=true RSA=true 坏文件=0
```

也就是说：**证书身份可以完全一致（CN、指纹、有效期都不变），签名值必然不同**。设备端若只做自洽校验，装上去没有任何区别；但字节级比对能立刻看出是重签的。

### 9.5 零改动重签也复现不了原包

完全不动内容，只重新生成 `META-INF/CERT` 并签名，输出 688264 B，原包 688135 B，差 129 B。原因是 CERT 内部的 `hash.json` 被重新压缩，deflate 输出与当初 AIoT Toolkit 用的 JSZip 不完全相同，于是 CERT 字节变化 → 文件摘要变化 → 三段摘要变化 → 签名变化。

要字节级复现，必须同时满足：同一份内容、同一套压缩实现、同一组时间戳、同一把私钥。

### 9.6 可行性矩阵

| 目标 | 可行性 | 说明 |
|---|---|---|
| 改内容但保留原签名块字节 | 不可能 | 哈希覆盖全部结构，无私钥无法生成新签名 |
| 改内容 + 沿用原证书重签 | 可行 | 需持有该证书私钥；签名值不同，证书身份相同 |
| 让包"看起来是官方构建" | 部分可行 | ZIP 注释、`packageInfo`、`build.txt` 都可原样保留；但 CERT 与签名块必然重写 |
| 用原发布者的签名发布修改版 | 不可行 | 等价于拿到发布者私钥；没有技术绕道 |
| 绕过校验 | 不成立 | 设备端做的是"包内自洽校验"，自签即可通过，无需伪造 |

真正需要"保留签名"的场景（例如持续维护一个开源项目），正确做法是**保管好原来的私钥**，每次发布用同一张证书重签——用户看到的证书不变，升级路径不断。
