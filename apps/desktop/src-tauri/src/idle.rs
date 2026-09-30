//! OS idle detection for `idle_only` scheduling.

use std::time::Duration;

pub const POLL_INTERVAL: Duration = Duration::from_secs(15);
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

    /// Returns the new state when it differs from the last reported one.
    pub fn update(&mut self, since_input: Duration) -> Option<bool> {
        let idle = since_input >= self.threshold;
        if self.last == Some(idle) {
            return None;
        }
        self.last = Some(idle);
        Some(idle)
    }
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

    #[cfg(windows)]
    #[test]
    fn reads_os_idle_time() {
        assert!(time_since_last_input().is_some());
    }
}
