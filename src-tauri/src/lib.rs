	use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

// Aspect ratio (415 × 675 px window)
const ASPECT: f64 = 415.0 / 675.0;

// Managed state

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

const CACHE_TTL: Duration = Duration::from_secs(25 * 60);

//  yt-dlp sidecar path helper 
fn yt_dlp_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    // Tauri renames sidecar binaries with the target triple suffix at build time.
    // In dev, fall back to system yt-dlp on PATH.
    if let Ok(res_dir) = app.path().resource_dir() {
        // When declared in externalBin, Tauri places them here at runtime.
        let candidate = res_dir.join("binaries").join(format!("yt-dlp{}", EXE_SUFFIX));
        if candidate.exists() {
            return candidate;
        }
    }
    // Fall back to system yt-dlp (works in `cargo tauri dev`)
    std::path::PathBuf::from("yt-dlp")
}

#[cfg(target_os = "windows")]
const EXE_SUFFIX: &str = ".exe";
#[cfg(not(target_os = "windows"))]
const EXE_SUFFIX: &str = "";

//  Commands 

#[tauri::command]
async fn get_stream_url(
    title: String,
    artist: String,
    cache: tauri::State<'_, StreamCache>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let key = format!("{}::{}", title, artist);

    // Check cache without holding the lock during the slow network call.
    {
        let entries = cache.entries.lock().unwrap();
        if let Some(e) = entries.get(&key) {
            if e.inserted_at.elapsed() < CACHE_TTL {
                return Ok(e.url.clone());
            }
        }
    }

    let binary = yt_dlp_path(&app);
    let query = format!("ytsearch1:\"{}\" {}", title, artist);

    let output = tokio::time::timeout(
        Duration::from_secs(15),
        tokio::process::Command::new(&binary)
            .args([
                &query,
                "-f",
                "bestaudio[ext=m4a]/bestaudio",
                "--no-playlist",
                "--no-warnings",
                "-g",
            ])
            .output(),
    )
    .await
    .map_err(|_| "yt-dlp timed out after 15 seconds".to_string())?
    .map_err(|e| format!("yt-dlp failed to launch: {e}"))?;

    let url = String::from_utf8_lossy(&output.stdout)
        .trim()
        .to_string();

    if url.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(format!("No stream URL found. stderr: {stderr}"));
    }

    cache.entries.lock().unwrap().insert(
        key,
        CacheEntry {
            url: url.clone(),
            inserted_at: Instant::now(),
        },
    );

    Ok(url)
}

#[tauri::command]
async fn get_apple_music_token(
    state: tauri::State<'_, AppleMusicState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    // Return cached token if still valid.
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

    // Locate .p8 key file: check explicit env var first, then resource_dir.
    let p8_path = if let Ok(p) = std::env::var("APPLE_KEY_PATH") {
        std::path::PathBuf::from(p)
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
            .ok_or_else(|| {
                format!(
                    "No .p8 key file found in {:?}. Place it there or set APPLE_KEY_PATH.",
                    resource_dir
                )
            })?
    };

    let pem = std::fs::read(&p8_path)
        .map_err(|e| format!("Failed to read .p8 key file: {e}"))?;

    use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};

    #[derive(serde::Serialize)]
    struct Claims {
        iss: String,
        iat: u64,
        exp: u64,
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    let claims = Claims {
        iss: team_id,
        iat: now,
        exp: now + 180 * 24 * 3600,
    };

    let mut header = Header::new(Algorithm::ES256);
    header.kid = Some(key_id);

    let encoding_key = EncodingKey::from_ec_pem(&pem)
        .map_err(|e| format!("Invalid .p8 key (bad PEM format?): {e}"))?;

    let jwt = encode(&header, &claims, &encoding_key)
        .map_err(|e| format!("JWT signing failed: {e}"))?;

    let expires_at = Instant::now() + Duration::from_secs(179 * 24 * 3600);
    *state.token.lock().unwrap() = Some(CachedToken {
        jwt: jwt.clone(),
        expires_at,
    });

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

    let is_right = corner.contains("right");
    let is_bottom = corner.contains("bottom");

    let effective_dx = if is_right { dx } else { -dx };
    let effective_dy = if is_bottom { dy } else { -dy };

    let delta = if effective_dx.abs() > effective_dy.abs() {
        effective_dx
    } else {
        effective_dy
    };

    let new_width = ((size.width as i32 + delta).max(200)) as u32;
    let new_height = (new_width as f64 / ASPECT).round() as u32;
    let dw = new_width as i32 - size.width as i32;
    let dh = new_height as i32 - size.height as i32;

    let new_x = if is_right { pos.x } else { pos.x - dw };
    let new_y = if is_bottom { pos.y } else { pos.y - dh };

    window
        .set_size(tauri::Size::Physical(tauri::PhysicalSize {
            width: new_width,
            height: new_height,
        }))
        .map_err(|e| e.to_string())?;

    window
        .set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: new_x,
            y: new_y,
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
        // Restore previous size and position.
        window
            .set_size(tauri::Size::Physical(tauri::PhysicalSize {
                width: saved.width,
                height: saved.height,
            }))
            .map_err(|e| e.to_string())?;
        window
            .set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                x: saved.x,
                y: saved.y,
            }))
            .map_err(|e| e.to_string())?;
    } else {
        // Save current bounds, then fit the screen while maintaining aspect ratio.
        let size = window.outer_size().map_err(|e| e.to_string())?;
        let pos = window.outer_position().map_err(|e| e.to_string())?;

        *prev = Some(SavedBounds {
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
        });

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

        let new_x = work.position.x + ((work.size.width as i32 - new_w as i32) / 2);
        let new_y = work.position.y + ((work.size.height as i32 - new_h as i32) / 2);

        window
            .set_size(tauri::Size::Physical(tauri::PhysicalSize {
                width: new_w,
                height: new_h,
            }))
            .map_err(|e| e.to_string())?;
        window
            .set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                x: new_x,
                y: new_y,
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
        .map_err(|e| format!("Could not read theme icon at {:?}: {e}", icon_path))?;

    let image = tauri::image::Image::from_bytes(&icon_data)
        .map_err(|e| format!("Could not decode theme icon: {e}"))?;

    window.set_icon(image).map_err(|e| e.to_string())?;

    Ok(())
}

//  Application entry point 

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(StreamCache {
            entries: Mutex::new(HashMap::new()),
        })
        .manage(AppleMusicState {
            token: Mutex::new(None),
        })
        .manage(MaximizeState {
            previous_bounds: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            get_stream_url,
            get_apple_music_token,
            window_resize,
            window_maximize,
            set_theme,
        ])
        .setup(|app| {
            // Forward deep-link URLs (cupid://...) to the frontend as an event.
            let handle = app.handle().clone();
            app.deep_link().on_open_urls(move |event| {
                if let Some(url) = event.urls().first() {
                    handle.emit("spotify-callback", url.to_string()).ok();
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
