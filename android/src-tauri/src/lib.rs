use std::io::Write;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::{FsExt, OpenOptions};

mod rpk_core;

/// 让用户选位置并写入字节。
///
/// 桌面走系统保存对话框，安卓走 SAF（系统文件管理器），两者都由 dialog 插件发起。
/// 写入统一交给 fs 插件：它同时接受普通路径和安卓的 `content://` URI，
/// 后者通过 ContentResolver 打开文件描述符，因此不需要申请存储权限。
#[tauri::command]
async fn save_bytes(app: AppHandle, name: String, base64: String) -> Result<String, String> {
    let data = STANDARD
        .decode(base64.as_bytes())
        .map_err(|e| format!("数据解码失败：{e}"))?;

    let handle = app.clone();
    let suggested = sanitize(&name);
    let ext = suggested.rsplit('.').next().unwrap_or("rpk").to_string();

    let picked = tauri::async_runtime::spawn_blocking(move || {
        handle
            .dialog()
            .file()
            .set_file_name(&suggested)
            .add_filter("应用包 / 压缩包", &[ext.as_str(), "rpk", "zip"])
            .blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(path) = picked else {
        return Ok(String::new());
    };

    let mut opts = OpenOptions::new();
    opts.write(true).create(true).truncate(true);

    let mut file = app
        .fs()
        .open(path.clone(), opts)
        .map_err(|e| format!("无法打开目标文件：{e}"))?;

    file.write_all(&data)
        .map_err(|e| format!("写入失败：{e}"))?;
    file.flush().map_err(|e| format!("写入失败：{e}"))?;

    Ok(path.to_string())
}

/// 分享：先把内容写到应用缓存，再交给系统「打开方式」，由系统列出可接收的应用。
#[tauri::command]
async fn share_bytes(app: AppHandle, name: String, base64: String) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;

    let data = STANDARD
        .decode(base64.as_bytes())
        .map_err(|e| format!("数据解码失败：{e}"))?;

    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("找不到缓存目录：{e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let path = dir.join(sanitize(&name));
    std::fs::write(&path, &data).map_err(|e| format!("写入失败：{e}"))?;

    app.opener()
        .open_path(path.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("无法打开：{e}"))?;

    Ok(path.to_string_lossy().to_string())
}

/// 结构层面的摘要：条目数、文件数、整包 SHA-256。
/// 用于导出后的快速完整性核对，不替代前端 WebCrypto 的签名验证。
#[tauri::command]
fn summarize(base64: String) -> Result<String, String> {
    let data = STANDARD
        .decode(base64.as_bytes())
        .map_err(|e| format!("数据解码失败：{e}"))?;
    let s = rpk_core::summarize(&data)?;
    Ok(format!(
        r#"{{"size":{},"sha256":"{}","entries":{},"files":{},"images":{},"hasManifest":{},"hasCert":{}}}"#,
        s.size, s.sha256, s.entries, s.files, s.images, s.has_manifest, s.has_cert
    ))
}

fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || "-_. ".contains(c) { c } else { '_' })
        .collect();
    if cleaned.is_empty() {
        "rpk-output.rpk".into()
    } else {
        cleaned
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![save_bytes, share_bytes, summarize])
        .run(tauri::generate_context!())
        .expect("启动失败");
}
