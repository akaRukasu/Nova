// Pas de console noire derrière la fenêtre en version finale.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod shortcuts;
mod remote_server;
mod soundboard;
mod myinstants;
use std::{fs, io, sync::{Arc, Mutex}};

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::{NewWindowResponse, PermissionKind, PermissionResponse},
    AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};

const MAIN: &str = "main";
const MAIN_EXTENSIONS: &str = "main-extensions";
const START_URL: &str = "https://discord.com/app";
const APP_NAME: &str = "Voxcord Web";
const EXTENSIONS_MARKER: &str = "extensions-enabled";

/// Couche de mods injectée dans Discord avant ses propres scripts.
const MOD_SCRIPT: &str = include_str!("../../mod/novacord.js");
const VENCORD_SCRIPT: &str = include_str!("../../mod/vencord.bundle.js");
const AUDIO_SCRIPT: &str = include_str!("../../mod/soundboard.js");
const MEDIA_SCRIPT: &str = include_str!("../../mod/media.js");
const REMOTE_SCRIPT: &str = include_str!("../../mod/remote-bridge.js");

/// Both extension windows share the same WebView2 environment for audio playback.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI --autoplay-policy=no-user-gesture-required";
const STANDARD_BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI";

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN).or_else(|| app.get_webview_window(MAIN_EXTENSIONS))
}

fn set_extensions(app: &AppHandle, enabled: bool) -> Result<(), Box<dyn std::error::Error>> {
    let config = app.path().app_config_dir()?;
    let marker = config.join(EXTENSIONS_MARKER);
    if enabled {
        fs::create_dir_all(config)?;
        fs::write(marker, b"")?;
    } else if let Err(error) = fs::remove_file(marker) {
        if error.kind() != io::ErrorKind::NotFound {
            return Err(error.into());
        }
    }
    Ok(())
}

fn is_discord(url: &Url) -> bool {
    if url.scheme() == "about" || url.scheme() == "data" || url.scheme() == "blob" {
        return true;
    }
    if url.scheme() != "https" {
        return false;
    }
    match url.host_str() {
        Some(h) => {
            ["discord.com", "discordapp.com", "discord.gg", "discord.new"]
                .iter()
                .any(|d| h == *d || h.ends_with(&format!(".{d}")))
        }
        None => false,
    }
}

/// Les liens externes s'ouvrent dans le navigateur par défaut, pas dans l'appli.
fn open_external(url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto" | "steam" | "spotify") {
        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
    }
}

/// Demande à WebView2 de libérer un maximum de mémoire quand la fenêtre
/// est cachée ou réduite. Le vocal et les notifications continuent de marcher.
#[cfg(windows)]
fn set_low_memory(window: &WebviewWindow, low: bool) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static LOW: AtomicBool = AtomicBool::new(false);
    // Évite de rappeler WebView2 à chaque pixel pendant un redimensionnement.
    if LOW.swap(low, Ordering::Relaxed) == low {
        return;
    }
    let _ = window.with_webview(move |pw| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        use windows_core::Interface;
        if let Ok(core) = pw.controller().CoreWebView2() {
            if let Ok(core19) = core.cast::<ICoreWebView2_19>() {
                let level = if low {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
                } else {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
                };
                let _ = core19.SetMemoryUsageTargetLevel(level);
            }
        }
    });
}

#[cfg(not(windows))]
fn set_low_memory(_window: &WebviewWindow, _low: bool) {}

/// Hide browser chrome in the app window and leave reputation checks enabled.
#[cfg(windows)]
fn tune_webview(window: &WebviewWindow) {
    let _ = window.with_webview(|pw| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        use windows_core::Interface;
        let Ok(core) = pw.controller().CoreWebView2() else { return };
        let Ok(settings) = core.Settings() else { return };
        let _ = settings.SetIsStatusBarEnabled(false.into());
        let _ = settings.SetIsBuiltInErrorPageEnabled(true.into());
        if let Ok(s4) = settings.cast::<ICoreWebView2Settings4>() {
            let _ = s4.SetIsGeneralAutofillEnabled(false.into());
            let _ = s4.SetIsPasswordAutosaveEnabled(false.into());
        }
        if let Ok(s6) = settings.cast::<ICoreWebView2Settings6>() {
            let _ = s6.SetIsSwipeNavigationEnabled(false.into());
        }
    });
}

#[cfg(not(windows))]
fn tune_webview(_window: &WebviewWindow) {}

fn show_main(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        set_low_memory(&w, false);
    }
}

fn hide_main(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        let _ = w.hide();
        set_low_memory(&w, true);
    }
}

fn toggle_main(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        if w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false) {
            hide_main(app);
        } else {
            show_main(app);
        }
    }
}

fn open_mod_panel(app: &AppHandle) {
    show_main(app);
    if let Some(w) = app.get_webview_window(MAIN_EXTENSIONS) {
        let _ = w.eval("window.NovaCord && window.NovaCord.openPanel()");
    }
}

fn build_tray(app: &AppHandle, extensions: bool) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Afficher Voxcord Web", true, None::<&str>)?;
    let panel = MenuItem::with_id(app, "panel", "Paramètres Voxcord", extensions, None::<&str>)?;
    let soundboard = MenuItem::with_id(app, "soundboard", "Soundboard et télécommande", extensions, None::<&str>)?;
    let mode_label = if extensions {
        "Désactiver les extensions et redémarrer"
    } else {
        "Activer les extensions non officielles et redémarrer"
    };
    let mode = MenuItem::with_id(app, "extensions", mode_label, true, None::<&str>)?;
    let reload = MenuItem::with_id(app, "reload", "Recharger", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &soundboard, &panel, &mode, &reload, &sep, &quit])?;

    let mut tray = TrayIconBuilder::with_id("tray")
        .tooltip(APP_NAME)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "panel" if extensions => open_mod_panel(app),
            "soundboard" if extensions => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move { if let Err(error) = soundboard::show(&app) { eprintln!("{error}"); } });
            },
            "reload" => {
                if let Some(w) = main_window(app) {
                    let _ = w.eval("location.reload()");
                }
            }
            "extensions" => {
                if let Err(error) = set_extensions(app, !extensions) {
                    eprintln!("Impossible d’enregistrer le mode Extensions : {error}");
                    if let Some(tray) = app.tray_by_id("tray") {
                        let _ = tray.set_tooltip(Some("Voxcord Web — impossible d’enregistrer les extensions"));
                    }
                } else {
                    app.request_restart();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn build_main_window(app: &AppHandle, start_hidden: bool, extensions: bool) -> tauri::Result<WebviewWindow> {
    let label = if extensions { MAIN_EXTENSIONS } else { MAIN };
    let mut builder = WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::External(START_URL.parse().expect("URL valide")),
    )
    .title(APP_NAME)
    .inner_size(1280.0, 800.0)
    .min_inner_size(940.0, 500.0)
    .center()
    .visible(!start_hidden)
    .background_color(tauri::window::Color(0x31, 0x33, 0x38, 0xff))
    .additional_browser_args(if extensions { BROWSER_ARGS } else { STANDARD_BROWSER_ARGS })
    // Indispensable pour glisser-déposer des fichiers dans Discord.
    .disable_drag_drop_handler()
    .on_navigation(|url| {
        if is_discord(url) {
            true
        } else {
            open_external(url);
            false
        }
    })
    .on_new_window(|url, _features| {
        open_external(&url);
        NewWindowResponse::Deny
    })
    .on_permission_request(|url, kind| {
        let discord_origin = url.scheme() == "https"
            && url.host_str() == Some("discord.com")
            && url.port_or_known_default() == Some(443);
        if discord_origin && matches!(kind, PermissionKind::Microphone | PermissionKind::Camera) {
            PermissionResponse::Allow
        } else {
            PermissionResponse::Default
        }
    })
    .on_document_title_changed(|window, title| {
        // Preserve the unread count from Discord's web title.
        let branded = if title.contains("Discord") { title.replacen("Discord", APP_NAME, 1) } else { APP_NAME.into() };
        let _ = window.set_title(&branded);
    });
    if extensions {
        builder = builder
            .initialization_script(MEDIA_SCRIPT)
            .initialization_script(AUDIO_SCRIPT)
            .initialization_script(VENCORD_SCRIPT)
            .initialization_script(MOD_SCRIPT)
            .initialization_script(REMOTE_SCRIPT);
    }
    let window = builder.build()?;

    tune_webview(&window);
    if start_hidden {
        set_low_memory(&window, true);
    }
    Ok(window)
}

fn main() {
    let start_hidden = std::env::args().any(|a| a == "--minimized");
    let smoke_soundboard = std::env::args().any(|a| a == "--smoke-soundboard");

    tauri::Builder::default()
        .manage(Mutex::new(shortcuts::Shortcuts::default()))
        .manage(Arc::new(remote_server::Service::new()))
        .invoke_handler(tauri::generate_handler![shortcuts::get_shortcuts, shortcuts::set_shortcuts, shortcuts::set_shortcut_recording,
            soundboard::open_soundboard, soundboard::sync_soundboard, soundboard::complete_soundboard_command, soundboard::take_soundboard_upload])
        .plugin(tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, shortcut, event| shortcuts::handle(app, shortcut, event.state()))
            .build())
        // Une seule instance : relancer l'appli remet la fenêtre au premier plan.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .setup(move |app| {
            let extensions = smoke_soundboard || app.path().app_config_dir()?.join(EXTENSIONS_MARKER).is_file();
            if extensions {
                shortcuts::init(app.handle())?;
            }
            build_tray(app.handle(), extensions)?;
            build_main_window(app.handle(), start_hidden, extensions)?;
            if smoke_soundboard {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let result = soundboard::show(&handle);
                    if let Err(error) = &result { eprintln!("Soundboard WebView2 smoke test: {error}"); }
                    if result.is_err() { handle.exit(1); return; }
                    tauri::async_runtime::spawn_blocking(move || {
                        for _ in 0..160 {
                            if handle.state::<Arc<remote_server::Service>>().has_sound("novacord-smoke.wav") {
                                handle.exit(0); return;
                            }
                            std::thread::sleep(std::time::Duration::from_millis(250));
                        }
                        eprintln!("Soundboard smoke test: imported audio never appeared in the native catalog.");
                        handle.exit(1);
                    });
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Fermer la fenêtre la range dans la zone de notification.
            WindowEvent::CloseRequested { api, .. } if matches!(window.label(), MAIN | MAIN_EXTENSIONS) => {
                api.prevent_close();
                hide_main(window.app_handle());
            }
            WindowEvent::Resized(_) if matches!(window.label(), MAIN | MAIN_EXTENSIONS) => {
                if let Some(w) = main_window(window.app_handle()) {
                    let minimized = w.is_minimized().unwrap_or(false);
                    set_low_memory(&w, minimized);
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("impossible de démarrer Voxcord Web")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) { app.state::<Arc<remote_server::Service>>().shutdown(); }
        });
}
