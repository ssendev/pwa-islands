use std::borrow::Cow;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};
use tauri::http::{header, Response as HttpResponse, StatusCode};
use tauri::ipc::Response;
use tauri::Manager;
#[cfg(desktop)]
use tauri_plugin_dialog::DialogExt;
use url::Url;

static STORAGE_ROOT: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();
static CONFIG_FILE_PATH: OnceLock<PathBuf> = OnceLock::new();

#[derive(serde::Serialize, serde::Deserialize)]
struct PersistedStorageConfig {
  root_path: Option<String>,
}

fn storage_root_lock() -> &'static RwLock<Option<PathBuf>> {
  STORAGE_ROOT.get_or_init(|| RwLock::new(None))
}

fn persist_storage_root(root: Option<&Path>) -> Result<(), String> {
  let Some(config_path) = CONFIG_FILE_PATH.get() else {
    return Ok(());
  };
  if let Some(parent) = config_path.parent() {
    fs::create_dir_all(parent)
      .map_err(|e| format!("Konnte Konfigurationsordner nicht erstellen: {e}"))?;
  }
  let config = PersistedStorageConfig {
    root_path: root.map(|p| p.to_string_lossy().to_string()),
  };
  let json = serde_json::to_vec_pretty(&config)
    .map_err(|e| format!("Konnte Konfiguration nicht serialisieren: {e}"))?;
  fs::write(config_path, json)
    .map_err(|e| format!("Konnte Konfiguration nicht speichern: {e}"))?;
  Ok(())
}

fn load_persisted_storage_root(config_path: &Path) -> Option<PathBuf> {
  let bytes = fs::read(config_path).ok()?;
  let config: PersistedStorageConfig = serde_json::from_slice(&bytes).ok()?;
  let path_str = config.root_path?;
  let path = PathBuf::from(path_str.trim());
  if path.is_dir() {
    Some(path)
  } else {
    None
  }
}

fn set_storage_root(root: Option<PathBuf>) -> Result<(), String> {
  persist_storage_root(root.as_deref())?;
  let mut guard = storage_root_lock()
    .write()
    .map_err(|_| "Interner Fehler beim Sperren des Speicherpfads.".to_string())?;
  *guard = root;
  Ok(())
}

const ISLANDS_APP_JS: &str = r#"// PWA Islands API for Tauri custom protocol
const API_BASE = "/__pwaislands_api__";
let nextRequestId = 0;

async function apiGet(endpoint) {
  const res = await fetch(`${API_BASE}/${endpoint}`);
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(errText || `HTTP ${res.status}`);
  }
  return res;
}

function ipcRequest(action, payload) {
  return new Promise((resolve, reject) => {
    const requestId = `${Date.now()}-${++nextRequestId}`;
    function onMessage(event) {
      const data = event.data;
      if (
        !data ||
        typeof data !== "object" ||
        data.type !== "pwaislands:ipc-response" ||
        data.requestId !== requestId
      ) {
        return;
      }
      window.removeEventListener("message", onMessage);
      if (data.ok) {
        resolve();
      } else {
        reject(new Error(data.error || "Unbekannter IPC-Fehler"));
      }
    }
    window.addEventListener("message", onMessage);
    window.parent.postMessage(
      {
        type: "pwaislands:ipc",
        requestId,
        action,
        ...payload,
      },
      "*"
    );
  });
}

function normalizePath(path) {
  if (!path) return "";
  return path.replace(/^\/+/g, "").replace(/\/+$/g, "").replace(/\/+/g, "/");
}

function checkTextBytes(bytes) {
  if (bytes.byteLength === 0) {
    return { kind: "empty" };
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { kind: "binary", reason: "ungültiges UTF-8" };
  }
  const roundTrip = new TextEncoder().encode(text);
  if (roundTrip.byteLength !== bytes.byteLength) {
    return {
      kind: "binary",
      reason: `${bytes.byteLength} Bytes gelesen, ${roundTrip.byteLength} Bytes beim Zurückschreiben`,
    };
  }
  for (let i = 0; i < bytes.byteLength; i++) {
    if (bytes[i] !== roundTrip[i]) {
      const hexFound = `0x${bytes[i].toString(16).padStart(2, "0")}`;
      const hexRound = `0x${roundTrip[i].toString(16).padStart(2, "0")}`;
      return {
        kind: "binary",
        reason: `Abweichung an Byte ${i} (gelesen ${hexFound}, zurückgeschrieben ${hexRound})`,
      };
    }
  }
  return { kind: "text", text };
}

const islandEntrySort = (a, b) => {
  if (a.kind !== b.kind) {
    return a.kind === "directory" ? -1 : 1;
  }
  const cmp = a.name.localeCompare(b.name, "de", { sensitivity: "base", numeric: true });
  return cmp < 0 ? -1 : cmp > 0 ? 1 : 0;
};

const islands = {
  async list(path = "") {
    const cleanPath = normalizePath(path);
    const res = await apiGet(`list?subPath=${encodeURIComponent(cleanPath)}`);
    const raw = await res.json();
    const entries = (raw || []).map((entry) => {
      const entryPath = cleanPath ? `${cleanPath}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        return { name: entry.name, path: entryPath, kind: "directory" };
      }
      return {
        name: entry.name,
        path: entryPath,
        kind: "file",
        size: entry.size != null ? entry.size : undefined,
        lastModified: entry.lastModified != null ? entry.lastModified : undefined,
      };
    });
    return entries.sort(islandEntrySort);
  },

  async read(path, options) {
    const cleanPath = normalizePath(path);
    const res = await apiGet(`read?subPath=${encodeURIComponent(cleanPath)}`);
    const buffer = await res.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (options?.ensureText) {
      const check = checkTextBytes(bytes);
      if (check.kind === "binary") {
        throw new Error(`Datei ist kein gültiger UTF-8-Text: ${check.reason} (${path}).`);
      }
      return check.kind === "text" ? check.text : "";
    }
    return new TextDecoder("utf-8").decode(bytes);
  },

  async readBlob(path) {
    const cleanPath = normalizePath(path);
    const res = await apiGet(`read?subPath=${encodeURIComponent(cleanPath)}`);
    const buffer = await res.arrayBuffer();
    return new Blob([buffer]);
  },

  async exists(path) {
    const cleanPath = normalizePath(path);
    const res = await apiGet(`exists?subPath=${encodeURIComponent(cleanPath)}`);
    return await res.json();
  },

  async write(path, content, options) {
    const overwrite = options?.overwrite ?? false;
    const cleanPath = normalizePath(path);
    if (!overwrite && (await islands.exists(cleanPath))) {
      throw new Error(`Datei existiert bereits: ${cleanPath}`);
    }

    let bytes;
    if (typeof content === "string") {
      bytes = new TextEncoder().encode(content);
    } else if (content instanceof Blob) {
      bytes = new Uint8Array(await content.arrayBuffer());
    } else if (content instanceof ArrayBuffer) {
      bytes = new Uint8Array(content);
    } else if (ArrayBuffer.isView(content)) {
      bytes = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    } else {
      bytes = new Uint8Array(content);
    }

    await ipcRequest("write", {
      subPath: cleanPath,
      data: Array.from(bytes),
    });
  },

  async makeDir(path) {
    const cleanPath = normalizePath(path);
    await ipcRequest("mkdir", { subPath: cleanPath });
  },

  async rename(from, to) {
    const cleanFrom = normalizePath(from);
    const cleanTo = normalizePath(to);
    await ipcRequest("rename", { from: cleanFrom, to: cleanTo });
  },

  async remove(path, options) {
    const recursive = options?.recursive ?? false;
    const cleanPath = normalizePath(path);
    await ipcRequest("remove", {
      subPath: cleanPath,
      recursive: Boolean(recursive),
    });
  },

  async copy(from, to) {
    const cleanFrom = normalizePath(from);
    const cleanTo = normalizePath(to);
    await ipcRequest("copy", { from: cleanFrom, to: cleanTo });
  },
};

export default islands;
"#;

fn get_storage_root() -> Result<PathBuf, String> {
  let guard = storage_root_lock()
    .read()
    .map_err(|_| "Interner Fehler beim Lesen des Speicherpfads.".to_string())?;
  match guard.as_ref() {
    Some(root) => {
      if !root.is_dir() {
        return Err("Der ausgewählte Speicherordner existiert nicht mehr.".to_string());
      }
      Ok(root.clone())
    }
    None => Err("Kein Speicher ausgewählt. Bitte zuerst einen Ordner auswählen.".to_string()),
  }
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

fn extract_query_param(query: &str, key: &str) -> String {
  for pair in query.split('&') {
    if let Some((k, v)) = pair.split_once('=') {
      if k == key {
        return urlencoding::decode(v)
          .map(|c| c.into_owned())
          .unwrap_or_else(|_| v.to_string());
      }
    }
  }
  String::new()
}

fn json_response(status: StatusCode, body: Vec<u8>) -> HttpResponse<Cow<'static, [u8]>> {
  HttpResponse::builder()
    .status(status)
    .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
    .body(Cow::Owned(body))
    .unwrap_or_else(|_| HttpResponse::default())
}

fn text_response(status: StatusCode, msg: impl Into<String>) -> HttpResponse<Cow<'static, [u8]>> {
  HttpResponse::builder()
    .status(status)
    .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
    .body(Cow::Owned(msg.into().into_bytes()))
    .unwrap_or_else(|_| HttpResponse::default())
}

fn handle_api_request(
  action: &str,
  query: &str,
  request: &tauri::http::Request<Vec<u8>>,
) -> HttpResponse<Cow<'static, [u8]>> {
  if request.method() != tauri::http::Method::GET {
    return text_response(
      StatusCode::METHOD_NOT_ALLOWED,
      "Nur GET-Anfragen sind über das benutzerdefinierte Protokoll erlaubt",
    );
  }

  match action {
    "list" => {
      let sub_path = extract_query_param(query, "subPath");
      match tauri_fs_list_entries(sub_path) {
        Ok(entries) => match serde_json::to_vec(&entries) {
          Ok(json) => json_response(StatusCode::OK, json),
          Err(e) => text_response(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        },
        Err(e) => text_response(StatusCode::BAD_REQUEST, e),
      }
    }
    "read" => {
      let sub_path = extract_query_param(query, "subPath");
      match resolve_path(&sub_path) {
        Ok(path) => match fs::read(&path) {
          Ok(data) => HttpResponse::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Cow::Owned(data))
            .unwrap_or_else(|_| HttpResponse::default()),
          Err(e) => text_response(
            StatusCode::NOT_FOUND,
            format!("Fehler beim Lesen der Datei: {e}"),
          ),
        },
        Err(e) => text_response(StatusCode::BAD_REQUEST, e),
      }
    }
    "exists" => {
      let sub_path = extract_query_param(query, "subPath");
      match tauri_fs_exists(sub_path) {
        Ok(exists) => json_response(
          StatusCode::OK,
          if exists {
            b"true".to_vec()
          } else {
            b"false".to_vec()
          },
        ),
        Err(e) => text_response(StatusCode::BAD_REQUEST, e),
      }
    }
    _ => text_response(StatusCode::NOT_FOUND, "Unbekannter API-Endpunkt"),
  }
}

fn has_pwaislands_param(query: &str) -> bool {
  query
    .split('&')
    .filter(|part| !part.is_empty())
    .any(|part| {
      let key = part.split('=').next().unwrap_or("");
      key == "pwaislands"
    })
}

fn handle_pwaislands_request(
  request: &tauri::http::Request<Vec<u8>>,
) -> HttpResponse<Cow<'static, [u8]>> {
  let uri = request.uri().to_string();
  let (decoded_path, query) = match Url::parse(&uri) {
    Ok(parsed_url) => {
      let raw_path = match (parsed_url.host_str(), parsed_url.path()) {
        (Some("localhost") | None, path) => path.to_string(),
        (Some(host), path) => {
          if path.is_empty() || path == "/" {
            format!("/{host}")
          } else {
            format!("/{host}{path}")
          }
        }
      };
      let decoded = urlencoding::decode(&raw_path)
        .map(|c| c.into_owned())
        .unwrap_or(raw_path);
      let q = parsed_url.query().unwrap_or("").to_string();
      (decoded, q)
    }
    Err(_) => {
      let raw_path = request.uri().path();
      let decoded = urlencoding::decode(raw_path)
        .map(|c| c.into_owned())
        .unwrap_or_else(|_| raw_path.to_string());
      let q = request.uri().query().unwrap_or("").to_string();
      (decoded, q)
    }
  };

  let sub_path = decoded_path.trim_start_matches('/');

  if let Some(action) = sub_path.strip_prefix("__pwaislands_api__/") {
    return handle_api_request(action, &query, request);
  }

  if has_pwaislands_param(&query) {
    let clean_path = if decoded_path.starts_with('/') {
      decoded_path
    } else {
      format!("/{decoded_path}")
    };
    let target_url = if query.is_empty() {
      clean_path
    } else {
      format!("{clean_path}?{query}")
    };
    let serialized_url =
      serde_json::to_string(&target_url).unwrap_or_else(|_| "\"/?pwaislands\"".to_string());
    let html = format!(
      "<!doctype html><html lang=\"de\"><head><meta charset=\"utf-8\"></head><body><script>window.parent.postMessage({{type:\"pwaislands:navigate\",url:{serialized_url}}},\"*\");</script></body></html>"
    );
    return HttpResponse::builder()
      .status(StatusCode::OK)
      .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
      .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
      .body(Cow::Owned(html.into_bytes()))
      .unwrap_or_else(|_| HttpResponse::default());
  }

  if sub_path == "app.js" || sub_path == "api.js" {
    return HttpResponse::builder()
      .status(StatusCode::OK)
      .header(header::CONTENT_TYPE, "text/javascript; charset=utf-8")
      .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
      .body(Cow::Borrowed(ISLANDS_APP_JS.as_bytes()))
      .unwrap_or_else(|_| HttpResponse::default());
  }

  let file_path = match resolve_path(sub_path) {
    Ok(path) => path,
    Err(e) => {
      return HttpResponse::builder()
        .status(StatusCode::BAD_REQUEST)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Cow::Owned(e.into_bytes()))
        .unwrap_or_else(|_| HttpResponse::default());
    }
  };

  let actual_path = if file_path.is_dir() {
    file_path.join("index.html")
  } else {
    file_path
  };

  match fs::read(&actual_path) {
    Ok(data) => {
      let mime_type = mime_guess::from_path(&actual_path)
        .first_or_octet_stream()
        .to_string();

      HttpResponse::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime_type)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Cow::Owned(data))
        .unwrap_or_else(|_| HttpResponse::default())
    }
    Err(err) if err.kind() == std::io::ErrorKind::NotFound => HttpResponse::builder()
      .status(StatusCode::NOT_FOUND)
      .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
      .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
      .body(Cow::Borrowed(b"Datei nicht gefunden".as_slice()))
      .unwrap_or_else(|_| HttpResponse::default()),
    Err(err) => HttpResponse::builder()
      .status(StatusCode::INTERNAL_SERVER_ERROR)
      .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
      .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
      .body(Cow::Owned(
        format!("Fehler beim Lesen der Datei: {err}").into_bytes(),
      ))
      .unwrap_or_else(|_| HttpResponse::default()),
  }
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
  if path.is_dir() {
    if is_directory {
      fs::remove_dir_all(&path).map_err(|e| format!("Fehler beim Löschen des Verzeichnisses: {e}"))?;
    } else {
      fs::remove_dir(&path).map_err(|e| format!("Fehler beim Löschen des Verzeichnisses: {e}"))?;
    }
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

const HISTORY_FOLDER_NAME: &str = "pwa-islands-history";
// Binärformat-Vertrag: muss exakt mit `src/history.ts` (`TRAILER_SIZE_BYTES = 16`, LE) übereinstimmen:
// [UTF-8 Inhalt] [contentHash: u32 LE (4B)] [timestampMs: f64 LE (8B)] [byteLength: u32 LE (4B)]
const HISTORY_TRAILER_SIZE_BYTES: u64 = 16;

#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryEntryMeta {
  offset: u64,
  end_offset: u64,
  timestamp_ms: f64,
  byte_length: u32,
  content_hash: u32,
}

fn validate_history_segment(segment: &str) -> Result<&str, String> {
  let trimmed = segment.trim();
  if trimmed.is_empty() || trimmed == "." || trimmed == ".." || trimmed.contains('/') || trimmed.contains('\\') {
    return Err("Ungültiges Pfadsegment für den Versionsverlauf.".to_string());
  }
  Ok(trimmed)
}

fn resolve_history_path_under(base_dir: &Path, sub_path: &[String], file_name: &str) -> Result<PathBuf, String> {
  let mut resolved = base_dir.join(HISTORY_FOLDER_NAME);
  for segment in sub_path {
    resolved.push(validate_history_segment(segment)?);
  }
  resolved.push(validate_history_segment(file_name)?);
  Ok(resolved)
}

fn resolve_history_path(app: &tauri::AppHandle, sub_path: &[String], file_name: &str) -> Result<PathBuf, String> {
  let base_dir = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("Konnte App-Datenordner nicht ermitteln: {e}"))?;
  resolve_history_path_under(&base_dir, sub_path, file_name)
}

fn history_append_at_path(path: &Path, data: &[u8]) -> Result<(), String> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|e| format!("Fehler beim Erstellen des Verlaufsordners: {e}"))?;
  }
  let mut file = fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(path)
    .map_err(|e| format!("Fehler beim Öffnen der Verlaufsdatei: {e}"))?;
  file
    .write_all(data)
    .map_err(|e| format!("Fehler beim Schreiben in die Verlaufsdatei: {e}"))?;
  Ok(())
}

fn history_size_at_path(path: &Path) -> Result<u64, String> {
  if !path.is_file() {
    return Ok(0);
  }
  let metadata = fs::metadata(path).map_err(|e| format!("Fehler beim Lesen der Verlaufsgröße: {e}"))?;
  Ok(metadata.len())
}

fn history_read_slice_at_path(path: &Path, start: u64, end: u64) -> Result<Vec<u8>, String> {
  if !path.is_file() || end <= start {
    return Ok(Vec::new());
  }
  let mut file = fs::File::open(path).map_err(|e| format!("Fehler beim Öffnen der Verlaufsdatei: {e}"))?;
  let file_len = file
    .metadata()
    .map_err(|e| format!("Fehler beim Lesen der Verlaufsgröße: {e}"))?
    .len();
  let clamped_start = start.min(file_len);
  let clamped_end = end.min(file_len);
  if clamped_end <= clamped_start {
    return Ok(Vec::new());
  }
  let length = usize::try_from(clamped_end - clamped_start)
    .map_err(|_| "Verlaufsbereich ist zu groß zum Lesen.".to_string())?;
  file
    .seek(SeekFrom::Start(clamped_start))
    .map_err(|e| format!("Fehler beim Positionieren in der Verlaufsdatei: {e}"))?;
  let mut buffer = vec![0u8; length];
  file
    .read_exact(&mut buffer)
    .map_err(|e| format!("Fehler beim Lesen der Verlaufsdatei: {e}"))?;
  Ok(buffer)
}

fn history_truncate_at_path(path: &Path, size: u64) -> Result<(), String> {
  if !path.is_file() {
    return Ok(());
  }
  if size == 0 {
    return history_clear_at_path(path);
  }
  let file = fs::OpenOptions::new()
    .write(true)
    .open(path)
    .map_err(|e| format!("Fehler beim Öffnen der Verlaufsdatei: {e}"))?;
  file
    .set_len(size)
    .map_err(|e| format!("Fehler beim Kürzen der Verlaufsdatei: {e}"))?;
  Ok(())
}

fn history_clear_at_path(path: &Path) -> Result<(), String> {
  match fs::remove_file(path) {
    Ok(()) => Ok(()),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(e) => Err(format!("Fehler beim Löschen der Verlaufsdatei: {e}")),
  }
}

fn history_read_index_at_path(path: &Path) -> Result<Vec<HistoryEntryMeta>, String> {
  if !path.is_file() {
    return Ok(Vec::new());
  }
  let mut file = fs::File::open(path).map_err(|e| format!("Fehler beim Öffnen der Verlaufsdatei: {e}"))?;
  let mut cursor = file
    .metadata()
    .map_err(|e| format!("Fehler beim Lesen der Verlaufsgröße: {e}"))?
    .len();
  let mut entries = Vec::new();
  let mut trailer = [0u8; 16];

  while cursor >= HISTORY_TRAILER_SIZE_BYTES {
    let trailer_start = cursor - HISTORY_TRAILER_SIZE_BYTES;
    file
      .seek(SeekFrom::Start(trailer_start))
      .map_err(|e| format!("Fehler beim Positionieren in der Verlaufsdatei: {e}"))?;
    file
      .read_exact(&mut trailer)
      .map_err(|e| format!("Fehler beim Lesen der Verlaufsdatei: {e}"))?;

    let content_hash = u32::from_le_bytes([trailer[0], trailer[1], trailer[2], trailer[3]]);
    let timestamp_ms = f64::from_le_bytes([
      trailer[4], trailer[5], trailer[6], trailer[7], trailer[8], trailer[9], trailer[10],
      trailer[11],
    ]);
    let byte_length = u32::from_le_bytes([trailer[12], trailer[13], trailer[14], trailer[15]]);

    let Some(start_offset) = trailer_start.checked_sub(u64::from(byte_length)) else {
      break;
    };

    entries.push(HistoryEntryMeta {
      offset: start_offset,
      end_offset: cursor,
      timestamp_ms,
      byte_length,
      content_hash,
    });
    cursor = start_offset;
  }

  Ok(entries)
}

#[tauri::command]
fn tauri_history_append(
  app: tauri::AppHandle,
  sub_path: Vec<String>,
  file_name: String,
  data: Vec<u8>,
) -> Result<(), String> {
  let path = resolve_history_path(&app, &sub_path, &file_name)?;
  history_append_at_path(&path, &data)
}

#[tauri::command]
fn tauri_history_size(app: tauri::AppHandle, sub_path: Vec<String>, file_name: String) -> Result<u64, String> {
  let path = resolve_history_path(&app, &sub_path, &file_name)?;
  history_size_at_path(&path)
}

#[tauri::command]
fn tauri_history_read_slice(
  app: tauri::AppHandle,
  sub_path: Vec<String>,
  file_name: String,
  start: u64,
  end: u64,
) -> Result<Response, String> {
  let path = resolve_history_path(&app, &sub_path, &file_name)?;
  let bytes = history_read_slice_at_path(&path, start, end)?;
  Ok(Response::new(bytes))
}

#[tauri::command]
fn tauri_history_truncate(
  app: tauri::AppHandle,
  sub_path: Vec<String>,
  file_name: String,
  size: u64,
) -> Result<(), String> {
  let path = resolve_history_path(&app, &sub_path, &file_name)?;
  history_truncate_at_path(&path, size)
}

#[tauri::command]
fn tauri_history_clear(app: tauri::AppHandle, sub_path: Vec<String>, file_name: String) -> Result<(), String> {
  let path = resolve_history_path(&app, &sub_path, &file_name)?;
  history_clear_at_path(&path)
}

#[tauri::command]
fn tauri_history_read_index(
  app: tauri::AppHandle,
  sub_path: Vec<String>,
  file_name: String,
) -> Result<Vec<HistoryEntryMeta>, String> {
  let path = resolve_history_path(&app, &sub_path, &file_name)?;
  history_read_index_at_path(&path)
}

#[tauri::command]
fn tauri_fs_get_root() -> Result<Option<String>, String> {
  let guard = storage_root_lock()
    .read()
    .map_err(|_| "Interner Fehler beim Lesen des Speicherpfads.".to_string())?;
  match guard.as_ref() {
    Some(root) if root.is_dir() => Ok(Some(root.to_string_lossy().to_string())),
    _ => Ok(None),
  }
}

#[tauri::command]
fn tauri_fs_set_root(path: String) -> Result<String, String> {
  let trimmed = path.trim();
  if trimmed.is_empty() {
    return Err("Ungültiger Ordnerpfad.".to_string());
  }
  let root = PathBuf::from(trimmed);
  if !root.is_dir() {
    return Err("Der angegebene Ordner existiert nicht.".to_string());
  }
  set_storage_root(Some(root.clone()))?;
  Ok(root.to_string_lossy().to_string())
}

#[tauri::command]
fn tauri_fs_clear_root() -> Result<(), String> {
  set_storage_root(None)
}

#[cfg(target_os = "android")]
struct AndroidFolderPicker<R: tauri::Runtime>(tauri::plugin::PluginHandle<R>);

#[cfg(target_os = "android")]
#[derive(serde::Deserialize)]
struct AndroidPickFolderResponse {
  path: Option<String>,
}

#[cfg(desktop)]
#[tauri::command]
async fn tauri_fs_pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
  let maybe_folder = app
    .dialog()
    .file()
    .set_title("Ordner wählen")
    .blocking_pick_folder();

  match maybe_folder {
    Some(file_path) => {
      let folder = file_path
        .into_path()
        .map_err(|e| format!("Ungültiger Ordnerpfad: {e}"))?;
      set_storage_root(Some(folder.clone()))?;
      Ok(Some(folder.to_string_lossy().to_string()))
    }
    None => Ok(None),
  }
}

#[cfg(target_os = "android")]
#[tauri::command]
async fn tauri_fs_pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
  let picker = app
    .try_state::<AndroidFolderPicker<tauri::Wry>>()
    .ok_or_else(|| "Ordnerauswahl-Plugin nicht initialisiert.".to_string())?;

  let res = picker
    .0
    .run_mobile_plugin_async::<AndroidPickFolderResponse>("pickFolder", ())
    .await
    .map_err(|e| format!("Fehler bei der Ordnerauswahl: {e}"))?;

  match res.path {
    Some(path_str) => {
      let trimmed = path_str.trim().to_string();
      if trimmed.is_empty() {
        return Ok(None);
      }
      let folder = PathBuf::from(&trimmed);
      if !folder.is_dir() {
        fs::create_dir_all(&folder).map_err(|e| {
          format!("Konnte Ordner nicht erstellen oder darauf zugreifen: {e}")
        })?;
      }
      set_storage_root(Some(folder.clone()))?;
      Ok(Some(folder.to_string_lossy().to_string()))
    }
    None => Ok(None),
  }
}

#[cfg(all(not(desktop), not(target_os = "android")))]
#[tauri::command]
async fn tauri_fs_pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
  let base_dir = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("Konnte App-Datenordner nicht ermitteln: {e}"))?;
  let folder = base_dir.join("islands");
  fs::create_dir_all(&folder).map_err(|e| format!("Konnte Ordner nicht erstellen: {e}"))?;
  set_storage_root(Some(folder.clone()))?;
  Ok(Some(folder.to_string_lossy().to_string()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  #[allow(unused_mut)]
  let mut builder = tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init());

  #[cfg(target_os = "android")]
  {
    let folder_picker_plugin = tauri::plugin::Builder::<tauri::Wry, ()>::new("folderpicker")
      .setup(|app, api| {
        let handle = api.register_android_plugin("dev.ssen.pwaislands", "FolderPickerPlugin")?;
        app.manage(AndroidFolderPicker(handle));
        Ok(())
      })
      .build();
    builder = builder.plugin(folder_picker_plugin);
  }

  builder
    .register_uri_scheme_protocol("pwaislands", |_ctx, request| {
      handle_pwaislands_request(&request)
    })
    .setup(|app| {
      if let Ok(config_dir) = app.path().app_config_dir() {
        let config_path = config_dir.join("storage-root.json");
        if let Some(saved_root) = load_persisted_storage_root(&config_path) {
          let _ = set_storage_root(Some(saved_root));
        }
        let _ = CONFIG_FILE_PATH.set(config_path);
      }
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      #[cfg(desktop)]
      {
        let init_script = r#"
          window.addEventListener('keydown', (e) => {
            if (window !== window.top) {
              if (e.key === 'Escape') {
                window.top.postMessage({ type: 'TAURI_EXIT_FULLSCREEN', key: e.key }, '*');
              } else if (e.key === 'F11') {
                e.preventDefault();
                window.top.postMessage({ type: 'TAURI_TOGGLE_FULLSCREEN', key: e.key }, '*');
              }
            }
          }, true);
        "#;

        if let Some(window_config) = app.config().app.windows.first() {
          tauri::WebviewWindowBuilder::from_config(app.handle(), window_config)?
            .initialization_script_for_all_frames(init_script)
            .build()?;
        }
      }
      #[cfg(target_os = "windows")]
      {
        if let Some(main_window) = app.get_webview_window("main") {
          let _ = main_window.clear_all_browsing_data();
        }
      }
      #[cfg(target_os = "linux")]
      {
        use gtk::prelude::*;
        if let Some(main_window) = app.get_webview_window("main") {
          let _ = main_window.set_decorations(true);
          if let Ok(gtk_win) = main_window.gtk_window() {
            let header_bar = gtk::HeaderBar::new();
            header_bar.set_show_close_button(true);
            header_bar.set_title(Some("PWA Islands"));

            let return_btn = gtk::Button::from_icon_name(Some("go-previous"), gtk::IconSize::Button);
            return_btn.set_tooltip_text(Some("Zurück (Doppelklick: Bearbeitungsmodus)"));
            let win_clone = main_window.clone();
            return_btn.connect_button_press_event(move |_, event| {
              use gtk::gdk::EventType;
              if event.event_type() == EventType::DoubleButtonPress {
                let _ = win_clone.eval("window.postMessage({ type: 'pwaislands:titlebar-double-click' }, '*')");
              } else if event.event_type() == EventType::ButtonPress {
                let _ = win_clone.eval("window.postMessage({ type: 'pwaislands:titlebar-click' }, '*')");
              }
              gtk::glib::Propagation::Proceed
            });

            header_bar.pack_start(&return_btn);

            let fullscreen_btn =
              gtk::Button::from_icon_name(Some("view-fullscreen"), gtk::IconSize::Button);
            fullscreen_btn.set_tooltip_text(Some("Vollbild (F11)"));
            let win_fs_clone = main_window.clone();
            fullscreen_btn.connect_clicked(move |_| {
              let _ = win_fs_clone.eval("window.postMessage({ type: 'TAURI_TOGGLE_FULLSCREEN' }, '*')");
            });

            let fs_btn_clone = fullscreen_btn.clone();
            gtk_win.connect_window_state_event(move |_, event| {
              let is_fullscreen =
                event.new_window_state().contains(gtk::gdk::WindowState::FULLSCREEN);
              if is_fullscreen {
                fs_btn_clone.set_image(Some(&gtk::Image::from_icon_name(
                  Some("view-restore"),
                  gtk::IconSize::Button,
                )));
                fs_btn_clone.set_tooltip_text(Some("Vollbild beenden (F11)"));
              } else {
                fs_btn_clone.set_image(Some(&gtk::Image::from_icon_name(
                  Some("view-fullscreen"),
                  gtk::IconSize::Button,
                )));
                fs_btn_clone.set_tooltip_text(Some("Vollbild (F11)"));
              }
              gtk::glib::Propagation::Proceed
            });

            header_bar.pack_end(&fullscreen_btn);
            gtk_win
              .bind_property("title", &header_bar, "title")
              .flags(gtk::glib::BindingFlags::DEFAULT | gtk::glib::BindingFlags::SYNC_CREATE)
              .build();
            gtk_win.set_titlebar(Some(&header_bar));
            header_bar.show_all();
          }
        }
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      tauri_fs_get_root,
      tauri_fs_set_root,
      tauri_fs_clear_root,
      tauri_fs_pick_folder,
      tauri_fs_list_entries,
      tauri_fs_read_file,
      tauri_fs_write_file,
      tauri_fs_create_dir,
      tauri_fs_remove_entry,
      tauri_fs_rename,
      tauri_fs_copy,
      tauri_fs_exists,
      tauri_history_append,
      tauri_history_size,
      tauri_history_read_slice,
      tauri_history_truncate,
      tauri_history_clear,
      tauri_history_read_index,
    ])
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;
  use std::sync::Mutex;
  use tauri::http::Request;

  static TEST_MUTEX: Mutex<()> = Mutex::new(());

  fn setup_test_root() -> PathBuf {
    let root = std::env::temp_dir().join("pwa-islands-rust-tests");
    fs::create_dir_all(&root).unwrap();
    tauri_fs_set_root(root.to_string_lossy().to_string()).unwrap();
    root
  }

  #[test]
  fn test_handle_pwaislands_request() {
    let _lock = TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
    let root = setup_test_root();
    let test_file = root.join("test_protocol.html");
    fs::write(&test_file, b"<h1>Hello Island</h1>").unwrap();

    let req = Request::builder()
      .uri("pwaislands://localhost/test_protocol.html")
      .body(Vec::new())
      .unwrap();

    let res = handle_pwaislands_request(&req);
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
      res.headers().get(header::CONTENT_TYPE).unwrap(),
      "text/html"
    );
    assert_eq!(res.body().as_ref(), b"<h1>Hello Island</h1>");

    let _ = fs::remove_file(test_file);
  }

  #[test]
  fn test_handle_pwaislands_request_not_found() {
    let _lock = TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
    let _root = setup_test_root();
    let req = Request::builder()
      .uri("pwaislands://localhost/non_existent_file.xyz")
      .body(Vec::new())
      .unwrap();

    let res = handle_pwaislands_request(&req);
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
  }

  #[test]
  fn test_handle_pwaislands_request_without_root() {
    let _lock = TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
    tauri_fs_clear_root().unwrap();
    assert_eq!(tauri_fs_get_root().unwrap(), None);

    let req = Request::builder()
      .uri("pwaislands://localhost/test_protocol.html")
      .body(Vec::new())
      .unwrap();

    let res = handle_pwaislands_request(&req);
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
  }

  #[test]
  fn test_handle_pwaislands_request_app_js() {
    let _lock = TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
    let req = Request::builder()
      .uri("pwaislands://localhost/app.js")
      .body(Vec::new())
      .unwrap();

    let res = handle_pwaislands_request(&req);
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
      res.headers().get(header::CONTENT_TYPE).unwrap(),
      "text/javascript; charset=utf-8"
    );
    assert!(res.body().starts_with(b"// PWA Islands API"));

    let req_api = Request::builder()
      .uri("pwaislands://localhost/api.js")
      .body(Vec::new())
      .unwrap();

    let res_api = handle_pwaislands_request(&req_api);
    assert_eq!(res_api.status(), StatusCode::OK);
    assert_eq!(
      res_api.headers().get(header::CONTENT_TYPE).unwrap(),
      "text/javascript; charset=utf-8"
    );
    let body_str = std::str::from_utf8(res_api.body()).unwrap();
    assert!(!body_str.contains("__TAURI_INTERNALS__"));
    assert!(body_str.contains("/__pwaislands_api__"));
    assert!(!body_str.contains("method: \"POST\""));
    assert!(body_str.contains("pwaislands:ipc"));
  }

  #[test]
  fn test_handle_pwaislands_api_endpoints() {
    let _lock = TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
    let _root = setup_test_root();

    // POST over custom protocol is rejected
    let post_req = Request::builder()
      .method("POST")
      .uri("pwaislands://localhost/__pwaislands_api__/write?subPath=api_test.txt")
      .body(b"Test Content".to_vec())
      .unwrap();
    let post_res = handle_pwaislands_request(&post_req);
    assert_eq!(post_res.status(), StatusCode::METHOD_NOT_ALLOWED);

    // Write file via Tauri IPC command
    tauri_fs_write_file("api_test.txt".to_string(), b"Test Content".to_vec()).unwrap();

    // Exists via GET API
    let exists_req = Request::builder()
      .uri("pwaislands://localhost/__pwaislands_api__/exists?subPath=api_test.txt")
      .body(Vec::new())
      .unwrap();
    let exists_res = handle_pwaislands_request(&exists_req);
    assert_eq!(exists_res.status(), StatusCode::OK);
    assert_eq!(exists_res.body().as_ref(), b"true");

    // Read via GET API
    let read_req = Request::builder()
      .uri("pwaislands://localhost/__pwaislands_api__/read?subPath=api_test.txt")
      .body(Vec::new())
      .unwrap();
    let read_res = handle_pwaislands_request(&read_req);
    assert_eq!(read_res.status(), StatusCode::OK);
    assert_eq!(read_res.body().as_ref(), b"Test Content");

    // Remove via Tauri IPC command
    tauri_fs_remove_entry("api_test.txt".to_string(), false).unwrap();

    // Verify removed
    let exists_after = handle_pwaislands_request(&exists_req);
    assert_eq!(exists_after.body().as_ref(), b"false");
  }

  #[test]
  fn test_handle_pwaislands_navigation_param() {
    let _lock = TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
    let req = Request::builder()
      .uri("pwaislands://localhost/?pwaislands")
      .body(Vec::new())
      .unwrap();
    let res = handle_pwaislands_request(&req);
    assert_eq!(res.status(), StatusCode::OK);
    let body_str = std::str::from_utf8(res.body()).unwrap();
    assert!(body_str.contains("pwaislands:navigate"));
    assert!(body_str.contains("\"/?pwaislands\""));
  }

  #[test]
  fn test_handle_pwaislands_directory_index_fallback() {
    let _lock = TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
    let root = setup_test_root();
    let subfolder = root.join("test_dir_fallback");
    let _ = fs::remove_dir_all(&subfolder);
    fs::create_dir_all(&subfolder).unwrap();

    // Directory without index.html should return 404 Not Found (not 500 Is a directory)
    let req_empty_dir = Request::builder()
      .uri("pwaislands://localhost/test_dir_fallback/")
      .body(Vec::new())
      .unwrap();
    let res_empty = handle_pwaislands_request(&req_empty_dir);
    assert_eq!(res_empty.status(), StatusCode::NOT_FOUND);

    // Directory with index.html should return 200 OK with index.html content
    let index_file = subfolder.join("index.html");
    fs::write(&index_file, b"<h1>Subfolder Index</h1>").unwrap();

    let req_with_index = Request::builder()
      .uri("pwaislands://localhost/test_dir_fallback/")
      .body(Vec::new())
      .unwrap();
    let res_with_index = handle_pwaislands_request(&req_with_index);
    assert_eq!(res_with_index.status(), StatusCode::OK);
    assert_eq!(
      res_with_index.headers().get(header::CONTENT_TYPE).unwrap(),
      "text/html"
    );
    assert_eq!(res_with_index.body().as_ref(), b"<h1>Subfolder Index</h1>");

    let _ = fs::remove_dir_all(&subfolder);
  }

  #[test]
  fn test_history_storage_lifecycle_and_path_validation() {
    let base_dir = std::env::temp_dir().join("pwa-islands-history-rust-tests");
    let _ = fs::remove_dir_all(&base_dir);
    fs::create_dir_all(&base_dir).unwrap();

    assert!(resolve_history_path_under(&base_dir, &["..".to_string()], "index.html").is_err());
    assert!(resolve_history_path_under(&base_dir, &[], "../secret.html").is_err());
    assert!(resolve_history_path_under(&base_dir, &["a/b".to_string()], "index.html").is_err());

    let path = resolve_history_path_under(&base_dir, &["apps".to_string()], "index.html").unwrap();
    assert_eq!(history_size_at_path(&path).unwrap(), 0);
    assert!(history_read_slice_at_path(&path, 0, 10).unwrap().is_empty());

    history_append_at_path(&path, b"hello").unwrap();
    history_append_at_path(&path, b"world!").unwrap();
    assert_eq!(history_size_at_path(&path).unwrap(), 11);
    assert_eq!(history_read_slice_at_path(&path, 5, 11).unwrap(), b"world!");
    assert_eq!(history_read_slice_at_path(&path, 0, 50).unwrap(), b"helloworld!");

    history_truncate_at_path(&path, 5).unwrap();
    assert_eq!(history_size_at_path(&path).unwrap(), 5);
    assert_eq!(history_read_slice_at_path(&path, 0, 5).unwrap(), b"hello");

    history_truncate_at_path(&path, 0).unwrap();
    assert_eq!(history_size_at_path(&path).unwrap(), 0);
    assert!(!path.exists());

    history_append_at_path(&path, b"abc").unwrap();
    history_clear_at_path(&path).unwrap();
    assert!(!path.exists());
    history_clear_at_path(&path).unwrap();

    let _ = fs::remove_dir_all(&base_dir);
  }

  fn encode_test_history_record(content: &str, timestamp_ms: f64) -> Vec<u8> {
    let bytes = content.as_bytes();
    let hash = bytes.iter().fold(0x811c9dc5u32, |acc, &b| {
      (acc ^ u32::from(b)).wrapping_mul(0x01000193)
    });
    let mut record = Vec::with_capacity(bytes.len() + 16);
    record.extend_from_slice(bytes);
    record.extend_from_slice(&hash.to_le_bytes());
    record.extend_from_slice(&timestamp_ms.to_le_bytes());
    record.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    record
  }

  #[test]
  fn test_history_read_index_parity_and_edge_cases() {
    let base_dir = std::env::temp_dir().join("pwa-islands-history-index-tests");
    let _ = fs::remove_dir_all(&base_dir);
    fs::create_dir_all(&base_dir).unwrap();
    let path = resolve_history_path_under(&base_dir, &["apps".to_string()], "index.html").unwrap();

    assert!(history_read_index_at_path(&path).unwrap().is_empty());

    let r1 = encode_test_history_record("Version 1", 1000.0);
    let r2 = encode_test_history_record("Version 2 mit Umlauten: äöüß", 2000.0);
    let r3 = encode_test_history_record("", 3000.0);
    history_append_at_path(&path, &r1).unwrap();
    history_append_at_path(&path, &r2).unwrap();
    history_append_at_path(&path, &r3).unwrap();

    let index = history_read_index_at_path(&path).unwrap();
    assert_eq!(index.len(), 3);
    assert_eq!(index[0].timestamp_ms, 3000.0);
    assert_eq!(index[0].byte_length, 0);
    assert_eq!(index[0].content_hash, 0x811c9dc5);
    assert_eq!(index[1].timestamp_ms, 2000.0);
    assert_eq!(index[1].byte_length as usize, "Version 2 mit Umlauten: äöüß".len());
    assert_eq!(index[2].offset, 0);
    assert_eq!(index[2].timestamp_ms, 1000.0);

    let json = serde_json::to_value(&index[2]).unwrap();
    assert_eq!(
      json,
      serde_json::json!({
        "offset": 0,
        "endOffset": r1.len(),
        "timestampMs": 1000.0,
        "byteLength": "Version 1".len(),
        "contentHash": index[2].content_hash,
      })
    );

    // Out-of-bounds length stops gracefully without error
    let corrupt_path = resolve_history_path_under(&base_dir, &[], "corrupt.html").unwrap();
    let mut bad_trailer = Vec::new();
    bad_trailer.extend_from_slice(&0u32.to_le_bytes());
    bad_trailer.extend_from_slice(&1234.0f64.to_le_bytes());
    bad_trailer.extend_from_slice(&999u32.to_le_bytes());
    history_append_at_path(&corrupt_path, &bad_trailer).unwrap();
    assert!(history_read_index_at_path(&corrupt_path).unwrap().is_empty());

    let _ = fs::remove_dir_all(&base_dir);
  }
}
