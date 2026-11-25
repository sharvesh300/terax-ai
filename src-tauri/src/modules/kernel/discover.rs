//! Finding kernels: installed Jupyter kernelspecs, plus Python environments
//! (workspace venvs, conda, pyenv, the PATH python) that can run ipykernel
//! without being registered, as VS Code offers them. The path and naming
//! rules are pure and tested; probing an interpreter is the only IO here.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

/// Everything needed to launch a kernel. Never sent to the frontend: the
/// frontend starts kernels by `id`, so it can never name a program to run.
#[derive(Clone, Debug)]
pub struct KernelLaunch {
    pub argv: Vec<String>,
    pub env: HashMap<String, String>,
    /// The kernelspec directory, for `{resource_dir}`.
    pub resource_dir: Option<PathBuf>,
    pub interrupt_message: bool,
}

/// What the kernel picker shows.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KernelSpecInfo {
    pub id: String,
    /// The kernelspec name written to notebook metadata.
    pub name: String,
    pub display_name: String,
    pub language: String,
    /// "kernelspec" (installed) or "environment" (a Python found on disk).
    pub source: &'static str,
    /// The kernelspec directory or the interpreter.
    pub path: String,
    /// Environments only: false means `ipykernel` must be installed first.
    pub ready: bool,
    /// Environments only: the interpreter, for "Install ipykernel".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub python: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Discovered {
    pub info: KernelSpecInfo,
    pub launch: Option<KernelLaunch>,
}

// ---------------------------------------------------------------------------
// Installed kernelspecs

pub fn from_kernelspec(dir: &jupyter_zmq_client::KernelspecDir) -> Discovered {
    let spec = &dir.kernelspec;
    let interrupt_message = spec.interrupt_mode.as_deref() == Some("message");
    Discovered {
        info: KernelSpecInfo {
            id: format!("kernelspec:{}", dir.path.display()),
            name: dir.kernel_name.clone(),
            display_name: spec.display_name.clone(),
            language: spec.language.clone(),
            source: "kernelspec",
            path: dir.path.display().to_string(),
            ready: !spec.argv.is_empty(),
            python: None,
        },
        launch: (!spec.argv.is_empty()).then(|| KernelLaunch {
            argv: spec.argv.clone(),
            env: spec.env.clone().unwrap_or_default(),
            resource_dir: Some(dir.path.clone()),
            interrupt_message,
        }),
    }
}

// ---------------------------------------------------------------------------
// Python environments

#[cfg(windows)]
const VENV_PYTHON: &[&str] = &["Scripts", "python.exe"];
#[cfg(not(windows))]
const VENV_PYTHON: &[&str] = &["bin", "python"];

fn env_python(prefix: &Path) -> PathBuf {
    VENV_PYTHON
        .iter()
        .fold(prefix.to_path_buf(), |p, s| p.join(s))
}

/// Interpreters to probe, most specific first: the workspace's own venvs,
/// then conda, pyenv and the PATH python. Duplicates are removed later.
pub fn candidate_pythons(
    workspace_root: Option<&Path>,
    home: Option<&Path>,
    conda_environments: &str,
    path_pythons: &[PathBuf],
) -> Vec<(PathBuf, String)> {
    let mut out: Vec<(PathBuf, String)> = Vec::new();
    if let Some(root) = workspace_root {
        for dir in [".venv", "venv", "env", ".env"] {
            out.push((env_python(&root.join(dir)), dir.to_string()));
        }
    }
    for line in conda_environments.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let prefix = PathBuf::from(line);
        let label = prefix
            .file_name()
            .map(|n| format!("conda: {}", n.to_string_lossy()))
            .unwrap_or_else(|| "conda".into());
        #[cfg(windows)]
        out.push((prefix.join("python.exe"), label));
        #[cfg(not(windows))]
        out.push((prefix.join("bin").join("python"), label));
    }
    if let Some(home) = home {
        let versions = home.join(".pyenv").join("versions");
        if let Ok(entries) = std::fs::read_dir(&versions) {
            let mut names: Vec<String> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            for name in names {
                out.push((env_python(&versions.join(&name)), format!("pyenv: {name}")));
            }
        }
    }
    for p in path_pythons {
        out.push((p.clone(), "PATH".into()));
    }
    out
}

/// The interpreter's version and whether it can import ipykernel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Probe {
    pub version: String,
    pub has_ipykernel: bool,
}

// Prints the version first, so a missing ipykernel still tells us the
// interpreter works.
const PROBE_SCRIPT: &str =
    "import sys; print(sys.version.split()[0], flush=True); import ipykernel; print('ipykernel')";

pub fn parse_probe(stdout: &str) -> Option<Probe> {
    let mut lines = stdout.lines().map(str::trim).filter(|l| !l.is_empty());
    let version = lines.next()?;
    if !version.chars().next()?.is_ascii_digit() {
        return None;
    }
    Some(Probe {
        version: version.to_string(),
        has_ipykernel: lines.any(|l| l == "ipykernel"),
    })
}

const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

/// Runs the interpreter once with a timeout. Blocking; call off the runtime.
pub fn probe_python(python: &Path, env: &HashMap<String, String>) -> Option<Probe> {
    let mut cmd = Command::new(python);
    cmd.args(["-c", PROBE_SCRIPT])
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::modules::proc::hide_console(&mut cmd);
    let mut child = cmd.spawn().ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < PROBE_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(25));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut stdout = String::new();
    use std::io::Read;
    child.stdout.take()?.read_to_string(&mut stdout).ok()?;
    parse_probe(&stdout)
}

pub fn environment_kernel(python: &Path, label: &str, probe: &Probe) -> Discovered {
    let major = probe.version.split('.').next().unwrap_or("3");
    Discovered {
        info: KernelSpecInfo {
            id: format!("environment:{}", python.display()),
            // What Jupyter itself names a Python 3 kernel, so notebooks saved
            // here open with "python3" elsewhere.
            name: format!("python{major}"),
            display_name: format!("Python {} ({label})", probe.version),
            language: "python".into(),
            source: "environment",
            path: python.display().to_string(),
            ready: probe.has_ipykernel,
            python: Some(python.display().to_string()),
        },
        launch: probe.has_ipykernel.then(|| KernelLaunch {
            argv: vec![
                python.display().to_string(),
                "-m".into(),
                "ipykernel_launcher".into(),
                "-f".into(),
                "{connection_file}".into(),
            ],
            env: HashMap::new(),
            resource_dir: None,
            interrupt_message: false,
        }),
    }
}

/// Drops environments a kernelspec already launches (same interpreter), so
/// an installed kernel is never listed twice.
pub fn dedupe(kernels: Vec<Discovered>) -> Vec<Discovered> {
    let spec_pythons: HashSet<String> = kernels
        .iter()
        .filter(|k| k.info.source == "kernelspec")
        .filter_map(|k| k.launch.as_ref()?.argv.first().cloned())
        .map(|p| canonical_string(Path::new(&p)))
        .collect();
    let mut seen = HashSet::new();
    kernels
        .into_iter()
        .filter(|k| {
            if k.info.source == "environment" {
                let canon = canonical_string(Path::new(&k.info.path));
                if spec_pythons.contains(&canon) {
                    return false;
                }
                return seen.insert(canon);
            }
            seen.insert(k.info.id.clone())
        })
        .collect()
}

fn canonical_string(path: &Path) -> String {
    std::fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .display()
        .to_string()
}

/// Fills the kernelspec argv placeholders, as jupyter_client does.
pub fn fill_argv(
    argv: &[String],
    connection_file: &Path,
    resource_dir: Option<&Path>,
) -> Vec<String> {
    argv.iter()
        .map(|a| {
            let mut s = a.replace("{connection_file}", &connection_file.display().to_string());
            if let Some(dir) = resource_dir {
                s = s.replace("{resource_dir}", &dir.display().to_string());
            }
            s
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_probe_output() {
        assert_eq!(
            parse_probe("3.12.4\nipykernel\n"),
            Some(Probe {
                version: "3.12.4".into(),
                has_ipykernel: true
            })
        );
        assert_eq!(
            parse_probe("3.11.2\n"),
            Some(Probe {
                version: "3.11.2".into(),
                has_ipykernel: false
            })
        );
        assert_eq!(parse_probe(""), None);
        assert_eq!(parse_probe("Traceback (most recent call last):"), None);
    }

    #[test]
    fn lists_workspace_venvs_first_then_conda_pyenv_and_path() {
        let root = Path::new("/w");
        let home = Path::new("/nonexistent-home-for-test");
        let conda = "# comment\n/opt/conda\n\n/opt/conda/envs/ml\n";
        let path = vec![PathBuf::from("/usr/bin/python3")];
        let got = candidate_pythons(Some(root), Some(home), conda, &path);
        let labels: Vec<&str> = got.iter().map(|(_, l)| l.as_str()).collect();
        assert_eq!(
            labels,
            [
                ".venv",
                "venv",
                "env",
                ".env",
                "conda: conda",
                "conda: ml",
                "PATH"
            ]
        );
        assert_eq!(got[0].0, env_python(Path::new("/w/.venv")));
        assert_eq!(got.last().unwrap().0, PathBuf::from("/usr/bin/python3"));
    }

    #[test]
    fn names_environment_kernels_like_jupyter() {
        let probe = Probe {
            version: "3.12.4".into(),
            has_ipykernel: true,
        };
        let k = environment_kernel(Path::new("/w/.venv/bin/python"), ".venv", &probe);
        assert_eq!(k.info.name, "python3");
        assert_eq!(k.info.display_name, "Python 3.12.4 (.venv)");
        assert!(k.info.ready);
        let launch = k.launch.unwrap();
        assert_eq!(
            launch.argv,
            [
                "/w/.venv/bin/python",
                "-m",
                "ipykernel_launcher",
                "-f",
                "{connection_file}"
            ]
        );
        let missing = environment_kernel(
            Path::new("/p"),
            "PATH",
            &Probe {
                version: "3.9.6".into(),
                has_ipykernel: false,
            },
        );
        assert!(!missing.info.ready);
        assert!(missing.launch.is_none());
        assert_eq!(missing.info.python.as_deref(), Some("/p"));
    }

    #[test]
    fn drops_environments_an_installed_kernel_already_uses() {
        let probe = Probe {
            version: "3.12.0".into(),
            has_ipykernel: true,
        };
        let spec = Discovered {
            info: KernelSpecInfo {
                id: "kernelspec:/k".into(),
                name: "py".into(),
                display_name: "Py".into(),
                language: "python".into(),
                source: "kernelspec",
                path: "/k".into(),
                ready: true,
                python: None,
            },
            launch: Some(KernelLaunch {
                argv: vec!["/a/python".into(), "-m".into(), "ipykernel_launcher".into()],
                env: HashMap::new(),
                resource_dir: None,
                interrupt_message: false,
            }),
        };
        let a = environment_kernel(Path::new("/a/python"), "x", &probe);
        let b = environment_kernel(Path::new("/b/python"), "y", &probe);
        let b2 = environment_kernel(Path::new("/b/python"), "z", &probe);
        let ids: Vec<String> = dedupe(vec![spec, a, b, b2])
            .into_iter()
            .map(|k| k.info.id)
            .collect();
        assert_eq!(ids, ["kernelspec:/k", "environment:/b/python"]);
    }

    #[test]
    fn fills_argv_placeholders() {
        let argv = vec![
            "python".into(),
            "-f".into(),
            "{connection_file}".into(),
            "--logo={resource_dir}/logo.png".into(),
        ];
        assert_eq!(
            fill_argv(&argv, Path::new("/t/c.json"), Some(Path::new("/k"))),
            ["python", "-f", "/t/c.json", "--logo=/k/logo.png"]
        );
    }
}
