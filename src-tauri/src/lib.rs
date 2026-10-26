use std::fs;
use std::path::{Path, PathBuf};
use tauri::ipc::Response;

const STORAGE_ROOT: &str = "/tmp/PWA-Islands";

fn get_storage_root() -> Result<PathBuf, String> {
  let root = PathBuf::from(STORAGE_ROOT);
  fs::create_dir_all(&root).map_err(|e| format!("Konnte Speicherordner nicht erstellen: {e}"))?;
  Ok(root)
}

fn resolve_path(rel_path: &str) -> Result<PathBuf, String> {
  let root = get_storage_root()?;
  let clean = rel_path.trim_matches('/');
  let mut resolved = root;
  for part in clean.split('/') {
    let p = part.trim();
    if p.is_empty() || p == "." {
      continue;
    }
    if p == ".." {
      return Err("Ungültiger Pfad: '..' ist nicht erlaubt.".to_string());
    }
    resolved.push(p);
  }
  Ok(resolved)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TauriFileEntry {
  pub name: String,
  pub is_directory: bool,
  pub size: Option<u64>,
  pub last_modified: Option<u64>,
}

#[tauri::command]
fn tauri_fs_list_entries(sub_path: String) -> Result<Vec<TauriFileEntry>, String> {
  let dir = resolve_path(&sub_path)?;
  if !dir.exists() {
    return Ok(Vec::new());
  }
  let entries = fs::read_dir(&dir).map_err(|e| format!("Fehler beim Lesen des Verzeichnisses: {e}"))?;
  let mut result = Vec::new();
  for entry in entries {
    let entry = entry.map_err(|e| format!("Fehler beim Lesen des Eintrags: {e}"))?;
    let path = entry.path();
    let name = entry.file_name().to_string_lossy().to_string();
    let metadata = fs::symlink_metadata(&path).map_err(|e| format!("Fehler bei Metadaten: {e}"))?;
    let is_directory = metadata.is_dir();
    let (size, last_modified) = if is_directory {
      (None, None)
    } else {
      let sz = metadata.len();
      let lm = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
      (Some(sz), lm)
    };
    result.push(TauriFileEntry {
      name,
      is_directory,
      size,
      last_modified,
    });
  }
  Ok(result)
}

#[tauri::command]
fn tauri_fs_read_file(sub_path: String) -> Result<Response, String> {
  let path = resolve_path(&sub_path)?;
  let data = fs::read(&path).map_err(|e| format!("Fehler beim Lesen der Datei: {e}"))?;
  Ok(Response::new(data))
}

#[tauri::command]
fn tauri_fs_write_file(sub_path: String, data: Vec<u8>) -> Result<(), String> {
  let path = resolve_path(&sub_path)?;
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|e| format!("Fehler beim Erstellen der Elternverzeichnisse: {e}"))?;
  }
  fs::write(&path, data).map_err(|e| format!("Fehler beim Schreiben der Datei: {e}"))?;
  Ok(())
}

#[tauri::command]
fn tauri_fs_create_dir(sub_path: String) -> Result<(), String> {
  let path = resolve_path(&sub_path)?;
  fs::create_dir_all(&path).map_err(|e| format!("Fehler beim Erstellen des Verzeichnisses: {e}"))?;
  Ok(())
}

#[tauri::command]
fn tauri_fs_remove_entry(sub_path: String, is_directory: bool) -> Result<(), String> {
  let path = resolve_path(&sub_path)?;
  if !path.exists() {
    return Ok(());
  }
  if is_directory {
    fs::remove_dir_all(&path).map_err(|e| format!("Fehler beim Löschen des Verzeichnisses: {e}"))?;
  } else {
    fs::remove_file(&path).map_err(|e| format!("Fehler beim Löschen der Datei: {e}"))?;
  }
  Ok(())
}

#[tauri::command]
fn tauri_fs_rename(from_sub_path: String, to_sub_path: String) -> Result<(), String> {
  let from = resolve_path(&from_sub_path)?;
  let to = resolve_path(&to_sub_path)?;
  if let Some(parent) = to.parent() {
    fs::create_dir_all(parent).map_err(|e| format!("Fehler beim Erstellen der Elternverzeichnisse: {e}"))?;
  }
  fs::rename(&from, &to).map_err(|e| format!("Fehler beim Umbenennen: {e}"))?;
  Ok(())
}

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
  fs::create_dir_all(dst)?;
  for entry in fs::read_dir(src)? {
    let entry = entry?;
    let path = entry.path();
    let dest_path = dst.join(entry.file_name());
    if path.is_dir() {
      copy_dir_all(&path, &dest_path)?;
    } else {
      fs::copy(&path, &dest_path)?;
    }
  }
  Ok(())
}

#[tauri::command]
fn tauri_fs_copy(from_sub_path: String, to_sub_path: String) -> Result<(), String> {
  let from = resolve_path(&from_sub_path)?;
  let to = resolve_path(&to_sub_path)?;
  if let Some(parent) = to.parent() {
    fs::create_dir_all(parent).map_err(|e| format!("Fehler beim Erstellen der Elternverzeichnisse: {e}"))?;
  }
  if from.is_dir() {
    copy_dir_all(&from, &to).map_err(|e| format!("Fehler beim Kopieren des Verzeichnisses: {e}"))?;
  } else {
    fs::copy(&from, &to).map_err(|e| format!("Fehler beim Kopieren der Datei: {e}"))?;
  }
  Ok(())
}

#[tauri::command]
fn tauri_fs_exists(sub_path: String) -> Result<bool, String> {
  let path = resolve_path(&sub_path)?;
  Ok(path.exists())
}

#[tauri::command]
fn tauri_fs_init_root() -> Result<String, String> {
  let root = get_storage_root()?;
  Ok(root.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      tauri_fs_init_root,
      tauri_fs_list_entries,
      tauri_fs_read_file,
      tauri_fs_write_file,
      tauri_fs_create_dir,
      tauri_fs_remove_entry,
      tauri_fs_rename,
      tauri_fs_copy,
      tauri_fs_exists,
    ])
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
