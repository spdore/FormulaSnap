mod api;
mod codex;
mod local;
mod state;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{DynamicImage, ImageFormat};
use serde::Serialize;
use std::io::{Cursor, Write};
use tauri::{AppHandle, Manager};
use state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CapturedScreen {
    id: String,
    name: String,
    width: u32,
    height: u32,
    image_data_url: String,
}

fn png_data_url(image: DynamicImage) -> Result<String, String> {
    let mut output = Cursor::new(Vec::new());
    image.write_to(&mut output, ImageFormat::Png).map_err(|e| format!("编码图片失败：{e}"))?;
    Ok(format!("data:image/png;base64,{}", STANDARD.encode(output.into_inner())))
}

#[tauri::command]
fn load_image_from_path(path: String) -> Result<String, String> {
    let file = std::path::Path::new(&path);
    if !file.is_file() { return Err("选择的图片文件不存在或不可读取。".into()); }
    let image = image::open(file).map_err(|_| "图片格式不支持或文件已损坏；请使用 PNG、JPEG、WebP、BMP 或 TIFF。")?;
    png_data_url(image)
}

fn capture_monitors() -> Result<Vec<CapturedScreen>, String> {
    let monitors = xcap::Monitor::all().map_err(|e| format!("获取显示器列表失败：{e}"))?;
    if monitors.is_empty() { return Err("系统没有检测到可截图的显示器。".into()); }
    let mut screens = Vec::with_capacity(monitors.len());
    for (index, monitor) in monitors.into_iter().enumerate() {
        let name = monitor.friendly_name().unwrap_or_else(|_| format!("显示器 {}", index + 1));
        let width = monitor.width().map_err(|e| format!("读取显示器尺寸失败：{e}"))?;
        let height = monitor.height().map_err(|e| format!("读取显示器尺寸失败：{e}"))?;
        let image = monitor.capture_image().map_err(|e| format!("截取 {name} 失败；macOS 首次使用需允许屏幕录制权限：{e}"))?;
        let image_data_url = png_data_url(DynamicImage::ImageRgba8(image))?;
        screens.push(CapturedScreen { id: format!("monitor-{index}"), name, width, height, image_data_url });
    }
    Ok(screens)
}

#[tauri::command]
fn record_diagnostic_log(app: AppHandle, category: String, message: String) -> Result<(), String> {
    let root = local::app_root(&app)?;
    local::write_frontend_diagnostic(&root, &category, &message);
    Ok(())
}
#[tauri::command]
fn save_word_document(path: String, document_base64: String) -> Result<u64, String> {
    let destination = std::path::PathBuf::from(path);
    if !destination.is_absolute() {
        return Err("保存 DOCX 失败：所选目标路径不是绝对路径。".into());
    }
    if !destination.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("docx")) {
        return Err("保存 DOCX 失败：请选择 .docx 文件。".into());
    }
    let bytes = STANDARD.decode(document_base64).map_err(|_| "DOCX 数据无效，无法保存。")?;
    if bytes.is_empty() || bytes.len() > 64 * 1024 * 1024 {
        return Err("DOCX 内容为空或超过 64 MiB 限制。".into());
    }
    let parent = destination.parent().ok_or("所选 DOCX 路径没有父目录。")?;
    if !parent.is_dir() {
        return Err("保存 DOCX 失败：所选目录不存在或不可访问。".into());
    }
    let mut file = std::fs::OpenOptions::new().create(true).truncate(true).write(true)
        .open(&destination).map_err(|error| format!("无法写入所选 DOCX 文件：{error}"))?;
    file.write_all(&bytes).map_err(|error| format!("写入 DOCX 内容失败：{error}"))?;
    file.flush().map_err(|error| format!("刷新 DOCX 文件失败：{error}"))?;
    let length = file.metadata().map_err(|error| format!("检查 DOCX 保存结果失败：{error}"))?.len();
    if length != bytes.len() as u64 {
        return Err("DOCX 保存校验失败：写入大小与公式文档不一致。".into());
    }
    Ok(length)
}
#[tauri::command]
async fn capture_screens(app: AppHandle) -> Result<Vec<CapturedScreen>, String> {
    let window = app.get_webview_window("main");
    if let Some(window) = &window { window.hide().map_err(|e| format!("暂时隐藏 FormulaSnap 以便截图失败：{e}"))?; }
    tokio::time::sleep(std::time::Duration::from_millis(180)).await;
    let result = tokio::task::spawn_blocking(capture_monitors).await;
    if let Some(window) = window {
        let _ = window.show();
        let _ = window.set_focus();
    }
    match result {
        Ok(capture) => capture,
        Err(error) => Err(format!("截图任务异常：{error}")),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .setup(|app| {
            let _runtime_root = local::app_root(app.handle()).map_err(std::io::Error::other)?;
            let window = tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .data_directory(local::profile_root(app.handle()).map_err(std::io::Error::other)?.join("webview"));
            window.build()?;
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            load_image_from_path,
            save_word_document,
            record_diagnostic_log,
            capture_screens,
            api::has_api_key,
            api::store_api_key,
            api::delete_api_key,
            api::recognize_online,
            api::cancel_recognition,
            api::test_api_service,
            codex::check_codex_cli,
            codex::recognize_codex,
            local::check_local_model,
            local::get_local_settings,
            local::save_local_settings,
            local::download_local_model,
            local::install_local_runtime,
            local::setup_local_model,
            local::rebuild_local_environment,
            local::load_local_model,
            local::unload_local_model,
            local::delete_local_model,
            local::recognize_local
        ])
        .build(tauri::generate_context!())
        .expect("FormulaSnap failed to build")
        .run(|app_handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    if let Ok(tasks) = state.cancellations.lock() {
                        for token in tasks.values() { token.cancel(); }
                    }
                }
                local::terminate_managed_processes();
                local::release_runtime_mount();
            }
        });
}
