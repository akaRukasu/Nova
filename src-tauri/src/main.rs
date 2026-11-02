// Pas de console noire derrière la fenêtre en version finale.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod shortcuts;
use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::{NewWindowResponse, PermissionKind, PermissionResponse},
    AppHandle, Manager, Url, UserAttentionType, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};

const MAIN: &str = "main";
const START_URL: &str = "https://discord.com/app";

/// Couche de mods injectée dans Discord avant ses propres scripts.
const MOD_SCRIPT: &str = include_str!("../../mod/novacord.js");
const VENCORD_SCRIPT: &str = include_str!("../../mod/vencord.bundle.js");
const AUDIO_SCRIPT: &str = include_str!("../../mod/soundboard.js");
const MEDIA_SCRIPT: &str = include_str!("../../mod/media.js");

/// Options du moteur WebView2 (Chromium d'Edge déjà présent sur Windows).
/// Les trois premières désactivations sont celles que Tauri met par défaut ;
/// les suivantes coupent des services d'Edge inutiles ici.
const BROWSER_ARGS: &str = concat!(
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,",
    "msEdgeTranslate,msShoppingExp,msEdgeCollections,msImplicitSignin,",
    "msEdgeAutofillShowInlineFeedback,AutofillServerCommunication,",
    "OptimizationHints,MediaRouter,Translate ",
    "--autoplay-policy=no-user-gesture-required ",
    "--disable-background-networking ",
    "--disable-component-update ",
    "--disable-domain-reliability ",
    "--no-pings"
);

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

/// Coupe les fonctions d'Edge qui consomment pour rien (barre d'état,
/// saisie automatique, enregistrement des mots de passe, SmartScreen…).
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
        if let Ok(s8) = settings.cast::<ICoreWebView2Settings8>() {
            let _ = s8.SetIsReputationCheckingRequired(false.into());
        }
    });
}

#[cfg(not(windows))]
fn tune_webview(_window: &WebviewWindow) {}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        set_low_memory(&w, false);
    }
}

fn hide_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.hide();
        set_low_memory(&w, true);
    }
}

fn toggle_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        if w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false) {
            hide_main(app);
        } else {
            show_main(app);
        }
    }
}

fn open_mod_panel(app: &AppHandle) {
    show_main(app);
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.eval("window.NovaCord && window.NovaCord.openPanel()");
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Afficher NovaCord", true, None::<&str>)?;
    let panel = MenuItem::with_id(app, "panel", "Paramètres NovaCord", true, None::<&str>)?;
    let reload = MenuItem::with_id(app, "reload", "Recharger", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &panel, &reload, &sep, &quit])?;

    let mut tray = TrayIconBuilder::with_id("tray")
        .tooltip("NovaCord")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "panel" => open_mod_panel(app),
            "reload" => {
                if let Some(w) = app.get_webview_window(MAIN) {
                    let _ = w.eval("location.reload()");
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

fn build_main_window(app: &AppHandle, start_hidden: bool) -> tauri::Result<WebviewWindow> {
    let window = WebviewWindowBuilder::new(
        app,
        MAIN,
        WebviewUrl::External(START_URL.parse().expect("URL valide")),
    )
    .title("NovaCord")
    .inner_size(1280.0, 800.0)
    .min_inner_size(940.0, 500.0)
    .center()
    .visible(!start_hidden)
    .background_color(tauri::window::Color(0x31, 0x33, 0x38, 0xff))
    .additional_browser_args(BROWSER_ARGS)
    // Indispensable pour glisser-déposer des fichiers dans Discord.
    .disable_drag_drop_handler()
    .initialization_script(MEDIA_SCRIPT)
    .initialization_script(AUDIO_SCRIPT)
    .initialization_script(VENCORD_SCRIPT)
    .initialization_script(MOD_SCRIPT)
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
    .on_permission_request(|_, kind| match kind {
        // Seul Discord est chargé (les autres pages sont bloquées plus haut).
        PermissionKind::Microphone
        | PermissionKind::Camera
        | PermissionKind::Notifications
        | PermissionKind::ClipboardRead
        | PermissionKind::Autoplay => PermissionResponse::Allow,
        _ => PermissionResponse::Default,
    })
    .on_document_title_changed(|window, title| {
        // Discord met « (3) Discord » quand on a des mentions non lues.
        let has_mentions = title.starts_with('(');
        let _ = window.set_title(&title.replacen("Discord", "NovaCord", 1));
        if has_mentions && !window.is_focused().unwrap_or(true) {
            let _ = window.request_user_attention(Some(UserAttentionType::Informational));
        }
    })
    .build()?;

    tune_webview(&window);
    if start_hidden {
        set_low_memory(&window, true);
    }
    Ok(window)
}

fn main() {
    let start_hidden = std::env::args().any(|a| a == "--minimized");

    tauri::Builder::default()
        .manage(Mutex::new(shortcuts::Shortcuts::default()))
        .invoke_handler(tauri::generate_handler![shortcuts::get_shortcuts, shortcuts::set_shortcuts, shortcuts::set_shortcut_recording])
        .plugin(tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, shortcut, event| shortcuts::handle(app, shortcut, event.state()))
            .build())
        // Une seule instance : relancer l'appli remet la fenêtre au premier plan.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .setup(move |app| {
            shortcuts::init(app.handle())?;
            build_tray(app.handle())?;
            build_main_window(app.handle(), start_hidden)?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Fermer la fenêtre la range dans la zone de notification.
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                hide_main(window.app_handle());
            }
            WindowEvent::Resized(_) => {
                if let Some(w) = window.app_handle().get_webview_window(MAIN) {
                    let minimized = w.is_minimized().unwrap_or(false);
                    set_low_memory(&w, minimized);
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("impossible de démarrer NovaCord");
}
