//! Keeps the worker daemon running, relays its status to the UI and tray, and
//! shuts it down gracefully on quit.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::menu::MenuItem;
use tauri::tray::TrayIcon;
use tauri::{AppHandle, Emitter, Wry};

use crate::daemon::{self, lock, DaemonHandle, DaemonPaths};
use crate::idle::{IdleTracker, DEFAULT_THRESHOLD};

const MAX_CRASHES: usize = 5;
const CRASH_WINDOW: Duration = Duration::from_secs(5 * 60);

/// Backoff 1 s, 2 s, 4 s, 8 s; gives up on the 5th crash within 5 minutes.
pub struct RestartPolicy {
    crashes: VecDeque<Instant>,
}

impl Default for RestartPolicy {
    fn default() -> Self {
        Self::new()
    }
}

impl RestartPolicy {
    pub fn new() -> Self {
        Self {
            crashes: VecDeque::new(),
        }
    }

    /// Records a crash; returns the delay before restarting, or None to give up.
    pub fn on_crash(&mut self, now: Instant) -> Option<Duration> {
        while let Some(&first) = self.crashes.front() {
            if now.duration_since(first) > CRASH_WINDOW {
                self.crashes.pop_front();
            } else {
                break;
            }
        }
        self.crashes.push_back(now);
        if self.crashes.len() >= MAX_CRASHES {
            return None;
        }
        Some(Duration::from_secs(1 << (self.crashes.len() - 1)))
    }

    pub fn reset(&mut self) {
        self.crashes.clear();
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SupervisorState {
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

pub fn tooltip(connection: &str, mode: &str, idle: bool) -> String {
    let state = match (connection, mode) {
        (_, "paused") => "Paused",
        ("offline", _) => "Offline",
        ("unconfigured", _) => "Not set up",
        ("connected", "idle_only") if !idle => "Waiting for idle",
        ("connected", _) => "Contributing",
        _ => "Connecting",
    };
    format!("AI Commons — {state}")
}

pub const STOPPING_MESSAGE: &str = "Finishing the current task…";
pub const STOPPING_TOOLTIP: &str = "AI Commons — Stopping";

/// The tray tooltip for a status event; once quitting it stays on "Stopping",
/// even though the draining daemon keeps sending status.
pub fn tray_tooltip(quitting: bool, connection: &str, mode: &str, idle: bool) -> String {
    if quitting {
        STOPPING_TOOLTIP.to_string()
    } else {
        tooltip(connection, mode, idle)
    }
}

fn exit_code(code: Option<i32>) -> String {
    code.map_or_else(|| "none".to_string(), |c| c.to_string())
}

/// Every exit the shell did not ask for counts as a crash, whatever the code:
/// a job kill, for one, exits with 0.
pub fn restarting_message(code: Option<i32>, delay: Duration) -> String {
    format!(
        "The worker exited unexpectedly (code {}); restarting in {} s.",
        exit_code(code),
        delay.as_secs()
    )
}

pub struct Supervisor {
    app: AppHandle,
    paths: DaemonPaths,
    handle: Mutex<Option<Arc<DaemonHandle>>>,
    policy: Mutex<RestartPolicy>,
    state: Mutex<SupervisorState>,
    mode: Mutex<String>,
    idle: Mutex<IdleTracker>,
    quitting: AtomicBool,
    toggle: MenuItem<Wry>,
    tray: TrayIcon<Wry>,
}

impl Supervisor {
    pub fn new(
        app: AppHandle,
        paths: DaemonPaths,
        toggle: MenuItem<Wry>,
        tray: TrayIcon<Wry>,
    ) -> Arc<Self> {
        Arc::new(Self {
            app,
            paths,
            handle: Mutex::new(None),
            policy: Mutex::new(RestartPolicy::new()),
            state: Mutex::new(SupervisorState {
                state: "running",
                message: None,
            }),
            mode: Mutex::new("active".into()),
            idle: Mutex::new(IdleTracker::new(DEFAULT_THRESHOLD)),
            quitting: AtomicBool::new(false),
            toggle,
            tray,
        })
    }

    pub fn start(self: &Arc<Self>) {
        if self.quitting.load(Ordering::SeqCst) {
            return;
        }
        let mut slot = lock(&self.handle);
        if slot.is_some() {
            return;
        }
        let weak = Arc::downgrade(self);
        let events = weak.clone();
        let on_event = move |data: Value| {
            if let Some(me) = events.upgrade() {
                me.on_status(data);
            }
        };
        let on_exit = move |code: Option<i32>| {
            if let Some(me) = weak.upgrade() {
                me.on_exit(code);
            }
        };
        match daemon::spawn(&self.paths, on_event, on_exit) {
            Ok(handle) => {
                let message = handle.job_error().map(|reason| {
                    #[cfg(debug_assertions)]
                    eprintln!("worker daemon has no job object: {reason}");
                    format!("Running without crash cleanup: {reason}")
                });
                *slot = Some(handle);
                drop(slot);
                // A new daemon starts out "not idle": report the current state again.
                lock(&self.idle).reset();
                self.set_state("running", message);
            }
            Err(error) => {
                drop(slot);
                self.set_state(
                    "stopped",
                    Some(format!("Could not start the worker runtime: {error}")),
                );
            }
        }
    }

    /// User-requested restart from the UI: forget earlier crashes.
    pub fn restart(self: &Arc<Self>) {
        lock(&self.policy).reset();
        self.start();
    }

    pub fn handle(&self) -> Option<Arc<DaemonHandle>> {
        lock(&self.handle).clone()
    }

    pub fn state(&self) -> SupervisorState {
        lock(&self.state).clone()
    }

    pub fn idle_tracker(&self) -> MutexGuard<'_, IdleTracker> {
        lock(&self.idle)
    }

    /// Reports an idle change to the daemon. If it cannot be delivered, the
    /// tracker is reset so the next poll reports the state again.
    pub fn send_idle(self: &Arc<Self>, idle: bool) {
        let Some(handle) = self.handle() else {
            lock(&self.idle).record_delivery(false);
            return;
        };
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            let delivered = handle
                .request("setIdle", json!({ "idle": idle }))
                .await
                .is_ok();
            lock(&me.idle).record_delivery(delivered);
        });
    }

    pub async fn toggle_pause(&self) {
        let paused = *lock(&self.mode) == "paused";
        if let Some(handle) = self.handle() {
            let _ = if paused {
                handle.request("resume", json!({})).await
            } else {
                handle.request("setMode", json!({ "mode": "paused" })).await
            };
        }
    }

    /// Drain (finish the current task) for up to 30 s, then kill. Killing mid-call
    /// is budget-safe: stale reservations are charged in full on the next start.
    /// Marks the app as quitting. Returns true for the first call only, so
    /// repeated Quit clicks are ignored.
    pub fn begin_quit(&self) -> bool {
        !self.quitting.swap(true, Ordering::SeqCst)
    }

    pub async fn shutdown(&self) {
        self.quitting.store(true, Ordering::SeqCst);
        self.set_state("stopping", Some(STOPPING_MESSAGE.to_string()));
        let tray = self.tray.clone();
        let _ = self.app.run_on_main_thread(move || {
            let _ = tray.set_tooltip(Some(STOPPING_TOOLTIP));
        });
        let Some(handle) = self.handle() else { return };
        let _ = tokio::time::timeout(
            Duration::from_secs(5),
            handle.request("shutdown", json!({})),
        )
        .await;
        if tokio::time::timeout(Duration::from_secs(30), handle.wait_exit())
            .await
            .is_err()
        {
            handle.kill();
        }
    }

    /// Runs on the daemon's reader thread: it must never block on the UI.
    fn on_status(&self, data: Value) {
        let mode = data["mode"].as_str().unwrap_or("active").to_string();
        let connection = data["connection"].as_str().unwrap_or("connecting");
        let idle = data["idle"].as_bool().unwrap_or(false);
        let minutes = data["idle_after_minutes"]
            .as_u64()
            .unwrap_or(5)
            .clamp(1, 240);
        lock(&self.idle).set_threshold(Duration::from_secs(minutes * 60));

        let label = if mode == "paused" {
            "Resume contributions"
        } else {
            "Pause contributions"
        };
        let tip = tray_tooltip(
            self.quitting.load(Ordering::SeqCst),
            connection,
            &mode,
            idle,
        );
        let toggle = self.toggle.clone();
        let tray = self.tray.clone();
        // Fire and forget: menu and tray updates belong on the main thread.
        let _ = self.app.run_on_main_thread(move || {
            let _ = toggle.set_text(label);
            let _ = tray.set_tooltip(Some(tip));
        });

        *lock(&self.mode) = mode;
        let _ = self.app.emit("worker-event", data);
    }

    fn on_exit(self: &Arc<Self>, code: Option<i32>) {
        {
            let mut slot = lock(&self.handle);
            // Only clear the slot if it still holds the process that exited.
            if slot.as_ref().is_some_and(|h| h.has_exited()) {
                *slot = None;
            }
        }
        if self.quitting.load(Ordering::SeqCst) {
            return;
        }
        let delay = lock(&self.policy).on_crash(Instant::now());
        match delay {
            Some(delay) => {
                self.set_state("restarting", Some(restarting_message(code, delay)));
                let me = self.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(delay);
                    me.start();
                });
            }
            None => self.set_state(
                "stopped",
                Some(format!(
                    "The worker exited repeatedly (last code {}). Details are in worker.log.",
                    exit_code(code)
                )),
            ),
        }
    }

    fn set_state(&self, state: &'static str, message: Option<String>) {
        let next = SupervisorState { state, message };
        *lock(&self.state) = next.clone();
        let _ = self.app.emit("supervisor", next);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn backs_off_then_gives_up_on_the_fifth_crash() {
        let mut policy = RestartPolicy::new();
        let t0 = Instant::now();
        let delays: Vec<_> = (0..5).map(|i| policy.on_crash(t0 + secs(i))).collect();
        assert_eq!(
            delays,
            vec![
                Some(secs(1)),
                Some(secs(2)),
                Some(secs(4)),
                Some(secs(8)),
                None
            ]
        );
    }

    #[test]
    fn forgets_crashes_older_than_the_window() {
        let mut policy = RestartPolicy::new();
        let t0 = Instant::now();
        for i in 0..4 {
            policy.on_crash(t0 + secs(i));
        }
        assert_eq!(policy.on_crash(t0 + secs(400)), Some(secs(1)));
    }

    #[test]
    fn reset_clears_history() {
        let mut policy = RestartPolicy::new();
        let t0 = Instant::now();
        for i in 0..4 {
            policy.on_crash(t0 + secs(i));
        }
        policy.reset();
        assert_eq!(policy.on_crash(t0 + secs(5)), Some(secs(1)));
    }

    #[test]
    fn tooltip_reflects_state() {
        assert_eq!(
            tooltip("connected", "active", false),
            "AI Commons — Contributing"
        );
        assert_eq!(tooltip("connected", "paused", false), "AI Commons — Paused");
        assert_eq!(
            tooltip("connected", "idle_only", false),
            "AI Commons — Waiting for idle"
        );
        assert_eq!(
            tooltip("connected", "idle_only", true),
            "AI Commons — Contributing"
        );
        assert_eq!(tooltip("offline", "active", false), "AI Commons — Offline");
        assert_eq!(
            tooltip("unconfigured", "active", false),
            "AI Commons — Not set up"
        );
        assert_eq!(
            tooltip("connecting", "active", false),
            "AI Commons — Connecting"
        );
    }

    #[test]
    fn the_tooltip_stays_on_stopping_while_quitting() {
        assert_eq!(
            tray_tooltip(true, "connected", "active", false),
            "AI Commons — Stopping"
        );
        assert_eq!(
            tray_tooltip(false, "connected", "active", false),
            "AI Commons — Contributing"
        );
    }

    #[test]
    fn every_unexpected_exit_reads_as_a_crash() {
        assert_eq!(
            restarting_message(Some(0), secs(2)),
            "The worker exited unexpectedly (code 0); restarting in 2 s."
        );
        assert_eq!(
            restarting_message(None, secs(1)),
            "The worker exited unexpectedly (code none); restarting in 1 s."
        );
    }
}
