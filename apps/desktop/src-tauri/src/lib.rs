mod daemon;
mod framing;
mod idle;
mod supervisor;

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, WindowEvent};

use supervisor::{Supervisor, SupervisorState};

/// Daemon methods the webview may call. `setIdle` and `shutdown` belong to the shell.
const UI_METHODS: &[&str] = &[
    "getStatus",
    "getConfig",
    "saveConfig",
    "setMode",
    "resume",
    "setKey",
    "deleteKey",
    "probeProvider",
];

fn is_ui_method(method: &str) -> bool {
    UI_METHODS.contains(&method)
}

/// Params may contain an API key (`setKey`): never log them, nor the response.
#[tauri::command]
async fn daemon_request(
    supervisor: State<'_, Arc<Supervisor>>,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    if !is_ui_method(&method) {
        return Err(format!("Method {method} is not available"));
    }
    let handle = supervisor
        .handle()
        .ok_or_else(|| "The worker is not running".to_string())?;
    handle
        .request(&method, params.unwrap_or_else(|| json!({})))
        .await
}

#[tauri::command]
fn restart_worker(supervisor: State<'_, Arc<Supervisor>>) {
    supervisor.restart();
}

#[tauri::command]
fn supervisor_state(supervisor: State<'_, Arc<Supervisor>>) -> SupervisorState {
    supervisor.state()
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn supervisor_of(app: &AppHandle) -> Arc<Supervisor> {
    app.state::<Arc<Supervisor>>().inner().clone()
}

/// One poll: is the user away (no input for the threshold, and not in a
/// full-screen app or presentation)? Reports changes to the daemon and returns
/// the sampled state, which sets the next poll interval.
fn poll_idle(supervisor: &Arc<Supervisor>) -> bool {
    // Unknown idle time counts as "in use": never contribute on a guess.
    let since = idle::time_since_last_input().unwrap_or(Duration::ZERO);
    let busy = idle::user_busy();
    let (now_idle, change) = {
        let mut tracker = supervisor.idle_tracker();
        let now_idle = tracker.is_idle(since, busy);
        (now_idle, tracker.update_with(now_idle))
    };
    if let Some(is_idle) = change {
        supervisor.send_idle(is_idle);
    }
    now_idle
}

fn spawn_idle_poller(supervisor: Arc<Supervisor>) {
    std::thread::spawn(move || loop {
        let now_idle = poll_idle(&supervisor);
        std::thread::sleep(idle::poll_interval(now_idle));
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be registered first: a second launch just focuses the running app.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app)
        }))
        .invoke_handler(tauri::generate_handler![
            daemon_request,
            restart_worker,
            supervisor_state
        ])
        .on_window_event(|window, event| {
            // Closing the window keeps contributing from the tray; Quit is in the tray menu.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            let toggle = MenuItemBuilder::with_id("toggle", "Pause contributions").build(app)?;
            let menu = MenuBuilder::new(app)
                .text("open", "Open AI Commons")
                .item(&toggle)
                .separator()
                .text("quit", "Quit")
                .build()?;
            let icon = app
                .default_window_icon()
                .cloned()
                .ok_or("missing app icon")?;
            let tray = TrayIconBuilder::with_id("main")
                .icon(icon)
                .tooltip("AI Commons")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "toggle" => {
                        let supervisor = supervisor_of(app);
                        tauri::async_runtime::spawn(async move { supervisor.toggle_pause().await });
                    }
                    "quit" => {
                        let supervisor = supervisor_of(app);
                        // Ignore further Quit clicks while the worker drains.
                        if !supervisor.begin_quit() {
                            return;
                        }
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.hide();
                        }
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            supervisor.shutdown().await;
                            app.exit(0);
                        });
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            let paths = daemon::DaemonPaths::in_resources(&app.path().resource_dir()?);
            let supervisor = Supervisor::new(app.handle().clone(), paths, toggle, tray);
            app.manage(supervisor.clone());
            supervisor.start();
            spawn_idle_poller(supervisor);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running AI Commons");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_webview_cannot_reach_shell_only_methods() {
        assert!(is_ui_method("getStatus"));
        assert!(is_ui_method("setKey"));
        assert!(!is_ui_method("setIdle"));
        assert!(!is_ui_method("shutdown"));
        assert!(!is_ui_method(""));
    }
}
