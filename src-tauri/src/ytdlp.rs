use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Emitter;
use tauri::Manager;

const STREAM_CACHE_TTL: Duration = Duration::from_secs(25 * 60);

// State 

struct CacheEntry {
    url: String,
    inserted_at: Instant,
}

pub struct StreamCache {
    entries: Mutex<HashMap<String, CacheEntry>>,
}

impl StreamCache {
    pub fn new() -> Self {
        Self { entries: Mutex::new(HashMap::new()) }
    }
}

pub struct YtDlpState {
    path: Mutex<Option<PathBuf>>,
}

impl YtDlpState {
    pub fn new() -> Self {
        Self { path: Mutex::new(None) }
    }

    pub fn set_path(&self, p: PathBuf) {
        *self.path.lock().unwrap() = Some(p);
    }
}

//  Platform helpers 

fn yt_dlp_asset_name() -> &'static str {
    #[cfg(target_os = "windows")]
    return "yt-dlp.exe";
    #[cfg(target_os = "macos")]
    return "yt-dlp_macos";
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    return "yt-dlp_linux";
}

/// Local binary filename — no target-triple suffix since we manage the path ourselves.
pub(crate) fn yt_dlp_binary_name() -> &'static str {
    #[cfg(target_os = "windows")]
    return "yt-dlp.exe";
    #[cfg(not(target_os = "windows"))]
    return "yt-dlp";
}

//  Download / update logic 

async fn fetch_latest_version() -> Result<String, String> {
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

async fn download(version: &str, dest: &PathBuf, app: &tauri::AppHandle) -> Result<(), String> {
    use futures_util::StreamExt;
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
    let tmp = dest.with_extension("tmp");
    let mut file = tokio::fs::File::create(&tmp)
        .await
        .map_err(|e| format!("Cannot create temp file: {e}"))?;

    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download stream error: {e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("File write error: {e}"))?;
        downloaded += chunk.len() as u64;
        if let Some(t) = total {
            app.emit("yt-dlp-progress", downloaded as f64 / t as f64).ok();
        }
    }

    file.flush().await.map_err(|e| format!("File flush error: {e}"))?;
    drop(file);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("chmod failed: {e}"))?;
    }

    std::fs::rename(&tmp, dest).map_err(|e| format!("Rename failed: {e}"))?;
    Ok(())
}

/// Check GitHub for a newer yt-dlp release; download if the local copy is missing or outdated.
pub(crate) async fn update_if_needed(
    state: &tauri::State<'_, YtDlpState>,
    dest: &PathBuf,
    app: &tauri::AppHandle,
) {
    let version_file = dest.parent().unwrap().join("version.txt");
    let current = std::fs::read_to_string(&version_file).unwrap_or_default();
    let current = current.trim();

    let latest = match fetch_latest_version().await {
        Ok(v) => v,
        Err(e) => { eprintln!("[yt-dlp] Could not fetch latest version: {e}"); return; }
    };

    if dest.exists() && current == latest {
        return;
    }

    eprintln!("[yt-dlp] Downloading {latest}…");
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).ok();
    }

    match download(&latest, dest, app).await {
        Ok(()) => {
            std::fs::write(&version_file, &latest).ok();
            *state.path.lock().unwrap() = Some(dest.clone());
            eprintln!("[yt-dlp] Updated to {latest}");
            app.emit("yt-dlp-updated", &latest).ok();
        }
        Err(e) => eprintln!("[yt-dlp] Download failed: {e}"),
    }
}

fn sidecar_or_system(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(res_dir) = app.path().resource_dir() {
        let candidate = res_dir.join("binaries").join(yt_dlp_binary_name());
        if candidate.exists() {
            return candidate;
        }
    }
    PathBuf::from("yt-dlp")
}

/// Resolve the yt-dlp binary path, using the cached value on the hot path.
async fn resolve(state: &tauri::State<'_, YtDlpState>, app: &tauri::AppHandle) -> PathBuf {
    {
        let lock = state.path.lock().unwrap();
        if let Some(ref p) = *lock {
            return p.clone();
        }
    }

    let managed: Option<PathBuf> = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("yt-dlp").join(yt_dlp_binary_name()));

    let resolved = match &managed {
        Some(p) if p.exists() => p.clone(),
        _ => sidecar_or_system(app),
    };

    *state.path.lock().unwrap() = Some(resolved.clone());

    if let Some(dest) = managed {
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            let st = app2.state::<YtDlpState>();
            update_if_needed(&st, &dest, &app2).await;
        });
    }

    resolved
}

//  Command 

#[tauri::command]
pub async fn get_stream_url(
    title: String,
    artist: String,
    cache: tauri::State<'_, StreamCache>,
    yt_dlp_state: tauri::State<'_, YtDlpState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let key = format!("{}::{}", title, artist);

    {
        let entries = cache.entries.lock().unwrap();
        if let Some(e) = entries.get(&key) {
            if e.inserted_at.elapsed() < STREAM_CACHE_TTL {
                return Ok(e.url.clone());
            }
        }
    }

    let binary = resolve(&yt_dlp_state, &app).await;
    let query = format!("ytsearch1:\"{}\" {}", title, artist);

    let output = tokio::time::timeout(
        Duration::from_secs(15),
        tokio::process::Command::new(&binary)
            .args([&query, "-f", "bestaudio[ext=m4a]/bestaudio",
                   "--no-playlist", "--no-warnings", "-g"])
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

    cache.entries.lock().unwrap().insert(key, CacheEntry { url: url.clone(), inserted_at: Instant::now() });
    Ok(url)
}
