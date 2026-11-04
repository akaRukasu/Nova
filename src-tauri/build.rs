fn main() {
    let commands = &["get_shortcuts", "set_shortcuts", "set_shortcut_recording", "open_soundboard", "sync_soundboard", "complete_soundboard_command", "take_soundboard_upload"];
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(commands),
    )).expect("impossible de préparer NovaCord");
}
