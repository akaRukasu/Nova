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
        if action["action"] == "network-access" {
            return request_network_access(handle.state::<Arc<Service>>().port());
        }
        let window = handle.get_webview_window(crate::MAIN).ok_or("Discord n'est pas ouvert.")?;
        window.eval(format!("window.NovaCordRemote?.execute({})", action)).map_err(|e| e.to_string())
    }))?;
    let mut builder = WebviewWindowBuilder::new(app, "soundboard", WebviewUrl::External(url.parse().map_err(|_| "Adresse de la soundboard invalide.")?));
    if std::env::args().any(|arg| arg == "--smoke-soundboard") {
        builder = builder.initialization_script(r#"
            const importProbe = setInterval(() => {
                const input = document.getElementById('file');
                if (!input || document.getElementById('app').classList.contains('hidden')) return;
                clearInterval(importProbe);
                const wav = new ArrayBuffer(44 + 1600), view = new DataView(wav);
                const text = (offset, value) => [...value].forEach((c,i) => view.setUint8(offset+i,c.charCodeAt(0)));
                text(0,'RIFF'); view.setUint32(4,wav.byteLength-8,true); text(8,'WAVEfmt ');
                view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
                view.setUint32(24,8000,true); view.setUint32(28,16000,true); view.setUint16(32,2,true); view.setUint16(34,16,true);
                text(36,'data'); view.setUint32(40,1600,true);
                const transfer = new DataTransfer(); transfer.items.add(new File([wav],'novacord-smoke.wav',{type:'audio/wav'}));
                input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true}));
            },250);
        "#);
    }
    builder
        // WebView2 shares the browser process: environment options must match Discord's.
        .additional_browser_args(crate::BROWSER_ARGS)
        .disable_drag_drop_handler()
        .title("NovaCord · Soundboard").inner_size(1180.0, 820.0).min_inner_size(720.0, 560.0)
        .background_color(tauri::window::Color(0x10, 0x11, 0x17, 0xff))
        .on_navigation(|url| url.scheme() == "http" && url.host_str() == Some("127.0.0.1"))
        .on_new_window(|url,_| {
            if url.scheme() == "https" && matches!(url.host_str(),Some("www.myinstants.com" | "myinstants.com")) { crate::open_external(&url); }
            tauri::webview::NewWindowResponse::Deny
        })
        .build().map_err(|e| e.to_string())?;
    Ok(())
}

fn request_network_access(port: u16) -> Result<(), String> {
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe = exe.to_str().ok_or("Chemin NovaCord invalide.")?;
        // Only this executable, this TCP port, private networks and the local subnet.
        let args = format!("advfirewall firewall add rule name=\"NovaCord Soundboard\" dir=in action=allow protocol=TCP localport={port} program=\"{exe}\" profile=private remoteip=LocalSubnet");
        let script = format!("Start-Process -FilePath \"$env:SystemRoot\\System32\\netsh.exe\" -Verb RunAs -ArgumentList '{}'", args.replace('\'', "''"));
        std::process::Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(0x08000000).spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))] { let _ = port; Err("Autorise NovaCord dans le pare-feu de ce PC.".into()) }
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
