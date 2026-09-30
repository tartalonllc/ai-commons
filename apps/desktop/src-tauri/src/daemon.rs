//! Spawns the Node worker daemon and speaks its stdio protocol.
//! Request params and response lines can carry API keys: never log them.

use std::collections::HashMap;
use std::io::{self, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::framing::{Frame, LineReader, MAX_LINE_BYTES};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// How often the reader thread checks whether the child has exited after stdout closed.
const EXIT_POLL: Duration = Duration::from_millis(50);

const NOT_RUNNING: &str = "The worker is not running";
const STOPPED: &str = "The worker stopped";

/// Locks a mutex, ignoring poisoning (a panicked holder must not wedge the app).
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Clone, Debug)]
pub struct DaemonPaths {
    pub node: PathBuf,
    pub script: PathBuf,
}

impl DaemonPaths {
    /// Layout produced by apps/desktop/scripts/stage-runtime.ts.
    pub fn in_resources(resource_dir: &Path) -> Self {
        let runtime = resource_dir.join("runtime");
        Self {
            node: runtime.join(if cfg!(windows) { "node.exe" } else { "node" }),
            script: runtime.join("daemon").join("worker-daemon.mjs"),
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum Incoming {
    Status(Value),
    Response {
        id: String,
        result: Result<Value, String>,
    },
    Ignored,
}

pub fn parse_incoming(line: &str) -> Incoming {
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        return Incoming::Ignored;
    };
    if let Some(event) = message.get("event") {
        return match (event.as_str(), message.get("data")) {
            (Some("status"), Some(data)) => Incoming::Status(data.clone()),
            _ => Incoming::Ignored,
        };
    }
    let Some(id) = message.get("id").and_then(Value::as_str) else {
        return Incoming::Ignored;
    };
    let result = if message.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(message.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(message
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("The worker reported an error")
            .to_string())
    };
    Incoming::Response {
        id: id.to_string(),
        result,
    }
}

pub fn request_line(id: &str, method: &str, params: &Value) -> Result<String, String> {
    let line = serde_json::to_string(&json!({ "id": id, "method": method, "params": params }))
        .map_err(|_| "Could not encode the request".to_string())?;
    if line.len() > MAX_LINE_BYTES {
        return Err("The request is too large".into());
    }
    Ok(line)
}

type Pending = HashMap<String, oneshot::Sender<Result<Value, String>>>;

/// Responses still awaited, plus whether stdout has closed. Both live under one
/// lock so a request can never be registered after the reader drained the map.
struct PendingState {
    waiting: Pending,
    closed: bool,
}

pub struct DaemonHandle {
    /// Lines for the writer thread, which owns the child's stdin.
    writer: mpsc::Sender<String>,
    pending: Mutex<PendingState>,
    next_id: AtomicU64,
    /// Held only briefly (try_wait / kill), so `kill` never blocks for long.
    child: Mutex<Child>,
    exited: AtomicBool,
    /// Kills the daemon when the shell exits, even on a crash. Closed on drop.
    #[cfg(windows)]
    _job: Option<job::JobObject>,
    /// Why the Job Object could not be set up, if it could not.
    job_error: Option<String>,
}

/// Starts the daemon. `on_event` receives each status payload; `on_exit` runs once
/// on the reader thread after the process has exited.
pub fn spawn<E, X>(paths: &DaemonPaths, on_event: E, on_exit: X) -> io::Result<Arc<DaemonHandle>>
where
    E: Fn(Value) + Send + 'static,
    X: FnOnce(Option<i32>) + Send + 'static,
{
    let mut command = Command::new(&paths.node);
    command
        // The bundle ships a .map: crash traces in worker.log point at the TS source.
        .arg("--enable-source-maps")
        .arg(&paths.script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn()?;

    #[cfg(windows)]
    let (job, job_error) = match job::JobObject::kill_on_close_for(&child) {
        Ok(job) => (Some(job), None),
        Err(reason) => {
            eprintln!("worker daemon runs without a job object: {reason}");
            (None, Some(reason))
        }
    };
    #[cfg(not(windows))]
    let job_error: Option<String> = None;

    let missing = || io::Error::other("child stdio was not captured");
    let stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => return Err(kill_after_failure(child, missing())),
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => return Err(kill_after_failure(child, missing())),
    };
    let mut stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => return Err(kill_after_failure(child, missing())),
    };

    let (writer, lines_out) = mpsc::channel::<String>();
    std::thread::spawn(move || write_lines(stdin, &lines_out));

    let handle = Arc::new(DaemonHandle {
        writer,
        pending: Mutex::new(PendingState {
            waiting: HashMap::new(),
            closed: false,
        }),
        next_id: AtomicU64::new(1),
        child: Mutex::new(child),
        exited: AtomicBool::new(false),
        #[cfg(windows)]
        _job: job,
        job_error,
    });

    // The daemon logs to worker.log as well; drain stderr so a full pipe never blocks it.
    std::thread::spawn(move || {
        let mut sink = [0u8; 8192];
        while matches!(stderr.read(&mut sink), Ok(n) if n > 0) {}
    });

    let reader = handle.clone();
    std::thread::spawn(move || {
        let mut lines = LineReader::new(BufReader::new(stdout), MAX_LINE_BYTES);
        loop {
            match lines.next_frame() {
                Ok(Frame::Line(line)) => match parse_incoming(&line) {
                    Incoming::Status(data) => on_event(data),
                    Incoming::Response { id, result } => {
                        if let Some(tx) = lock(&reader.pending).waiting.remove(&id) {
                            let _ = tx.send(result);
                        }
                    }
                    Incoming::Ignored => {}
                },
                // The worker turns oversized responses into errors; nothing to route.
                Ok(Frame::Oversized) => {}
                Ok(Frame::Eof) | Err(_) => break,
            }
        }
        {
            let mut pending = lock(&reader.pending);
            pending.closed = true;
            for (_, tx) in pending.waiting.drain() {
                let _ = tx.send(Err(STOPPED.into()));
            }
        }
        let code = reader.reap();
        reader.exited.store(true, Ordering::SeqCst);
        on_exit(code);
    });

    Ok(handle)
}

fn kill_after_failure(mut child: Child, error: io::Error) -> io::Error {
    let _ = child.kill();
    let _ = child.wait();
    error
}

/// Writer thread body: one line per message, until the channel closes or a write fails.
fn write_lines(mut stdin: ChildStdin, lines: &mpsc::Receiver<String>) {
    for line in lines {
        let written = stdin
            .write_all(line.as_bytes())
            .and_then(|()| stdin.write_all(b"\n"))
            .and_then(|()| stdin.flush());
        if written.is_err() {
            break;
        }
    }
}

impl DaemonHandle {
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = format!("r{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let line = request_line(&id, method, &params)?;
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = lock(&self.pending);
            if pending.closed {
                return Err(NOT_RUNNING.into());
            }
            pending.waiting.insert(id.clone(), tx);
        }
        if self.writer.send(line).is_err() {
            lock(&self.pending).waiting.remove(&id);
            return Err(NOT_RUNNING.into());
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(STOPPED.into()),
            Err(_) => {
                lock(&self.pending).waiting.remove(&id);
                Err("The worker did not respond in time".into())
            }
        }
    }

    /// Polls for the exit status without holding the child lock across waits.
    fn reap(&self) -> Option<i32> {
        loop {
            match lock(&self.child).try_wait() {
                Ok(Some(status)) => return status.code(),
                Ok(None) => {}
                Err(_) => return None,
            }
            std::thread::sleep(EXIT_POLL);
        }
    }

    pub fn has_exited(&self) -> bool {
        self.exited.load(Ordering::SeqCst)
    }

    pub async fn wait_exit(&self) {
        while !self.has_exited() {
            tokio::time::sleep(EXIT_POLL).await;
        }
    }

    pub fn kill(&self) {
        let _ = lock(&self.child).kill();
    }

    /// Why the Windows Job Object could not be set up, if it could not.
    pub fn job_error(&self) -> Option<&str> {
        self.job_error.as_deref()
    }
}

#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// An owned Job Object handle. Closing the last handle kills every process
    /// in the job, which is what ties the daemon's lifetime to the shell's.
    /// Stored as an integer so the handle type is `Send + Sync`.
    pub struct JobObject(usize);

    impl JobObject {
        /// Creates a kill-on-close job and assigns `child` to it.
        ///
        /// `std::process::Command` cannot start a process suspended, so anything
        /// the child spawns between its own start and this assignment is not in
        /// the job and would escape it. The daemon starts no processes at startup.
        ///
        /// Processes killed because the job closed exit with code 0, so an exit
        /// code alone never tells a clean exit from a job kill.
        pub fn kill_on_close_for(child: &Child) -> Result<Self, String> {
            let job = create()?;
            set_kill_on_close(&job)?;
            assign(&job, child.as_raw_handle() as HANDLE)?;
            Ok(job)
        }

        fn raw(&self) -> HANDLE {
            self.0 as HANDLE
        }
    }

    impl Drop for JobObject {
        fn drop(&mut self) {
            close(self.raw());
        }
    }

    fn last_error(what: &str) -> String {
        format!("{what} failed: {}", std::io::Error::last_os_error())
    }

    fn create() -> Result<JobObject, String> {
        // SAFETY: null security attributes and a null name are both documented as
        // valid; the call has no other pointer arguments.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(last_error("CreateJobObjectW"));
        }
        Ok(JobObject(handle as usize))
    }

    fn set_kill_on_close(job: &JobObject) -> Result<(), String> {
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let size = u32::try_from(std::mem::size_of_val(&info))
            .map_err(|_| "job limit struct too large".to_string())?;
        // SAFETY: `job` owns a live job handle; `info` is a properly initialised
        // JOBOBJECT_EXTENDED_LIMIT_INFORMATION that outlives the call, and `size`
        // is its exact size, matching the information class.
        let ok = unsafe {
            SetInformationJobObject(
                job.raw(),
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&info).cast(),
                size,
            )
        };
        if ok == 0 {
            return Err(last_error("SetInformationJobObject"));
        }
        Ok(())
    }

    fn assign(job: &JobObject, process: HANDLE) -> Result<(), String> {
        // SAFETY: `job` owns a live job handle and `process` is borrowed from a
        // `Child` the caller still owns, so both handles are valid for the call.
        let ok = unsafe { AssignProcessToJobObject(job.raw(), process) };
        if ok == 0 {
            return Err(last_error("AssignProcessToJobObject"));
        }
        Ok(())
    }

    fn close(handle: HANDLE) {
        // SAFETY: called once, from Drop, on the handle this JobObject owns.
        unsafe {
            CloseHandle(handle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn parses_status_events() {
        assert_eq!(
            parse_incoming(r#"{"event":"status","data":{"mode":"active"}}"#),
            Incoming::Status(json!({ "mode": "active" }))
        );
    }

    #[test]
    fn parses_success_and_error_responses() {
        assert_eq!(
            parse_incoming(r#"{"id":"r1","ok":true,"result":{"stored":true}}"#),
            Incoming::Response {
                id: "r1".into(),
                result: Ok(json!({ "stored": true }))
            }
        );
        assert_eq!(
            parse_incoming(
                r#"{"id":"r2","ok":false,"error":{"code":"internal","message":"nope"}}"#
            ),
            Incoming::Response {
                id: "r2".into(),
                result: Err("nope".into())
            }
        );
    }

    #[test]
    fn ignores_garbage_and_unknown_messages() {
        for line in [
            "",
            "nope",
            "[]",
            r#"{"event":"other","data":{}}"#,
            r#"{"ok":true}"#,
        ] {
            assert_eq!(parse_incoming(line), Incoming::Ignored, "{line}");
        }
    }

    #[test]
    fn request_lines_are_single_json_lines() {
        let line = request_line("r1", "setMode", &json!({ "mode": "paused" })).unwrap();
        assert!(!line.contains('\n'));
        assert_eq!(
            serde_json::from_str::<Value>(&line).unwrap(),
            json!({ "id": "r1", "method": "setMode", "params": { "mode": "paused" } })
        );
    }

    #[test]
    fn refuses_oversized_requests() {
        let big = "x".repeat(MAX_LINE_BYTES);
        assert!(request_line("r1", "setKey", &json!({ "key": big })).is_err());
    }

    #[test]
    fn resolves_runtime_paths() {
        let paths = DaemonPaths::in_resources(Path::new("app"));
        let node = if cfg!(windows) { "node.exe" } else { "node" };
        assert!(paths.node.ends_with(Path::new("runtime").join(node)));
        assert!(paths.script.ends_with(
            Path::new("runtime")
                .join("daemon")
                .join("worker-daemon.mjs")
        ));
    }

    const ECHO_SCRIPT: &str = r#"
import { createInterface } from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
send({ event: 'status', data: { mode: 'active' } });
process.stderr.write('noise on stderr\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'echo') send({ id, ok: true, result: params });
  else if (method === 'fail') send({ id, ok: false, error: { code: 'internal', message: 'nope' } });
  else if (method === 'exit') process.exit(0);
  // 'hang' (and anything else) is never answered.
});
// Keep running even if stdin closes, so only kill() can end the process.
setInterval(() => {}, 1_000);
"#;

    struct Fixture {
        dir: PathBuf,
        handle: Arc<DaemonHandle>,
        events: tokio::sync::mpsc::UnboundedReceiver<Value>,
        exit: oneshot::Receiver<Option<i32>>,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.handle.kill();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// Needs `node` on PATH (it is on every dev machine for this repo).
    fn start_echo(name: &str) -> Fixture {
        let dir = std::env::temp_dir().join(format!("aic-daemon-rs-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("echo.mjs");
        std::fs::write(&script, ECHO_SCRIPT).unwrap();
        let paths = DaemonPaths {
            node: PathBuf::from("node"),
            script,
        };
        let (event_tx, events) = tokio::sync::mpsc::unbounded_channel();
        let (exit_tx, exit) = oneshot::channel();
        let handle = spawn(
            &paths,
            move |data| {
                let _ = event_tx.send(data);
            },
            move |code| {
                let _ = exit_tx.send(code);
            },
        )
        .expect("node must be on PATH for daemon tests");
        Fixture {
            dir,
            handle,
            events,
            exit,
        }
    }

    #[tokio::test]
    async fn round_trips_requests_through_a_child_process() {
        let mut f = start_echo("roundtrip");
        #[cfg(windows)]
        assert_eq!(f.handle.job_error(), None);

        let status = tokio::time::timeout(Duration::from_secs(10), f.events.recv())
            .await
            .unwrap();
        assert_eq!(status, Some(json!({ "mode": "active" })));
        assert_eq!(
            f.handle.request("echo", json!({ "n": 1 })).await,
            Ok(json!({ "n": 1 }))
        );
        assert_eq!(
            f.handle.request("fail", json!({})).await,
            Err("nope".to_string())
        );

        // The daemon exits without answering; the pending request must fail, not hang.
        assert_eq!(
            f.handle.request("exit", json!({})).await,
            Err(STOPPED.to_string())
        );
        let code = tokio::time::timeout(Duration::from_secs(10), &mut f.exit)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(code, Some(0));
        assert!(f.handle.has_exited());
    }

    #[tokio::test]
    async fn kill_is_prompt_for_a_child_that_never_exits() {
        let mut f = start_echo("kill");
        tokio::time::timeout(Duration::from_secs(10), f.events.recv())
            .await
            .unwrap();
        let handle = f.handle.clone();
        let hung = tokio::spawn(async move { handle.request("hang", json!({})).await });
        // Let the request reach the child before killing it.
        tokio::time::sleep(Duration::from_millis(200)).await;

        let started = Instant::now();
        f.handle.kill();
        assert!(started.elapsed() < Duration::from_secs(1), "kill blocked");
        tokio::time::timeout(Duration::from_secs(5), f.handle.wait_exit())
            .await
            .expect("wait_exit did not complete");
        assert!(started.elapsed() < Duration::from_secs(5));

        let result = tokio::time::timeout(Duration::from_secs(5), hung)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result, Err(STOPPED.to_string()));
        let code = tokio::time::timeout(Duration::from_secs(5), &mut f.exit)
            .await
            .unwrap()
            .unwrap();
        assert_ne!(code, Some(0));
    }

    #[tokio::test]
    async fn requests_fail_promptly_after_the_process_exited() {
        let mut f = start_echo("after-exit");
        tokio::time::timeout(Duration::from_secs(10), f.events.recv())
            .await
            .unwrap();
        f.handle.kill();
        tokio::time::timeout(Duration::from_secs(5), f.handle.wait_exit())
            .await
            .unwrap();

        let result = tokio::time::timeout(
            Duration::from_secs(2),
            f.handle.request("echo", json!({ "n": 2 })),
        )
        .await
        .expect("request hung after exit");
        assert_eq!(result, Err(NOT_RUNNING.to_string()));
    }

    #[cfg(windows)]
    #[test]
    fn closing_the_job_kills_the_child() {
        let mut child = Command::new("node")
            .args(["-e", "setInterval(() => {}, 1000)"])
            .spawn()
            .expect("node must be on PATH for daemon tests");
        let job = job::JobObject::kill_on_close_for(&child).unwrap();
        assert!(child.try_wait().unwrap().is_none());
        drop(job);
        let started = Instant::now();
        // KILL_ON_JOB_CLOSE terminates with exit code 0, so only the exit itself is checked.
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "child outlived its job"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
