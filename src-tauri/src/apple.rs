use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

//  State 

struct CachedToken {
    jwt: String,
    expires_at: Instant,
}

pub struct AppleMusicState {
    token: Mutex<Option<CachedToken>>,
}

impl AppleMusicState {
    pub fn new() -> Self {
        Self { token: Mutex::new(None) }
    }
}

//  Command 

#[tauri::command]
pub async fn get_apple_music_token(
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
