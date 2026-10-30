use std::borrow::Cow;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::http::{header, Response as HttpResponse, StatusCode};
use tauri::ipc::Response;
use url::Url;

const STORAGE_ROOT: &str = "/tmp/PWA-Islands";

const ISLANDS_APP_JS: &str = r#"// PWA Islands API for Tauri custom protocol
const API_BASE = "/__pwaislands_api__";

async function apiRequest(endpoint, options = {}) {
  const res = await fetch(`${API_BASE}/${endpoint}`, options);
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(errText || `HTTP ${res.status}`);
  }
  return res;
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
    const res = await apiRequest(`list?subPath=${encodeURIComponent(cleanPath)}`);
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
    const res = await apiRequest(`read?subPath=${encodeURIComponent(cleanPath)}`);
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
    const res = await apiRequest(`read?subPath=${encodeURIComponent(cleanPath)}`);
    const buffer = await res.arrayBuffer();
    return new Blob([buffer]);
  },

  async exists(path) {
    const cleanPath = normalizePath(path);
    const res = await apiRequest(`exists?subPath=${encodeURIComponent(cleanPath)}`);
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

    await apiRequest(`write?subPath=${encodeURIComponent(cleanPath)}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes,
    });
  },

  async makeDir(path) {
    const cleanPath = normalizePath(path);
    await apiRequest(`mkdir?subPath=${encodeURIComponent(cleanPath)}`, {
      method: "POST",
    });
  },

  async rename(from, to) {
    const cleanFrom = normalizePath(from);
    const cleanTo = normalizePath(to);
    await apiRequest(
      `rename?from=${encodeURIComponent(cleanFrom)}&to=${encodeURIComponent(cleanTo)}`,
      { method: "POST" }
    );
  },

  async remove(path, options) {
    const recursive = options?.recursive ?? false;
    const cleanPath = normalizePath(path);
    await apiRequest(
      `remove?subPath=${encodeURIComponent(cleanPath)}&recursive=${recursive ? "true" : "false"}`,
      { method: "POST" }
    );
  },

  async copy(from, to) {
    const cleanFrom = normalizePath(from);
    const cleanTo = normalizePath(to);
    await apiRequest(
      `copy?from=${encodeURIComponent(cleanFrom)}&to=${encodeURIComponent(cleanTo)}`,
      { method: "POST" }
    );
  },
};

export default islands;
"#;

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
    "write" => {
      let sub_path = extract_query_param(query, "subPath");
      let data = request.body().clone();
      match tauri_fs_write_file(sub_path, data) {
        Ok(()) => json_response(StatusCode::OK, b"true".to_vec()),
        Err(e) => text_response(StatusCode::BAD_REQUEST, e),
      }
    }
    "mkdir" => {
      let sub_path = extract_query_param(query, "subPath");
      match tauri_fs_create_dir(sub_path) {
        Ok(()) => json_response(StatusCode::OK, b"true".to_vec()),
        Err(e) => text_response(StatusCode::BAD_REQUEST, e),
      }
    }
    "rename" => {
      let from = extract_query_param(query, "from");
      let to = extract_query_param(query, "to");
      match tauri_fs_rename(from, to) {
        Ok(()) => json_response(StatusCode::OK, b"true".to_vec()),
        Err(e) => text_response(StatusCode::BAD_REQUEST, e),
      }
    }
    "remove" => {
      let sub_path = extract_query_param(query, "subPath");
      let recursive = extract_query_param(query, "recursive") == "true";
      match tauri_fs_remove_entry(sub_path, recursive) {
        Ok(()) => json_response(StatusCode::OK, b"true".to_vec()),
        Err(e) => text_response(StatusCode::BAD_REQUEST, e),
      }
    }
    "copy" => {
      let from = extract_query_param(query, "from");
      let to = extract_query_param(query, "to");
      match tauri_fs_copy(from, to) {
        Ok(()) => json_response(StatusCode::OK, b"true".to_vec()),
        Err(e) => text_response(StatusCode::BAD_REQUEST, e),
      }
    }
    _ => text_response(StatusCode::NOT_FOUND, "Unbekannter API-Endpunkt"),
  }
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
    let index = file_path.join("index.html");
    if index.is_file() {
      index
    } else {
      file_path
    }
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

const ISOLATE_TAURI_SCRIPT: &str = r#"const __isCustomProtocol = window.location.protocol === "pwaislands:" || window.location.hostname === "pwaislands.localhost";
if (__isCustomProtocol) {
  const __denyTauriInternals = () => {
    try {
      delete window.__TAURI_INTERNALS__;
      delete window.__TAURI__;
      delete window.__TAURI_IPC__;
      Object.defineProperty(window, "__TAURI_INTERNALS__", {
        value: undefined,
        writable: false,
        configurable: false,
      });
      Object.defineProperty(window, "__TAURI__", {
        value: undefined,
        writable: false,
        configurable: false,
      });
      Object.defineProperty(window, "__TAURI_IPC__", {
        value: undefined,
        writable: false,
        configurable: false,
      });
    } catch {}
  };
  __denyTauriInternals();
}
"#;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .register_uri_scheme_protocol("pwaislands", |_ctx, request| {
      handle_pwaislands_request(&request)
    })
    .append_invoke_initialization_script(ISOLATE_TAURI_SCRIPT)
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

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;
  use tauri::http::Request;

  #[test]
  fn test_handle_pwaislands_request() {
    let root = PathBuf::from(STORAGE_ROOT);
    fs::create_dir_all(&root).unwrap();
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
    let req = Request::builder()
      .uri("pwaislands://localhost/non_existent_file.xyz")
      .body(Vec::new())
      .unwrap();

    let res = handle_pwaislands_request(&req);
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
  }

  #[test]
  fn test_handle_pwaislands_request_app_js() {
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
  }

  #[test]
  fn test_handle_pwaislands_api_endpoints() {
    let root = PathBuf::from(STORAGE_ROOT);
    fs::create_dir_all(&root).unwrap();

    // Write file via API
    let write_req = Request::builder()
      .method("POST")
      .uri("pwaislands://localhost/__pwaislands_api__/write?subPath=api_test.txt")
      .body(b"Test Content".to_vec())
      .unwrap();
    let write_res = handle_pwaislands_request(&write_req);
    assert_eq!(write_res.status(), StatusCode::OK);

    // Exists via API
    let exists_req = Request::builder()
      .uri("pwaislands://localhost/__pwaislands_api__/exists?subPath=api_test.txt")
      .body(Vec::new())
      .unwrap();
    let exists_res = handle_pwaislands_request(&exists_req);
    assert_eq!(exists_res.status(), StatusCode::OK);
    assert_eq!(exists_res.body().as_ref(), b"true");

    // Read via API
    let read_req = Request::builder()
      .uri("pwaislands://localhost/__pwaislands_api__/read?subPath=api_test.txt")
      .body(Vec::new())
      .unwrap();
    let read_res = handle_pwaislands_request(&read_req);
    assert_eq!(read_res.status(), StatusCode::OK);
    assert_eq!(read_res.body().as_ref(), b"Test Content");

    // Remove via API
    let rm_req = Request::builder()
      .method("POST")
      .uri("pwaislands://localhost/__pwaislands_api__/remove?subPath=api_test.txt&recursive=false")
      .body(Vec::new())
      .unwrap();
    let rm_res = handle_pwaislands_request(&rm_req);
    assert_eq!(rm_res.status(), StatusCode::OK);

    // Verify removed
    let exists_after = handle_pwaislands_request(&exists_req);
    assert_eq!(exists_after.body().as_ref(), b"false");
  }
}
