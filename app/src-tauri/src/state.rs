use std::{collections::HashMap, sync::{Arc, Mutex}};
use std::path::PathBuf;
use tokio::process::Child;
use tokio::{io::{BufReader, BufWriter}, process::{ChildStdin, ChildStdout}};
use tokio_util::sync::CancellationToken;

pub struct PythonWorker {
    pub child: Child,
    pub pid: u32,
    pub diagnostic_root: PathBuf,
    pub executable: PathBuf,
    pub stdin: BufWriter<ChildStdin>,
    pub stdout: BufReader<ChildStdout>,
    pub backend: String,
    pub _stderr_task: tokio::task::JoinHandle<()>,
}

#[derive(Default)]
pub struct AppState {
    pub cancellations: Arc<Mutex<HashMap<String, CancellationToken>>>,
    pub local_worker: Arc<tokio::sync::Mutex<Option<PythonWorker>>>,
    pub setup_lock: tokio::sync::Mutex<()>,
}
