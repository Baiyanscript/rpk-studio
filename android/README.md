# RPK Studio · 原生外壳

Tauri 2 + Rust 的 Android 客户端。界面复用仓库根目录的同一份网页资源，
Rust 只负责网页做不了的两件事：把导出的文件写到系统、把结果交给系统面板。

## 结构

```
android/
├── build-app.mjs          把 ../index.html 与 assets 复制到 dist
├── package.json           @tauri-apps/cli
├── dist/                  构建时生成，Tauri 的 frontendDist
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── capabilities/      权限：core / dialog / opener
    └── src/
        ├── main.rs
        ├── lib.rs         save_bytes / summarize 两个命令
        └── rpk_core.rs    纯 std：SHA-256、ZIP 中央目录、PNG 尺寸
```

## 职责边界

| 层 | 负责 |
|---|---|
| WebView（同一份 `assets/bundle.js`） | 解析、验签、改包、图片处理、界面 |
| Rust | 写入文件、调用系统保存/分享面板、整包 SHA-256 与结构摘要 |

签名验证仍走 WebCrypto。Rust 侧不重复实现 RSA 与 DEFLATE，避免两套实现出现行为差异。

## 保存路径

- **桌面**：`save_bytes` 弹系统保存对话框，写到用户选的位置。
- **Android**：写到应用缓存目录，再通过 `opener` 触发系统「打开方式」，
  由用户选择存到「文件」或分享到别处。这样可以避开 Scoped Storage 的写入限制，
  也不需要申请存储权限。

## 构建

需要 Rust 1.77+、Node 20+、Android SDK 34、NDK 27、JDK 17。

```bash
cd android
npm install
node build-app.mjs          # 生成 dist
npx tauri android init      # 首次生成 gen/android
npx tauri android build --apk --debug --target aarch64
```

产物在 `src-tauri/gen/android/app/build/outputs/apk/`。

也可以直接用仓库里的 GitHub Actions（`.github/workflows/android.yml`），
在 Actions 页面手动触发，产物作为 artifact 下载。

## 本地验证状态

沙箱环境无法访问 crates.io，也无法安装 Android SDK，因此 Tauri 外壳没有在本地编译。
`rpk_core.rs` 是纯标准库实现，已用 `rustc --test` 单独编译并跑过 4 个用例：

```
test tests::sha256_known_vectors ... ok
test tests::sha256_long_input ... ok
test tests::png_size_reads_ihdr ... ok
test tests::central_directory_parses_real_package ... ok
包摘要：211 项 / 154 文件 / 101 图片 / sha256 66aa8c9209b9d075
```

SHA-256 与 Python/浏览器算出的 `66aa8c92…` 一致，中央目录解析出的条目数与样例包吻合。
外壳部分（Tauri 配置、命令、权限）按 Tauri 2 的约定编写，首次 CI 构建可能需要按报错微调。
