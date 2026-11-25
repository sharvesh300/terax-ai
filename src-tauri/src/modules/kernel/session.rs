//! One running kernel: its process, the ZeroMQ sockets to it, and the tasks
//! that forward every message to the frontend. A dumb pipe like the LSP host:
//! Rust owns the process, the connection key and message signing; what the
//! messages mean is the frontend's business.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use jupyter_protocol::{ConnectionInfo, JupyterMessage};
use serde::Serialize;
use tauri::ipc::Channel;
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use super::discover::{fill_argv, KernelLaunch};

/// What the frontend receives for a kernel, in order.
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum KernelEvent {
    /// A message from the kernel on `channel` ("iopub", "shell", "control",
    /// "stdin"), as Jupyter's JSON: header, parent_header, metadata, content.
    Message {
        channel: &'static str,
        message: serde_json::Value,
    },
    /// The kernel process ended. `stderr` is its last output, for errors such
    /// as a missing module that kill a kernel at start.
    Exited { code: Option<i32>, stderr: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KernelChannel {
    Shell,
    Control,
    Stdin,
}

pub struct Outbound {
    pub channel: KernelChannel,
    pub message: JupyterMessage,
}

pub struct KernelSession {
    pid: u32,
    interrupt_message: bool,
    outbound: mpsc::UnboundedSender<Outbound>,
    exited: watch::Receiver<bool>,
    killed: AtomicBool,
    tasks: Mutex<Vec<JoinHandle<()>>>,
    #[cfg(windows)]
    job: Mutex<Option<crate::modules::proc::job::ProcessJob>>,
    /// Holds the connection file (and its key); removed with the session.
    _dir: tempfile::TempDir,
}

impl KernelSession {
    pub fn send(&self, outbound: Outbound) -> Result<(), String> {
        self.outbound
            .send(outbound)
            .map_err(|_| "kernel is not running".to_string())
    }

    pub fn interrupts_by_message(&self) -> bool {
        self.interrupt_message
    }

    /// SIGINT to the kernel's process group, as jupyter_client does.
    #[cfg(unix)]
    pub fn signal_interrupt(&self) -> Result<(), String> {
        let rc = unsafe { libc::kill(-(self.pid as libc::pid_t), libc::SIGINT) };
        if rc == 0 {
            Ok(())
        } else {
            Err(format!(
                "interrupt failed: {}",
                std::io::Error::last_os_error()
            ))
        }
    }

    pub fn is_exited(&self) -> bool {
        *self.exited.borrow()
    }

    pub async fn wait_exited(&self, timeout: Duration) -> bool {
        let mut rx = self.exited.clone();
        let waited =
            tokio::time::timeout(
                timeout,
                async move { rx.wait_for(|done| *done).await.is_ok() },
            )
            .await;
        matches!(waited, Ok(true))
    }

    /// Kills the whole process tree (kernels start helpers of their own).
    pub fn kill(&self) {
        if self.killed.swap(true, Ordering::SeqCst) {
            return;
        }
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.pid as libc::pid_t), libc::SIGKILL);
        }
        #[cfg(windows)]
        {
            // Closing the job kills the tree (KILL_ON_JOB_CLOSE).
            self.job.lock().unwrap().take();
        }
        for task in self.tasks.lock().unwrap().drain(..) {
            task.abort();
        }
    }
}

impl Drop for KernelSession {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Keeps the last `limit` bytes of a stream.
struct Tail {
    buf: VecDeque<u8>,
    limit: usize,
}

impl Tail {
    fn new(limit: usize) -> Self {
        Self {
            buf: VecDeque::with_capacity(limit.min(4096)),
            limit,
        }
    }
    fn push(&mut self, bytes: &[u8]) {
        for &b in bytes {
            if self.buf.len() == self.limit {
                self.buf.pop_front();
            }
            self.buf.push_back(b);
        }
    }
    fn text(&self) -> String {
        let (a, b) = self.buf.as_slices();
        let mut v = Vec::with_capacity(a.len() + b.len());
        v.extend_from_slice(a);
        v.extend_from_slice(b);
        String::from_utf8_lossy(&v).into_owned()
    }
}

const STDERR_TAIL: usize = 8 * 1024;

fn forward(on_event: &Channel<KernelEvent>, channel: &'static str, message: &JupyterMessage) {
    match serde_json::to_value(message) {
        Ok(message) => {
            let _ = on_event.send(KernelEvent::Message { channel, message });
        }
        Err(e) => log::warn!("kernel: dropped unserializable {channel} message: {e}"),
    }
}

/// Writes the connection file into a private directory (0700 on Unix) and
/// returns both; the directory, and the key in it, go away with the session.
fn write_connection_file(info: &ConnectionInfo) -> Result<(tempfile::TempDir, PathBuf), String> {
    let dir = tempfile::Builder::new()
        .prefix("terax-kernel-")
        .tempdir()
        .map_err(|e| format!("kernel: temp dir failed: {e}"))?;
    let path = dir.path().join("connection.json");
    let json = serde_json::to_vec(info).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .map_err(|e| format!("kernel: connection file failed: {e}"))?;
        f.write_all(&json).map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    std::fs::write(&path, json).map_err(|e| format!("kernel: connection file failed: {e}"))?;
    Ok((dir, path))
}

fn new_key() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("kernel: no randomness: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

pub async fn start(
    launch: &KernelLaunch,
    cwd: &Path,
    env_overlay: &HashMap<String, String>,
    resolve: impl Fn(&str) -> Option<PathBuf>,
    on_event: Channel<KernelEvent>,
) -> Result<Arc<KernelSession>, String> {
    let ip = std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST);
    // The listeners hold the ports until the kernel exists, closing the race
    // where another process takes them between choosing and binding.
    let (ports, listeners) = jupyter_zmq_client::peek_ports_with_listeners(ip, 5)
        .await
        .map_err(|e| format!("kernel: no free ports: {e}"))?;
    let info = ConnectionInfo {
        transport: jupyter_protocol::connection_info::Transport::TCP,
        ip: ip.to_string(),
        stdin_port: ports[0],
        control_port: ports[1],
        hb_port: ports[2],
        shell_port: ports[3],
        iopub_port: ports[4],
        signature_scheme: "hmac-sha256".into(),
        key: new_key()?,
        kernel_name: None,
    };
    let (dir, connection_file) = write_connection_file(&info)?;

    let argv = fill_argv(
        &launch.argv,
        &connection_file,
        launch.resource_dir.as_deref(),
    );
    let program = {
        let first = &argv[0];
        let p = Path::new(first);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            resolve(first).ok_or_else(|| format!("kernel: `{first}` was not found on PATH"))?
        }
    };

    let mut cmd = tokio::process::Command::new(&program);
    cmd.args(&argv[1..])
        .current_dir(cwd)
        .envs(env_overlay)
        .envs(&launch.env)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("kernel: failed to start {}: {e}", program.display()))?;
    drop(listeners);
    let pid = child.id().ok_or("kernel: exited during start")?;

    #[cfg(windows)]
    let job = match crate::modules::proc::job::ProcessJob::create_for(pid) {
        Ok(j) => Some(j),
        Err(e) => {
            log::warn!("kernel job-object setup failed for pid={pid}: {e}");
            None
        }
    };

    let session_id = uuid_like()?;
    let connect = async {
        let iopub =
            jupyter_zmq_client::create_client_iopub_connection(&info, "", &session_id).await?;
        let identity = jupyter_zmq_client::peer_identity_for_session(&session_id)?;
        let shell = jupyter_zmq_client::create_client_shell_connection_with_identity(
            &info,
            &session_id,
            identity.clone(),
        )
        .await?;
        let stdin = jupyter_zmq_client::create_client_stdin_connection_with_identity(
            &info,
            &session_id,
            identity,
        )
        .await?;
        let control =
            jupyter_zmq_client::create_client_control_connection(&info, &session_id).await?;
        Ok::<_, jupyter_zmq_client::RuntimeError>((iopub, shell, stdin, control))
    };
    let (mut iopub, shell, stdin, control) = match connect.await {
        Ok(c) => c,
        Err(e) => {
            let _ = child.start_kill();
            return Err(format!("kernel: could not connect: {e}"));
        }
    };

    let (exited_tx, exited_rx) = watch::channel(false);
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Outbound>();
    let mut tasks = Vec::new();

    let (mut shell_tx, mut shell_rx) = shell.split();
    let (mut stdin_tx, mut stdin_rx) = stdin.split();
    let (mut control_tx, mut control_rx) = control.split();

    // One writer owns every send half, so messages go out in order.
    tasks.push(tokio::spawn(async move {
        while let Some(Outbound { channel, message }) = out_rx.recv().await {
            let result = match channel {
                KernelChannel::Shell => shell_tx.send(message).await,
                KernelChannel::Control => control_tx.send(message).await,
                KernelChannel::Stdin => stdin_tx.send(message).await,
            };
            if let Err(e) = result {
                log::warn!("kernel: send failed: {e}");
            }
        }
    }));

    let ev = on_event.clone();
    tasks.push(tokio::spawn(async move {
        while let Ok(m) = iopub.read().await {
            forward(&ev, "iopub", &m);
        }
    }));
    let ev = on_event.clone();
    tasks.push(tokio::spawn(async move {
        while let Ok(m) = shell_rx.read().await {
            forward(&ev, "shell", &m);
        }
    }));
    let ev = on_event.clone();
    tasks.push(tokio::spawn(async move {
        while let Ok(m) = stdin_rx.read().await {
            forward(&ev, "stdin", &m);
        }
    }));
    let ev = on_event.clone();
    tasks.push(tokio::spawn(async move {
        while let Ok(m) = control_rx.read().await {
            forward(&ev, "control", &m);
        }
    }));

    // Owns the process: collects the stderr tail and reports the exit.
    let mut stderr = child.stderr.take();
    let ev = on_event;
    tasks.push(tokio::spawn(async move {
        let mut tail = Tail::new(STDERR_TAIL);
        let read_stderr = async {
            if let Some(stderr) = stderr.as_mut() {
                let mut buf = [0u8; 4096];
                while let Ok(n) = stderr.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    tail.push(&buf[..n]);
                }
            }
        };
        let (status, ()) = tokio::join!(child.wait(), read_stderr);
        let _ = exited_tx.send(true);
        let _ = ev.send(KernelEvent::Exited {
            code: status.ok().and_then(|s| s.code()),
            stderr: tail.text(),
        });
    }));

    Ok(Arc::new(KernelSession {
        pid,
        interrupt_message: launch.interrupt_message,
        outbound: out_tx,
        exited: exited_rx,
        killed: AtomicBool::new(false),
        tasks: Mutex::new(tasks),
        #[cfg(windows)]
        job: Mutex::new(job),
        _dir: dir,
    }))
}

fn uuid_like() -> Result<String, String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|e| format!("kernel: no randomness: {e}"))?;
    Ok(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_keeps_the_last_bytes() {
        let mut t = Tail::new(5);
        t.push(b"hello ");
        t.push(b"world");
        assert_eq!(t.text(), "world");
        let mut short = Tail::new(64);
        short.push(b"ModuleNotFoundError");
        assert_eq!(short.text(), "ModuleNotFoundError");
    }

    #[test]
    fn connection_file_is_private() {
        let info = ConnectionInfo {
            transport: jupyter_protocol::connection_info::Transport::TCP,
            ip: "127.0.0.1".into(),
            stdin_port: 1,
            control_port: 2,
            hb_port: 3,
            shell_port: 4,
            iopub_port: 5,
            signature_scheme: "hmac-sha256".into(),
            key: new_key().unwrap(),
            kernel_name: None,
        };
        let (dir, path) = write_connection_file(&info).unwrap();
        let read: ConnectionInfo = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(read.key, info.key);
        assert_eq!(read.key.len(), 64);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let kept = dir.path().to_path_buf();
        drop(dir);
        assert!(!kept.exists(), "the key leaves with the session");
    }

    #[test]
    fn keys_are_random() {
        assert_ne!(new_key().unwrap(), new_key().unwrap());
        assert_eq!(uuid_like().unwrap().len(), 36);
    }
}
