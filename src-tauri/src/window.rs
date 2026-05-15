use image::GenericImageView;
use std::sync::Mutex;
use tauri::Manager;

const ASPECT: f64 = 415.0 / 675.0;

//  State 

struct SavedBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

pub struct MaximizeState {
    previous_bounds: Mutex<Option<SavedBounds>>,
}

impl MaximizeState {
    pub fn new() -> Self {
        Self { previous_bounds: Mutex::new(None) }
    }
}

//  Commands 

#[tauri::command]
pub fn window_resize(
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
pub fn window_maximize(
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
pub fn set_theme(
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

    window
        .set_icon(tauri::image::Image::new_owned(rgba, width, height))
        .map_err(|e| e.to_string())?;

    Ok(())
}
