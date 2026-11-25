//! Jupyter kernels for notebooks. The frontend lists kernels, starts one by
//! the id discovery gave it (never a command line), sends allowlisted
//! messages, and receives every kernel message over a Channel. Kernels run in
//! their own process group (a job object on Windows), their connection key
//! stays in Rust, and all of them are killed on app exit.

mod discover;
mod session;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use jupyter_protocol::{JupyterMessage, JupyterMessageContent};
use tauri::ipc::Channel;

use crate::modules::lsp::env::{resolve_binary, server_env_overlay};
use crate::modules::workspace::{authorize_user_spawn_cwd, WorkspaceEnv, WorkspaceRegistry};
use discover::{Discovered, KernelLaunch, KernelSpecInfo};
use session::{KernelChannel, KernelEvent, KernelSession, Outbound};

#[derive(Default)]
pub struct KernelState {
    sessions: RwLock<HashMap<u32, Arc<KernelSession>>>,
    next_id: AtomicU32,
    /// Launch details for the ids the frontend was last given.
    launches: RwLock<HashMap<String, KernelLaunch>>,
    /// Last listing per workspace root; probing interpreters takes seconds.
    listings: RwLock<HashMap<Option<PathBuf>, Vec<KernelSpecInfo>>>,
}

impl KernelState {
    pub fn kill_all(&self) {
        let drained: Vec<Arc<KernelSession>> = self
            .sessions
            .write()
            .unwrap()
            .drain()
            .map(|(_, s)| s)
            .collect();
        for session in drained {
            session.kill();
        }
    }

    fn get(&self, id: u32) -> Result<Arc<KernelSession>, String> {
        self.sessions
            .read()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("kernel {id} is not running"))
    }
}

/// Message types the frontend may send, per channel. Anything else is
/// refused, so this surface stays what a notebook needs.
const ALLOWED: &[(KernelChannel, &[&str])] = &[
    (
        KernelChannel::Shell,
        &[
            "execute_request",
            "kernel_info_request",
            "complete_request",
            "inspect_request",
            "is_complete_request",
        ],
    ),
    (
        KernelChannel::Control,
        &[
            "interrupt_request",
            "shutdown_request",
            "kernel_info_request",
        ],
    ),
    (KernelChannel::Stdin, &["input_reply"]),
];

fn parse_channel(channel: &str) -> Option<KernelChannel> {
    match channel {
        "shell" => Some(KernelChannel::Shell),
        "control" => Some(KernelChannel::Control),
        "stdin" => Some(KernelChannel::Stdin),
        _ => None,
    }
}

fn allowed(channel: KernelChannel, msg_type: &str) -> bool {
    ALLOWED
        .iter()
        .any(|(c, types)| *c == channel && types.contains(&msg_type))
}

fn valid_msg_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn conda_environments(home: Option<&Path>) -> String {
    home.map(|h| h.join(".conda").join("environments.txt"))
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default()
}

fn path_pythons() -> Vec<PathBuf> {
    let path = server_env_overlay()
        .get("PATH")
        .cloned()
        .or_else(|| std::env::var("PATH").ok());
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    ["python3", "python"]
        .iter()
        .filter_map(|name| which::which_in(name, path.clone(), &cwd).ok())
        .collect()
}

/// The environment prefix of an interpreter (`<prefix>/bin/python`).
fn env_prefix(python: &Path) -> Option<PathBuf> {
    let parent = python.parent()?;
    #[cfg(windows)]
    {
        if parent
            .file_name()
            .is_some_and(|n| n.eq_ignore_ascii_case("Scripts"))
        {
            return parent.parent().map(Path::to_path_buf);
        }
        return Some(parent.to_path_buf());
    }
    #[cfg(not(windows))]
    parent.parent().map(Path::to_path_buf)
}

async fn discover_all(workspace_root: Option<PathBuf>) -> Vec<Discovered> {
    let mut specs = jupyter_zmq_client::list_kernelspecs().await;

    let probed = tauri::async_runtime::spawn_blocking(move || {
        let env = server_env_overlay().clone();
        let home = dirs::home_dir();
        let candidates = discover::candidate_pythons(
            workspace_root.as_deref(),
            home.as_deref(),
            &conda_environments(home.as_deref()),
            &path_pythons(),
        );
        let existing: Vec<(PathBuf, String)> = candidates
            .into_iter()
            .filter(|(p, _)| p.is_file())
            .collect();
        // Interpreters are probed in parallel: each can take a second.
        std::thread::scope(|scope| {
            let handles: Vec<_> = existing
                .iter()
                .map(|(python, label)| {
                    let env = &env;
                    scope.spawn(move || {
                        discover::probe_python(python, env)
                            .map(|p| (python.clone(), label.clone(), p))
                    })
                })
                .collect();
            handles
                .into_iter()
                .filter_map(|h| h.join().ok().flatten())
                .collect::<Vec<_>>()
        })
    })
    .await
    .unwrap_or_default();

    // Kernels installed inside an environment live in its share/jupyter.
    for (python, _, _) in &probed {
        if let Some(prefix) = env_prefix(python) {
            let data = prefix.join("share").join("jupyter");
            for spec in jupyter_zmq_client::read_kernelspec_jsons(&data).await {
                if !specs.iter().any(|s| s.path == spec.path) {
                    specs.push(spec);
                }
            }
        }
    }

    let mut all: Vec<Discovered> = specs.iter().map(discover::from_kernelspec).collect();
    all.extend(
        probed
            .iter()
            .map(|(python, label, probe)| discover::environment_kernel(python, label, probe)),
    );
    discover::dedupe(all)
}

#[tauri::command]
pub async fn kernel_list_specs(
    state: tauri::State<'_, KernelState>,
    workspace_root: Option<String>,
    refresh: Option<bool>,
) -> Result<Vec<KernelSpecInfo>, String> {
    let root = workspace_root
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() && p.is_dir());
    if refresh != Some(true) {
        if let Some(cached) = state.listings.read().unwrap().get(&root) {
            return Ok(cached.clone());
        }
    }
    let discovered = discover_all(root.clone()).await;
    let infos: Vec<KernelSpecInfo> = discovered.iter().map(|d| d.info.clone()).collect();
    {
        let mut launches = state.launches.write().unwrap();
        for d in discovered {
            if let Some(launch) = d.launch {
                launches.insert(d.info.id, launch);
            }
        }
    }
    state.listings.write().unwrap().insert(root, infos.clone());
    Ok(infos)
}

#[tauri::command]
pub async fn kernel_start(
    state: tauri::State<'_, KernelState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    spec_id: String,
    cwd: String,
    workspace: Option<WorkspaceEnv>,
    on_event: Channel<KernelEvent>,
) -> Result<u32, String> {
    let workspace = workspace.unwrap_or_default();
    if !matches!(workspace, WorkspaceEnv::Local) {
        return Err("Kernels are not available in WSL workspaces yet.".into());
    }
    let launch = state
        .launches
        .read()
        .unwrap()
        .get(&spec_id)
        .cloned()
        .ok_or("Unknown kernel; list kernels again and pick one.")?;
    // Running a notebook is the user's choice to run code in its folder, the
    // same as opening a terminal there.
    let cwd = authorize_user_spawn_cwd(&registry, Some(&cwd), &workspace)?
        .ok_or("kernel: no working directory")?;
    let env = tauri::async_runtime::spawn_blocking(|| server_env_overlay().clone())
        .await
        .map_err(|e| e.to_string())?;
    let session = session::start(&launch, &cwd, &env, resolve_binary, on_event).await?;
    let id = state.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    state.sessions.write().unwrap().insert(id, session);
    Ok(id)
}

/// Sends a message and returns its `msg_id`, which the kernel's replies and
/// outputs carry as their parent.
#[tauri::command]
pub fn kernel_send(
    state: tauri::State<'_, KernelState>,
    id: u32,
    channel: String,
    msg_type: String,
    content: serde_json::Value,
    parent_header: Option<serde_json::Value>,
    msg_id: Option<String>,
) -> Result<String, String> {
    let channel = parse_channel(&channel).ok_or("kernel: unknown channel")?;
    if !allowed(channel, &msg_type) {
        return Err(format!("kernel: {msg_type} is not allowed here"));
    }
    let content = JupyterMessageContent::from_type_and_content(&msg_type, content)
        .map_err(|e| format!("kernel: bad {msg_type}: {e}"))?;
    let mut message = JupyterMessage::new(content, None);
    // The frontend may pick the id, so it can map the reply to a cell before
    // the kernel (which may answer first) is even sent the request.
    if let Some(id) = msg_id {
        if !valid_msg_id(&id) {
            return Err("kernel: bad msg_id".into());
        }
        message.header.msg_id = id;
    }
    if let Some(parent) = parent_header {
        message.parent_header =
            Some(serde_json::from_value(parent).map_err(|e| format!("kernel: bad parent: {e}"))?);
    }
    let msg_id = message.header.msg_id.clone();
    state.get(id)?.send(Outbound { channel, message })?;
    Ok(msg_id)
}

#[tauri::command]
pub fn kernel_interrupt(state: tauri::State<'_, KernelState>, id: u32) -> Result<(), String> {
    let session = state.get(id)?;
    #[cfg(unix)]
    if !session.interrupts_by_message() {
        return session.signal_interrupt();
    }
    let content =
        JupyterMessageContent::from_type_and_content("interrupt_request", serde_json::json!({}))
            .map_err(|e| e.to_string())?;
    session.send(Outbound {
        channel: KernelChannel::Control,
        message: JupyterMessage::new(content, None),
    })
}

/// Asks the kernel to shut down, then kills its process tree if it has not
/// exited within a moment.
#[tauri::command]
pub async fn kernel_shutdown(state: tauri::State<'_, KernelState>, id: u32) -> Result<(), String> {
    let Some(session) = state.sessions.write().unwrap().remove(&id) else {
        return Ok(());
    };
    if !session.is_exited() {
        if let Ok(content) = JupyterMessageContent::from_type_and_content(
            "shutdown_request",
            serde_json::json!({ "restart": false }),
        ) {
            let _ = session.send(Outbound {
                channel: KernelChannel::Control,
                message: JupyterMessage::new(content, None),
            });
        }
        session.wait_exited(Duration::from_secs(3)).await;
    }
    session.kill();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_only_what_a_notebook_sends() {
        assert!(allowed(KernelChannel::Shell, "execute_request"));
        assert!(allowed(KernelChannel::Control, "interrupt_request"));
        assert!(allowed(KernelChannel::Stdin, "input_reply"));
        assert!(!allowed(KernelChannel::Shell, "shutdown_request"));
        assert!(!allowed(KernelChannel::Shell, "comm_msg"));
        assert!(!allowed(KernelChannel::Stdin, "execute_request"));
        assert_eq!(parse_channel("iopub"), None);
        assert_eq!(parse_channel("hb"), None);
    }

    #[test]
    fn accepts_only_plain_message_ids() {
        assert!(valid_msg_id("0b5f2c8e-1d2a-4c3b-9e8f-7a6b5c4d3e2f"));
        assert!(!valid_msg_id(""));
        assert!(!valid_msg_id("a b"));
        assert!(!valid_msg_id(&"x".repeat(129)));
    }

    #[test]
    fn execute_requests_round_trip_through_the_protocol_types() {
        let content = serde_json::json!({
            "code": "print(1)",
            "silent": false,
            "store_history": true,
            "user_expressions": {},
            "allow_stdin": true,
            "stop_on_error": true
        });
        let parsed =
            JupyterMessageContent::from_type_and_content("execute_request", content).unwrap();
        assert_eq!(parsed.message_type(), "execute_request");
        let message = JupyterMessage::new(parsed, None);
        let json = serde_json::to_value(&message).unwrap();
        assert_eq!(json["header"]["msg_type"], "execute_request");
        assert_eq!(json["content"]["code"], "print(1)");
    }

    #[cfg(unix)]
    #[test]
    fn finds_the_prefix_of_an_interpreter() {
        assert_eq!(
            env_prefix(Path::new("/w/.venv/bin/python")),
            Some(PathBuf::from("/w/.venv"))
        );
    }
}

/// Runs against a real ipykernel. Needs `python3` with ipykernel installed:
/// `cargo test --lib kernel::live -- --ignored`.
#[cfg(test)]
mod live {
    use super::*;
    use std::sync::Mutex as StdMutex;
    use tauri::ipc::InvokeResponseBody;

    type Events = Arc<StdMutex<Vec<serde_json::Value>>>;

    fn channel() -> (Channel<KernelEvent>, Events) {
        let events: Events = Arc::default();
        let sink = events.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                sink.lock()
                    .unwrap()
                    .push(serde_json::from_str(&json).unwrap());
            }
            Ok(())
        });
        (channel, events)
    }

    async fn wait_for(events: &Events, what: &str, f: impl Fn(&serde_json::Value) -> bool) {
        for _ in 0..300 {
            if events.lock().unwrap().iter().any(&f) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!(
            "timed out waiting for {what}: {:#?}",
            events.lock().unwrap()
        );
    }

    fn send(
        s: &KernelSession,
        channel: KernelChannel,
        msg_type: &str,
        content: serde_json::Value,
    ) -> String {
        let content = JupyterMessageContent::from_type_and_content(msg_type, content).unwrap();
        let message = JupyterMessage::new(content, None);
        let id = message.header.msg_id.clone();
        s.send(Outbound { channel, message }).unwrap();
        id
    }

    fn execute(code: &str) -> serde_json::Value {
        serde_json::json!({
            "code": code, "silent": false, "store_history": true,
            "user_expressions": {}, "allow_stdin": false, "stop_on_error": true
        })
    }

    #[tokio::test]
    #[ignore = "needs python3 with ipykernel"]
    async fn runs_code_interrupts_and_shuts_down() {
        let python = which::which("python3").expect("python3");
        let probe = discover::probe_python(&python, &HashMap::new()).expect("probe");
        assert!(probe.has_ipykernel, "python3 has no ipykernel");
        let kernel = discover::environment_kernel(&python, "PATH", &probe);
        let (ch, events) = channel();
        let dir = std::env::temp_dir();
        let session = session::start(
            kernel.launch.as_ref().unwrap(),
            &dir,
            &HashMap::new(),
            |c| which::which(c).ok(),
            ch,
        )
        .await
        .expect("start");

        send(
            &session,
            KernelChannel::Shell,
            "kernel_info_request",
            serde_json::json!({}),
        );
        wait_for(&events, "kernel_info_reply", |e| {
            e["kind"] == "message" && e["message"]["header"]["msg_type"] == "kernel_info_reply"
        })
        .await;

        let run = send(
            &session,
            KernelChannel::Shell,
            "execute_request",
            execute("print(1 + 1)"),
        );
        wait_for(&events, "stream output", |e| {
            e["message"]["parent_header"]["msg_id"] == run.as_str()
                && e["message"]["header"]["msg_type"] == "stream"
                && e["message"]["content"]["text"] == "2\n"
        })
        .await;

        let slow = send(
            &session,
            KernelChannel::Shell,
            "execute_request",
            execute("import time; time.sleep(60)"),
        );
        wait_for(&events, "busy", |e| {
            e["message"]["parent_header"]["msg_id"] == slow.as_str()
                && e["message"]["header"]["msg_type"] == "execute_input"
        })
        .await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        #[cfg(unix)]
        session.signal_interrupt().unwrap();
        wait_for(&events, "KeyboardInterrupt", |e| {
            e["message"]["parent_header"]["msg_id"] == slow.as_str()
                && e["message"]["header"]["msg_type"] == "error"
                && e["message"]["content"]["ename"] == "KeyboardInterrupt"
        })
        .await;

        send(
            &session,
            KernelChannel::Control,
            "shutdown_request",
            serde_json::json!({ "restart": false }),
        );
        assert!(
            session.wait_exited(Duration::from_secs(10)).await,
            "kernel did not exit"
        );
        wait_for(&events, "exit event", |e| e["kind"] == "exited").await;
    }
}
