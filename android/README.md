# RPK Studio · 原生外壳

Tauri 2 + Rust 的 Android 客户端。界面复用仓库根目录的同一份网页资源，
Rust 只负责网页做不了的三件事：**用系统文件管理器选保存位置**、**调系统分享面板**、**算整包摘要**。

## 已在本地构建出 APK

```
android/src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk
126 MB · arm64-v8a · minSdk 24 · targetSdk 37
package io.github.hrk666666.rpkstudio · versionName 2.1.0
签名：Android Debug（apksigner 校验通过）
```

前端资源被 Tauri 编译进 `librpk_studio_lib.so`，不在 `assets/` 里；
用 `strings` 能在 .so 中找到 `index.html`、`/assets/md3.css` 等清单项。

debug 包体积偏大是因为未 strip 且带调试信息；`--release` 会明显缩小，但需要签名配置。

## 三个命令

| 命令 | 作用 |
|---|---|
| `save_bytes` | 调系统文件管理器（SAF / `ACTION_CREATE_DOCUMENT`）选位置，再用 fs 插件写入。`content://` URI 通过 ContentResolver 打开文件描述符，**不需要存储权限** |
| `share_bytes` | 写入应用缓存目录后交给系统「打开方式」，由系统列出可接收的应用 |
| `summarize` | 纯 std 实现：整包 SHA-256、条目数、图片数，用于导出后核对 |

这三个命令签名验证不重复实现，仍由前端 WebCrypto 完成。

## 构建（Ubuntu 实测）

```bash
# 1. Rust 依赖走镜像（直连 crates.io 会超时）
mkdir -p ~/.cargo && cat > ~/.cargo/config.toml <<'TOML'
[source.crates-io]
replace-with = 'rsproxy-sparse'
[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"
[net]
git-fetch-with-cli = true
TOML

export RUSTUP_DIST_SERVER="https://rsproxy.cn"
rustup target add aarch64-linux-android

# 2. Android SDK 与 NDK
#    commandline-tools + platforms;android-34 + build-tools;34.0.0 + ndk;27.0.12077973
export ANDROID_HOME=/opt/android-sdk
export NDK_HOME=$ANDROID_HOME/ndk/27.0.12077973
export JAVA_HOME=<JDK 17+>

# 3. 前端资产与工程
cd android
npm install
node build-app.mjs
./node_modules/.bin/tauri android init --ci --skip-targets-install
./node_modules/.bin/tauri android build --apk --debug --target aarch64
```

## 踩过的四个坑

1. **Gradle 分发下载卡住**：`services.gradle.org` 只有十几 KB/s，把 `gradle-wrapper.properties` 的 `distributionUrl` 换到 `mirrors.cloud.tencent.com/gradle/` 后 20 秒下完 152 MB。
2. **`~/.gradle/init.gradle` 语法错误**：环境自带一个 `url https://...`（缺 `=` 与引号）和拼错的 `mavelCentral()`，Gradle 直接拒绝启动。重写成合法 Groovy 后通过。
3. **`beforeBuildCommand` 的工作目录不一致**：CLI 调用时是 `android/`，Gradle 的 rust 任务调用时是 `gen/android/`，同一个相对路径无法同时满足。移除该配置，改由外部脚本先生成 `dist`。
4. **Gradle 调不到 CLI**：`rustBuild` 执行 `node src-tauri/tauri ...`，而 CLI 装在 `android/node_modules`。补一个 `src-tauri/tauri` 的 ESM 转发脚本即可（该文件已提交）。

## 本地验证范围

- `cargo check` 通过（仅 dead_code 警告）
- Gradle `assembleArm64Debug` 通过，产出 APK 并用 `apksigner` 验签
- `rpk_core.rs` 用 `rustc --test` 跑过 4 个用例，SHA-256 与 Python / 浏览器一致
- **未做真机安装**：沙箱没有设备，SAF 与分享的实际交互需要你在手机上确认

## 目录

```
android/
├── build-app.mjs          复制 ../index.html 与 assets 到 dist
├── package.json           @tauri-apps/cli
└── src-tauri/
    ├── tauri              Gradle 调用的 CLI 转发脚本
    ├── tauri.conf.json    frontendDist: ../dist
    ├── capabilities/      core / dialog / fs / opener
    └── src/
        ├── lib.rs         save_bytes / share_bytes / summarize
        ├── main.rs
        └── rpk_core.rs    纯 std：SHA-256、ZIP 中央目录、PNG 尺寸
```
