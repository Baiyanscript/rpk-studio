use base64::{engine::general_purpose::STANDARD, Engine as _};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

mod rpk_core;

/// 把前端生成的字节写出去。
///
/// 桌面：弹系统保存对话框，写到用户选的位置。
/// 移动端：写到应用缓存目录，再交给系统「打开方式」面板，由用户决定存到哪。
#[tauri::command]
async fn save_bytes(app: AppHandle, name: String, base64: String) -> Result<String, String> {
    let data = STANDARD
        .decode(base64.as_bytes())
        .map_err(|e| format!("数据解码失败：{e}"))?;

    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let dir = app
            .path()
            .app_cache_dir()
            .map_err(|e| format!("找不到缓存目录：{e}"))?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(sanitize(&name));
        std::fs::write(&path, &data).map_err(|e| format!("写入失败：{e}"))?;

        #[cfg(target_os = "android")]
        {
            use tauri_plugin_opener::OpenerExt;
            app.opener()
                .open_path(path.to_string_lossy().to_string(), None::<&str>)
                .map_err(|e| format!("打开失败：{e}"))?;
        }

        return Ok(path.to_string_lossy().to_string());
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let handle = app.clone();
        let suggested = sanitize(&name);
        let picked = tauri::async_runtime::spawn_blocking(move || {
            handle
                .dialog()
                .file()
                .set_file_name(&suggested)
                .add_filter("RPK / ZIP", &["rpk", "zip"])
                .blocking_save_file()
        })
        .await
        .map_err(|e| e.to_string())?;

        let Some(file_path) = picked else {
            return Ok(String::new());
        };
        let path = file_path.into_path().map_err(|e| e.to_string())?;
        std::fs::write(&path, &data).map_err(|e| format!("写入失败：{e}"))?;
        Ok(path.to_string_lossy().to_string())
    }
}

/// 只做结构层面的摘要：条目数、文件数、整包 SHA-256。
/// 用于导出后的快速完整性核对，不替代 WebCrypto 的签名验证。
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
        "rpk-output".into()
    } else {
        cleaned
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![save_bytes, summarize])
        .run(tauri::generate_context!())
        .expect("启动失败");
}
