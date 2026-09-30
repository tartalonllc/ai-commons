//! OS idle detection for `idle_only` scheduling.

use std::time::Duration;

/// Poll often while idle, so returning to the machine stops work quickly.
pub const IDLE_POLL_INTERVAL: Duration = Duration::from_secs(2);
/// Poll rarely while the user is active: becoming idle takes minutes anyway.
pub const ACTIVE_POLL_INTERVAL: Duration = Duration::from_secs(15);
pub const DEFAULT_THRESHOLD: Duration = Duration::from_secs(5 * 60);

/// Turns "time since last input" samples into idle/active transitions.
#[derive(Debug)]
pub struct IdleTracker {
    threshold: Duration,
    last: Option<bool>,
}

impl IdleTracker {
    pub fn new(threshold: Duration) -> Self {
        Self {
            threshold,
            last: None,
        }
    }

    pub fn set_threshold(&mut self, threshold: Duration) {
        self.threshold = threshold;
    }

    /// Forget the last reported state so the next sample is reported again
    /// (a restarted daemon starts out "not idle").
    pub fn reset(&mut self) {
        self.last = None;
    }

    /// Whether a sample counts as idle: enough time without input, and the user
    /// is not in a full-screen app, a presentation or otherwise busy.
    pub fn is_idle(&self, since_input: Duration, user_busy: bool) -> bool {
        since_input >= self.threshold && !user_busy
    }

    /// Returns the new state when it differs from the last reported one.
    #[cfg(test)]
    pub fn update(&mut self, since_input: Duration) -> Option<bool> {
        self.update_with(self.is_idle(since_input, false))
    }

    /// Like `update`, for an already computed idle state.
    pub fn update_with(&mut self, idle: bool) -> Option<bool> {
        if self.last == Some(idle) {
            return None;
        }
        self.last = Some(idle);
        Some(idle)
    }

    /// Call once per reported change. A change that never reached the daemon
    /// must be reported again: a lost "not idle" would let the worker run
    /// while the user is at the machine.
    pub fn record_delivery(&mut self, delivered: bool) {
        if !delivered {
            self.reset();
        }
    }
}

/// How long the poller waits before the next sample.
pub fn poll_interval(idle: bool) -> Duration {
    if idle {
        IDLE_POLL_INTERVAL
    } else {
        ACTIVE_POLL_INTERVAL
    }
}

/// Whether a `SHQueryUserNotificationState` result means the user is busy:
/// a full-screen D3D app, presentation mode, or "busy" (another full-screen app).
#[cfg_attr(not(windows), allow(dead_code))]
fn notification_state_is_busy(state: i32) -> bool {
    // QUNS_BUSY = 2, QUNS_RUNNING_D3D_FULL_SCREEN = 3, QUNS_PRESENTATION_MODE = 4.
    matches!(state, 2..=4)
}

/// Whether the user is busy in a way input timing alone misses (a game or
/// video in full screen, a presentation). Errors count as not busy.
#[cfg(windows)]
pub fn user_busy() -> bool {
    use windows_sys::Win32::UI::Shell::{
        SHQueryUserNotificationState, QUERY_USER_NOTIFICATION_STATE,
    };

    let mut state: QUERY_USER_NOTIFICATION_STATE = 0;
    // SAFETY: `state` is a valid, writable QUERY_USER_NOTIFICATION_STATE.
    let result = unsafe { SHQueryUserNotificationState(&mut state) };
    result >= 0 && notification_state_is_busy(state)
}

#[cfg(not(windows))]
pub fn user_busy() -> bool {
    false
}

/// Time since the last keyboard or mouse input in this session, if the OS can tell us.
///
/// `GetLastInputInfo` is scoped to the calling process's session, not the whole
/// machine: a process running in session 0 (a Windows service) never sees real
/// user input and this will always report as idle. Call this only from the
/// interactive tray app, which runs in the logged-in user's session, never
/// from a background service.
#[cfg(windows)]
pub fn time_since_last_input() -> Option<Duration> {
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    // SAFETY: `info` is a correctly sized, writable LASTINPUTINFO.
    if unsafe { GetLastInputInfo(&mut info) } == 0 {
        return None;
    }
    // SAFETY: GetTickCount has no preconditions.
    let now = unsafe { GetTickCount() };
    // Both are 32-bit millisecond tick counts; wrapping_sub survives the 49.7-day rollover.
    Some(Duration::from_millis(u64::from(
        now.wrapping_sub(info.dwTime),
    )))
}

#[cfg(not(windows))]
pub fn time_since_last_input() -> Option<Duration> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn reports_the_first_sample_then_only_changes() {
        let mut t = IdleTracker::new(secs(300));
        assert_eq!(t.update(secs(10)), Some(false));
        assert_eq!(t.update(secs(20)), None);
        assert_eq!(t.update(secs(300)), Some(true));
        assert_eq!(t.update(secs(900)), None);
        assert_eq!(t.update(secs(0)), Some(false));
    }

    #[test]
    fn threshold_changes_apply_to_the_next_sample() {
        let mut t = IdleTracker::new(secs(300));
        assert_eq!(t.update(secs(120)), Some(false));
        t.set_threshold(secs(60));
        assert_eq!(t.update(secs(120)), Some(true));
    }

    #[test]
    fn reset_reports_the_current_state_again() {
        let mut t = IdleTracker::new(secs(300));
        assert_eq!(t.update(secs(10)), Some(false));
        t.reset();
        assert_eq!(t.update(secs(10)), Some(false));
    }

    #[test]
    fn busy_users_are_never_idle() {
        let t = IdleTracker::new(secs(300));
        assert!(t.is_idle(secs(600), false));
        assert!(!t.is_idle(secs(600), true));
        assert!(!t.is_idle(secs(10), false));
        assert!(!t.is_idle(secs(10), true));
    }

    #[test]
    fn update_with_reports_only_changes() {
        let mut t = IdleTracker::new(secs(300));
        assert_eq!(t.update_with(true), Some(true));
        assert_eq!(t.update_with(true), None);
        // Starting a full-screen game makes the next sample "not idle".
        let busy_sample = t.is_idle(secs(900), true);
        assert_eq!(t.update_with(busy_sample), Some(false));
    }

    #[test]
    fn a_failed_delivery_is_reported_again() {
        let mut t = IdleTracker::new(secs(300));
        assert_eq!(t.update(secs(10)), Some(false));
        t.record_delivery(false);
        assert_eq!(t.update(secs(10)), Some(false));
        t.record_delivery(true);
        assert_eq!(t.update(secs(10)), None);
    }

    #[test]
    fn polls_faster_while_idle() {
        assert_eq!(poll_interval(true), secs(2));
        assert_eq!(poll_interval(false), secs(15));
    }

    #[test]
    fn maps_notification_states() {
        // NOT_PRESENT, ACCEPTS_NOTIFICATIONS, QUIET_TIME, APP and unknown values are not busy.
        for state in [0, 1, 5, 6, 7, 99] {
            assert!(!notification_state_is_busy(state), "{state}");
        }
        for state in [2, 3, 4] {
            assert!(notification_state_is_busy(state), "{state}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn maps_the_windows_constants() {
        use windows_sys::Win32::UI::Shell::{
            QUNS_ACCEPTS_NOTIFICATIONS, QUNS_BUSY, QUNS_PRESENTATION_MODE,
            QUNS_RUNNING_D3D_FULL_SCREEN,
        };
        assert!(notification_state_is_busy(QUNS_BUSY));
        assert!(notification_state_is_busy(QUNS_RUNNING_D3D_FULL_SCREEN));
        assert!(notification_state_is_busy(QUNS_PRESENTATION_MODE));
        assert!(!notification_state_is_busy(QUNS_ACCEPTS_NOTIFICATIONS));
    }

    #[cfg(windows)]
    #[test]
    fn queries_the_notification_state() {
        // Only checks the call is safe to make; the answer depends on the desktop.
        let _ = user_busy();
    }

    #[cfg(windows)]
    #[test]
    fn reads_os_idle_time() {
        assert!(time_since_last_input().is_some());
    }
}
