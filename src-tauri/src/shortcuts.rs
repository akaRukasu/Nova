use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs, str::FromStr, sync::Mutex, time::{Duration, Instant}};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Binding {
    action: String,
    accelerator: String,
}

#[derive(Default)]
pub struct Shortcuts {
    bindings: Vec<Binding>,
    errors: Vec<String>,
    recording_until: Option<Instant>,
}

#[derive(Serialize)]
pub struct Snapshot {
    bindings: Vec<Binding>,
    errors: Vec<String>,
}

fn validate(bindings: &[Binding]) -> Result<Vec<Shortcut>, String> {
    if bindings.len() > 30 { return Err("30 raccourcis maximum.".into()); }
    let mut ids = HashSet::new();
    bindings.iter().map(|b| {
        if !matches!(b.action.as_str(), "panel" | "TOGGLE_MUTE" | "TOGGLE_DEAFEN" | "TOGGLE_STREAMER_MODE" | "TOGGLE_VOICE_MODE" | "stopSounds")
            && !(b.action.starts_with("sound:") && b.action.len() <= 100) {
            return Err("Action de raccourci inconnue.".into());
        }
        let key = Shortcut::from_str(&b.accelerator).map_err(|_| "Combinaison de touches invalide.")?;
        if !ids.insert(key.id()) { return Err("Deux raccourcis utilisent les mêmes touches.".into()); }
        Ok(key)
    }).collect()
}

fn register(app: &AppHandle, bindings: &[Binding]) -> Vec<String> {
    let mut errors = Vec::new();
    for binding in bindings {
        match Shortcut::from_str(&binding.accelerator) {
            Ok(shortcut) => if let Err(error) = app.global_shortcut().register(shortcut) {
                errors.push(format!("{} : indisponible ({error})", binding.accelerator));
            },
            Err(_) => errors.push(format!("{} : touches invalides", binding.accelerator)),
        }
    }
    errors
}

pub fn init(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let defaults = vec![
        Binding { action: "panel".into(), accelerator: "Ctrl+Alt+KeyN".into() },
        Binding { action: "TOGGLE_MUTE".into(), accelerator: "Ctrl+Shift+KeyM".into() },
        Binding { action: "TOGGLE_DEAFEN".into(), accelerator: "Ctrl+Shift+KeyD".into() },
    ];
    let path = app.path().app_config_dir()?.join("shortcuts.json");
    let mut errors = Vec::new();
    let bindings = match fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice::<Vec<Binding>>(&bytes) {
            Ok(saved) if validate(&saved).is_ok() => saved,
            _ => { errors.push("Fichier de raccourcis illisible : valeurs par défaut chargées.".into()); defaults }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => defaults,
        Err(error) => { errors.push(format!("Lecture des raccourcis impossible : {error}")); defaults }
    };
    errors.extend(register(app, &bindings));
    *app.state::<Mutex<Shortcuts>>().lock().unwrap() = Shortcuts { bindings, errors, recording_until: None };
    Ok(())
}

pub fn handle(app: &AppHandle, shortcut: &Shortcut, event: ShortcutState) {
    if event != ShortcutState::Pressed { return; }
    let state = app.state::<Mutex<Shortcuts>>();
    let Ok(state) = state.lock() else { return };
    let recording = state.recording_until.is_some_and(|until| Instant::now() < until);
    let binding = state.bindings.iter().find(|b| Shortcut::from_str(&b.accelerator).is_ok_and(|s| s.id() == shortcut.id()));
    let Some(binding) = binding else { return };
    let value = if recording { &binding.accelerator } else { &binding.action };
    let value = serde_json::to_string(value).unwrap();
    let method = if recording { "captureShortcut" } else { "runShortcut" };
    let show = !recording && binding.action == "panel";
    drop(state);
    if show { super::show_main(app); }
    if let Some(window) = app.get_webview_window(super::MAIN) {
        let _ = window.eval(format!("window.NovaCord?.{method}({value})"));
    }
}

#[tauri::command]
pub fn get_shortcuts(state: State<'_, Mutex<Shortcuts>>) -> Result<Snapshot, String> {
    let state = state.lock().map_err(|_| "Réglages indisponibles.")?;
    Ok(Snapshot { bindings: state.bindings.clone(), errors: state.errors.clone() })
}

#[tauri::command]
pub fn set_shortcut_recording(active: bool, state: State<'_, Mutex<Shortcuts>>) -> Result<(), String> {
    state.lock().map_err(|_| "Réglages indisponibles.")?.recording_until = active.then(|| Instant::now() + Duration::from_secs(30));
    Ok(())
}

#[tauri::command]
pub fn set_shortcuts(app: AppHandle, bindings: Vec<Binding>, state: State<'_, Mutex<Shortcuts>>) -> Result<Snapshot, String> {
    validate(&bindings)?;
    let mut state = state.lock().map_err(|_| "Réglages indisponibles.")?;
    app.global_shortcut().unregister_all().map_err(|e| e.to_string())?;
    let errors = register(&app, &bindings);
    let persist = || -> Result<(), String> {
        let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let temp = dir.join("shortcuts.json.tmp");
        fs::write(&temp, serde_json::to_vec_pretty(&bindings).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        fs::rename(temp, dir.join("shortcuts.json")).map_err(|e| e.to_string())
    };
    let result = if errors.is_empty() { persist() } else { Err(errors.join("\n")) };
    if let Err(error) = result {
        let _ = app.global_shortcut().unregister_all();
        state.errors = register(&app, &state.bindings);
        return Err(error);
    }
    state.bindings = bindings;
    state.errors.clear();
    state.recording_until = None;
    Ok(Snapshot { bindings: state.bindings.clone(), errors: vec![] })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_duplicate_keys_and_untrusted_actions() {
        let binding = |action: &str, key: &str| Binding { action: action.into(), accelerator: key.into() };
        assert!(validate(&[binding("panel", "Ctrl+Alt+KeyN")]).is_ok());
        assert!(validate(&[binding("panel", "Ctrl+Alt+KeyN"), binding("TOGGLE_MUTE", "Alt+Ctrl+KeyN")]).is_err());
        assert!(validate(&[binding("execute", "F8")]).is_err());
        assert!(validate(&[binding("panel", "nonsense")]).is_err());
        assert!(validate(&[binding("sound:123", "F8")]).is_ok());
    }
}
