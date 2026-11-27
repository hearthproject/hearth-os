fn main() {
  // `pick_folder` / `open_external_url` are called from the web UI served over
  // http://127.0.0.1:4317, i.e. a remote origin. Tauri rejects app commands from
  // remote origins unless the command is declared in the app ACL manifest and
  // allowed by a capability.
  tauri_build::try_build(
    tauri_build::Attributes::new()
      .app_manifest(tauri_build::AppManifest::new().commands(&["pick_folder", "open_external_url"])),
  )
  .expect("failed to run tauri-build");
}
