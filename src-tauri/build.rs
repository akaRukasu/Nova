fn main() {
    let commands = &["get_shortcuts", "set_shortcuts", "set_shortcut_recording"];
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(commands),
    )).expect("impossible de préparer NovaCord");
}
