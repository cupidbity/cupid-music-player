mod apple;
mod window;
mod ytdlp;

use apple::get_apple_music_token;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;
use window::{set_theme, window_maximize, window_resize};
use ytdlp::get_stream_url;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(ytdlp::StreamCache::new())
        .manage(apple::AppleMusicState::new())
        .manage(window::MaximizeState::new())
        .manage(ytdlp::YtDlpState::new())
        .invoke_handler(tauri::generate_handler![
            get_stream_url,
            get_apple_music_token,
            window_resize,
            window_maximize,
            set_theme,
        ])
        .setup(|app| {
            // Forward cupid:// deep-link URLs to the frontend as a Tauri event.
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                if let Some(url) = event.urls().first() {
                    handle.emit("spotify-callback", url.to_string()).ok();
                }
            });

            // Check for / download yt-dlp on startup (runs in the background).
            let handle2 = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle2.state::<ytdlp::YtDlpState>();
                let dest = handle2
                    .path()
                    .app_data_dir()
                    .ok()
                    .map(|d| d.join("yt-dlp").join(ytdlp::yt_dlp_binary_name()));

                if let Some(dest) = dest {
                    if let Some(parent) = dest.parent() {
                        std::fs::create_dir_all(parent).ok();
                    }
                    ytdlp::update_if_needed(&state, &dest, &handle2).await;
                    if dest.exists() {
                        state.set_path(dest);
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
