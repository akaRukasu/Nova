use crate::remote_server::{Board, Service};
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

pub fn show(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("soundboard") {
        let _ = window.unminimize(); let _ = window.show(); let _ = window.set_focus(); return Ok(());
    }
    let service = app.state::<Arc<Service>>().inner().clone();
    let handle = app.clone();
    let url = service.start(Arc::new(move |action: Value| {
        let window = handle.get_webview_window(crate::MAIN).ok_or("Discord n'est pas ouvert.")?;
        window.eval(format!("window.NovaCordRemote?.execute({})", action)).map_err(|e| e.to_string())
    }))?;
    WebviewWindowBuilder::new(app, "soundboard", WebviewUrl::External(url.parse().map_err(|_| "Adresse de la soundboard invalide.")?))
        .title("NovaCord · Soundboard").inner_size(1180.0, 820.0).min_inner_size(720.0, 560.0)
        .background_color(tauri::window::Color(0x10, 0x11, 0x17, 0xff))
        .on_navigation(|url| url.scheme() == "http" && url.host_str() == Some("127.0.0.1"))
        .build().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn open_soundboard(app: AppHandle) -> Result<(), String> { show(&app) }

#[tauri::command]
pub fn sync_soundboard(board: Board, service: State<'_, Arc<Service>>) -> Result<(), String> { service.sync(board) }

#[tauri::command]
pub fn complete_soundboard_command(request_id: String, error: Option<String>, service: State<'_, Arc<Service>>) {
    service.complete(&request_id, error);
}

#[tauri::command]
pub fn take_soundboard_upload(id: String, service: State<'_, Arc<Service>>) -> Result<tauri::ipc::Response, String> {
    service.take_upload(&id).map(tauri::ipc::Response::new)
}
