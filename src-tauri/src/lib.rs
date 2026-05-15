use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;
use image::GenericImageView;

//  Constants 

const ASPECT: f64 = 415.0 / 675.0;
const STREAM_CACHE_TTL: Duration = Duration::from_secs(25 * 60);

//  Managed state 

struct CacheEntry {
    url: String,
    inserted_at: Instant,
}

struct StreamCache {
    entries: Mutex<HashMap<String, CacheEntry>>,
}

struct CachedToken {
    jwt: String,
    expires_at: Instant,
}

struct AppleMusicState {
    token: Mutex<Option<CachedToken>>,
}

struct SavedBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

struct MaximizeState {
    previous_bounds: Mutex<Option<SavedBounds>>,
}

// Resolved yt-dlp binary path, cached after first discovery/download.
struct YtDlpState {
    path: Mutex<Option<PathBuf>>,
}

//  yt-dlp platform helpers 

/// Asset filename in the GitHub release for the current platform.
fn yt_dlp_asset_name() -> &'static str {
    #[cfg(target_os = "windows")]
    return "yt-dlp.exe";
    #[cfg(target_os = "macos")]
    return "yt-dlp_macos";
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    return "yt-dlp_linux";
}

/// Local binary filename (no triple suffix — we manage the location ourselves).
fn yt_dlp_binary_name() -> &'static str {
    #[cfg(target_os = "windows")]
    return "yt-dlp.exe";
    #[cfg(not(target_os = "windows"))]
    return "yt-dlp";
}

/// Fetch the tag name of the latest yt-dlp GitHub release (e.g. "2025.04.30").
async fn fetch_latest_yt_dlp_version() -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("cupid-player/1.0")
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let resp = client
        .get("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest")
        .send()
        .await
        .map_err(|e| format!("GitHub API request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub API returned status {}", resp.status()));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse GitHub response: {e}"))?;

    json["tag_name"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "No tag_name in GitHub release response".to_string())
}

/// Download yt-dlp for the current platform into `dest`.
/// Emits `yt-dlp-progress` events (0.0–1.0) to the frontend window if available.
async fn download_yt_dlp(
    version: &str,
    dest: &PathBuf,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;

    let url = format!(
        "https://github.com/yt-dlp/yt-dlp/releases/download/{}/{}",
        version,
        yt_dlp_asset_name()
    );

    let client = reqwest::Client::builder()
        .user_agent("cupid-player/1.0")
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Download request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Download returned HTTP {}", resp.status()));
    }

    let total = resp.content_length();

    // Write to a temp file first; rename atomically when done.
    let tmp = dest.with_extension("tmp");
    let mut file = tokio::fs::File::create(&tmp)
        .await
        .map_err(|e| format!("Cannot create temp file: {e}"))?;

    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();

    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download stream error: {e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("File write error: {e}"))?;
        downloaded += chunk.len() as u64;
        if let Some(t) = total {
            let pct = downloaded as f64 / t as f64;
            app.emit("yt-dlp-progress", pct).ok();
        }
    }

    file.flush().await.map_err(|e| format!("File flush error: {e}"))?;
    drop(file);

    // Set executable permission on Unix before rename.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("chmod failed: {e}"))?;
    }

    std::fs::rename(&tmp, dest).map_err(|e| format!("Rename failed: {e}"))?;

    Ok(())
}

/// Return the managed yt-dlp binary path.
///
/// Resolution order:
///   1. Already-resolved path cached in `YtDlpState` (fast path).
///   2. Auto-downloaded binary in `app_data_dir/yt-dlp/`.
///   3. Sidecar bundled in `resource_dir/binaries/` (dev sidecar).
///   4. System `yt-dlp` on PATH.
///
/// Steps 2–4 also trigger an update check in the background.
async fn resolve_yt_dlp(
    state: &tauri::State<'_, YtDlpState>,
    app: &tauri::AppHandle,
) -> PathBuf {
    // Fast path: already resolved.
    {
        let lock = state.path.lock().unwrap();
        if let Some(ref p) = *lock {
            return p.clone();
        }
    }

    // Compute the managed binary location.
    let managed_path: Option<PathBuf> = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("yt-dlp").join(yt_dlp_binary_name()));

    let resolved = if let Some(ref p) = managed_path {
        if p.exists() {
            p.clone()
        } else {
            // Sidecar fallback while the first download hasn't happened yet.
            sidecar_or_system_yt_dlp(app)
        }
    } else {
        sidecar_or_system_yt_dlp(app)
    };

    // Cache the path so subsequent calls are instant.
    *state.path.lock().unwrap() = Some(resolved.clone());

    // Kick off a background update check — doesn't block playback.
    if let Some(dest) = managed_path {
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            let st = app2.state::<YtDlpState>();
            update_yt_dlp_if_needed(&st, &dest, &app2).await;
        });
    }

    resolved
}

fn sidecar_or_system_yt_dlp(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(res_dir) = app.path().resource_dir() {
        let candidate = res_dir
            .join("binaries")
            .join(yt_dlp_binary_name());
        if candidate.exists() {
            return candidate;
        }
    }
    PathBuf::from("yt-dlp")
}

async fn update_yt_dlp_if_needed(
    state: &tauri::State<'_, YtDlpState>,
    dest: &PathBuf,
    app: &tauri::AppHandle,
) {
    let version_file = dest.parent().unwrap().join("version.txt");
    let current = std::fs::read_to_string(&version_file)
        .unwrap_or_default();
    let current = current.trim();

    let latest = match fetch_latest_yt_dlp_version().await {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[yt-dlp updater] Could not fetch latest version: {e}");
            return;
        }
    };

    if dest.exists() && current == latest {
        return; // Already up to date.
    }

    eprintln!("[yt-dlp updater] Downloading {latest}…");

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).ok();
    }

    match download_yt_dlp(&latest, dest, app).await {
        Ok(()) => {
            std::fs::write(&version_file, &latest).ok();
            // Update cached path to the newly downloaded binary.
            *state.path.lock().unwrap() = Some(dest.clone());
            eprintln!("[yt-dlp updater] Updated to {latest}");
            app.emit("yt-dlp-updated", &latest).ok();
        }
        Err(e) => eprintln!("[yt-dlp updater] Download failed: {e}"),
    }
}

//  Commands 

#[tauri::command]
async fn get_stream_url(
    title: String,
    artist: String,
    cache: tauri::State<'_, StreamCache>,
    yt_dlp_state: tauri::State<'_, YtDlpState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let key = format!("{}::{}", title, artist);

    // Check cache first.
    {
        let entries = cache.entries.lock().unwrap();
        if let Some(e) = entries.get(&key) {
            if e.inserted_at.elapsed() < STREAM_CACHE_TTL {
                return Ok(e.url.clone());
            }
        }
    }

    let binary = resolve_yt_dlp(&yt_dlp_state, &app).await;
    let query = format!("ytsearch1:\"{}\" {}", title, artist);

    let output = tokio::time::timeout(
        Duration::from_secs(15),
        tokio::process::Command::new(&binary)
            .args([
                &query,
                "-f", "bestaudio[ext=m4a]/bestaudio",
                "--no-playlist",
                "--no-warnings",
                "-g",
            ])
            .output(),
    )
    .await
    .map_err(|_| "yt-dlp timed out after 15 seconds".to_string())?
    .map_err(|e| format!("yt-dlp failed to launch: {e}"))?;

    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if url.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(format!("No stream URL found. stderr: {stderr}"));
    }

    cache.entries.lock().unwrap().insert(
        key,
        CacheEntry { url: url.clone(), inserted_at: Instant::now() },
    );

    Ok(url)
}

#[tauri::command]
async fn get_apple_music_token(
    state: tauri::State<'_, AppleMusicState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    {
        let lock = state.token.lock().unwrap();
        if let Some(ref t) = *lock {
            if t.expires_at > Instant::now() + Duration::from_secs(60) {
                return Ok(t.jwt.clone());
            }
        }
    }

    let team_id = std::env::var("APPLE_TEAM_ID")
        .map_err(|_| "APPLE_TEAM_ID environment variable is not set".to_string())?;
    let key_id = std::env::var("APPLE_KEY_ID")
        .map_err(|_| "APPLE_KEY_ID environment variable is not set".to_string())?;

    let p8_path = if let Ok(p) = std::env::var("APPLE_KEY_PATH") {
        PathBuf::from(p)
    } else {
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|e| format!("Could not get resource directory: {e}"))?;
        std::fs::read_dir(&resource_dir)
            .map_err(|e| format!("Could not read resource directory: {e}"))?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .find(|p| p.extension().map(|x| x == "p8").unwrap_or(false))
            .ok_or_else(|| format!(
                "No .p8 key file found in {resource_dir:?}. Place it there or set APPLE_KEY_PATH."
            ))?
    };

    let pem = std::fs::read(&p8_path)
        .map_err(|e| format!("Failed to read .p8 key file: {e}"))?;

    use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};

    #[derive(serde::Serialize)]
    struct Claims { iss: String, iat: u64, exp: u64 }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    let claims = Claims { iss: team_id, iat: now, exp: now + 180 * 24 * 3600 };
    let mut header = Header::new(Algorithm::ES256);
    header.kid = Some(key_id);

    let encoding_key = EncodingKey::from_ec_pem(&pem)
        .map_err(|e| format!("Invalid .p8 key (bad PEM format?): {e}"))?;

    let jwt = encode(&header, &claims, &encoding_key)
        .map_err(|e| format!("JWT signing failed: {e}"))?;

    let expires_at = Instant::now() + Duration::from_secs(179 * 24 * 3600);
    *state.token.lock().unwrap() = Some(CachedToken { jwt: jwt.clone(), expires_at });

    Ok(jwt)
}

#[tauri::command]
fn window_resize(
    dx: i32,
    dy: i32,
    corner: String,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;

    // screenX/screenY from the webview are logical (CSS) pixels; outer_size/outer_position
    // are physical pixels. Multiply by scale_factor to match units on HiDPI displays.
    let scale = window.scale_factor().unwrap_or(1.0);
    let dx = (dx as f64 * scale).round() as i32;
    let dy = (dy as f64 * scale).round() as i32;

    let is_right = corner.contains("right");
    let is_bottom = corner.contains("bottom");

    let effective_dx = if is_right { dx } else { -dx };
    let effective_dy = if is_bottom { dy } else { -dy };
    let delta = if effective_dx.abs() > effective_dy.abs() { effective_dx } else { effective_dy };

    let new_width = ((size.width as i32 + delta).max(200)) as u32;
    let new_height = (new_width as f64 / ASPECT).round() as u32;
    let dw = new_width as i32 - size.width as i32;
    let dh = new_height as i32 - size.height as i32;

    window
        .set_size(tauri::Size::Physical(tauri::PhysicalSize { width: new_width, height: new_height }))
        .map_err(|e| e.to_string())?;
    window
        .set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: if is_right { pos.x } else { pos.x - dw },
            y: if is_bottom { pos.y } else { pos.y - dh },
        }))
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn window_maximize(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, MaximizeState>,
) -> Result<(), String> {
    let mut prev = state.previous_bounds.lock().unwrap();

    if let Some(saved) = prev.take() {
        window
            .set_size(tauri::Size::Physical(tauri::PhysicalSize { width: saved.width, height: saved.height }))
            .map_err(|e| e.to_string())?;
        window
            .set_position(tauri::Position::Physical(tauri::PhysicalPosition { x: saved.x, y: saved.y }))
            .map_err(|e| e.to_string())?;
    } else {
        let size = window.outer_size().map_err(|e| e.to_string())?;
        let pos = window.outer_position().map_err(|e| e.to_string())?;
        *prev = Some(SavedBounds { x: pos.x, y: pos.y, width: size.width, height: size.height });

        let monitor = window
            .primary_monitor()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "No primary monitor found".to_string())?;
        let work = monitor.work_area();

        let mut new_w = work.size.width;
        let mut new_h = (new_w as f64 / ASPECT).round() as u32;
        if new_h > work.size.height {
            new_h = work.size.height;
            new_w = (new_h as f64 * ASPECT).round() as u32;
        }

        window
            .set_size(tauri::Size::Physical(tauri::PhysicalSize { width: new_w, height: new_h }))
            .map_err(|e| e.to_string())?;
        window
            .set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                x: work.position.x + ((work.size.width as i32 - new_w as i32) / 2),
                y: work.position.y + ((work.size.height as i32 - new_h as i32) / 2),
            }))
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
fn set_theme(
    theme: String,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let icon_path = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("assets")
        .join(&theme)
        .join("favicon.png");

    let icon_data = std::fs::read(&icon_path)
        .map_err(|e| format!("Could not read theme icon at {icon_path:?}: {e}"))?;

    let img = image::load_from_memory(&icon_data)
        .map_err(|e| format!("Could not decode theme icon: {e}"))?;
    let (width, height) = img.dimensions();
    let rgba = img.to_rgba8().into_raw();
    let tauri_image = tauri::image::Image::new_owned(rgba, width, height);

    window.set_icon(tauri_image).map_err(|e| e.to_string())?;

    Ok(())
}

//  Application entry point 

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(StreamCache { entries: Mutex::new(HashMap::new()) })
        .manage(AppleMusicState { token: Mutex::new(None) })
        .manage(MaximizeState { previous_bounds: Mutex::new(None) })
        .manage(YtDlpState { path: Mutex::new(None) })
        .invoke_handler(tauri::generate_handler![
            get_stream_url,
            get_apple_music_token,
            window_resize,
            window_maximize,
            set_theme,
        ])
        .setup(|app| {
            // Forward deep-link URLs (cupid://...) to the frontend as a Tauri event.
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                if let Some(url) = event.urls().first() {
                    handle.emit("spotify-callback", url.to_string()).ok();
                }
            });

            // Kick off yt-dlp download/update check at startup (background task).
            let handle2 = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let yt_dlp_state = handle2.state::<YtDlpState>();
                let managed_path = handle2
                    .path()
                    .app_data_dir()
                    .ok()
                    .map(|d| d.join("yt-dlp").join(yt_dlp_binary_name()));

                if let Some(dest) = managed_path {
                    if let Some(parent) = dest.parent() {
                        std::fs::create_dir_all(parent).ok();
                    }
                    update_yt_dlp_if_needed(&yt_dlp_state, &dest, &handle2).await;
                    // Cache the resolved path after startup download completes.
                    if dest.exists() {
                        *yt_dlp_state.path.lock().unwrap() = Some(dest);
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
