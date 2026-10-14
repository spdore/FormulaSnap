use crate::state::{AppState, PythonWorker};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
#[cfg(windows)]
use std::collections::HashSet;
use tauri::{path::BaseDirectory, AppHandle, Emitter, Manager, State};
use tokio::{fs as async_fs, io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, BufWriter}};
use tokio_util::sync::CancellationToken;

const MODEL_VERSION: &str = "v0.0.0";
const MODEL_FILES: [(&str, u64, &str); 4] = [
    ("image_resizer.onnx", 38_967_751, "E0B075C39700F64D50400F39C8FC186BBB3B5D84D31864008313F376603ACA9D"),
    ("encoder.onnx", 89_008_136, "01BF5DC25539CA0CD5B1BD29296EA495977A6BA5F629DC4178277809D26E5E7D"),
    ("decoder.onnx", 50_952_726, "BD695497BF1B22279B7626F5916C79226E1E244C84355F8DA7EDFD2D921D0072"),
    ("tokenizer.json", 24_174, "1DC27B18D6A518D0D5FF3F4BB7BD98521FE80AD39E5B2A246D4109F1BB9D5019"),
];
const MODEL_RELEASE: &str = "https://github.com/RapidAI/RapidLaTeXOCR/releases/download/v0.0.0";
const MINIFORGE_TAG: &str = "26.7.2-0";
const MINIFORGE_CONDA_VERSION: &str = "26.7.2";
const MINIFORGE_ASSET: &str = "Miniforge3-26.7.2-0-Windows-x86_64.exe";
const MINIFORGE_SIZE: u64 = 148_256_480;
const MINIFORGE_SHA256: &str = "71CF9519087BE74FA53021219FF292BEB2FC05FA49E0BB6EB0E0B6B14FCCBAAB";
const MAX_COMMAND_OUTPUT: usize = 64 * 1024;
const MAX_DIAGNOSTIC_LOG: u64 = 256 * 1024;
const RUNNER: &str = include_str!("../resources/local_runner.py");

struct SetupProgressTracker {
    task_id: String,
    started: Instant,
    last_activity: u64,
    last_sample_at: Instant,
    last_sample_bytes: u64,
    smoothed_bytes_per_second: Option<f64>,
}

static SETUP_PROGRESS: OnceLock<Mutex<SetupProgressTracker>> = OnceLock::new();
static SETUP_TASK_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn progress_tracker() -> &'static Mutex<SetupProgressTracker> {
    SETUP_PROGRESS.get_or_init(|| Mutex::new(SetupProgressTracker {
        task_id: String::new(),
        started: Instant::now(),
        last_activity: 0,
        last_sample_at: Instant::now(),
        last_sample_bytes: 0,
        smoothed_bytes_per_second: None,
    }))
}

fn epoch_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn begin_setup_task(requested_id: Option<&str>) -> String {
    let generated = format!("local-setup-{}", SETUP_TASK_SEQUENCE.fetch_add(1, Ordering::Relaxed));
    let task_id = requested_id.map(str::trim).filter(|value| !value.is_empty() && value.len() <= 128)
        .unwrap_or(&generated).to_owned();
    if let Ok(mut tracker) = progress_tracker().lock() {
        tracker.task_id = task_id.clone();
        tracker.started = Instant::now();
        tracker.last_activity = epoch_millis();
        tracker.last_sample_at = Instant::now();
        tracker.last_sample_bytes = 0;
        tracker.smoothed_bytes_per_second = None;
    }
    task_id
}

fn ensure_progress_task() {
    let missing = progress_tracker().lock().map(|tracker| tracker.task_id.is_empty()).unwrap_or(false);
    if missing { begin_setup_task(None); }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LocalSettings {
    pub source_policy: String,
    pub custom_pypi_index: String,
    pub custom_conda_channel: String,
    pub custom_miniforge_url: String,
    pub custom_model_base_url: String,
    pub storage_directory: String,
    #[serde(default)]
    pub detected_region: String,
}

impl Default for LocalSettings {
    fn default() -> Self {
        Self {
            source_policy: "auto".into(),
            custom_pypi_index: String::new(),
            custom_conda_channel: String::new(),
            custom_miniforge_url: String::new(),
            custom_model_base_url: String::new(),
            storage_directory: String::new(),
            detected_region: "unknown".into(),
        }
    }
}

fn settings_path(profile_root: &Path) -> PathBuf {
    profile_root.join("local-settings.json")
}

fn read_local_settings(profile_root: &Path) -> LocalSettings {
    fs::read(settings_path(profile_root)).ok()
        .and_then(|bytes| serde_json::from_slice::<LocalSettings>(&bytes).ok())
        .map(|mut settings| { settings.detected_region = detected_region_label(); settings })
        .unwrap_or_else(|| { let mut settings = LocalSettings::default(); settings.detected_region = detected_region_label(); settings })
}

pub(crate) fn profile_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = if let Some(path) = std::env::var_os("FORMULASNAP_DATA_DIR") {
        let path = PathBuf::from(path);
        if !path.is_absolute() { return Err("FORMULASNAP_DATA_DIR 必须是绝对路径。".into()); }
        path
    } else { app.path().app_data_dir().map_err(|_| "无法找到 FormulaSnap 应用数据目录。")?.join("formulasnap") };
    fs::create_dir_all(&root).map_err(|e| format!("无法创建应用数据目录：{e}"))?;
    let marker = root.join(".formulasnap-data-root");
    if !marker.exists() {
        fs::write(marker, b"FormulaSnap application data root v1\n")
            .map_err(|error| format!("记录应用数据目录所有权失败：{error}"))?;
    }
    Ok(root)
}

fn has_managed_runtime(root: &Path) -> bool {
    miniforge_owner_marker(root).is_file()
        || owned_environment_marker(root, "cpu").is_file()
        || owned_environment_marker(root, "cuda").is_file()
}

fn resolve_runtime_root(
    profile_root: &Path,
    settings: &LocalSettings,
    executable_directory: Option<&Path>,
    reuse_legacy_runtime: bool,
) -> Result<PathBuf, String> {
    if !settings.storage_directory.trim().is_empty() {
        let selected = PathBuf::from(settings.storage_directory.trim());
        if !selected.is_absolute() { return Err("本地环境存储位置必须是绝对路径。".into()); }
        return Ok(selected.join("FormulaSnap"));
    }
    if reuse_legacy_runtime || executable_directory.is_none() {
        return Ok(profile_root.to_path_buf());
    }
    Ok(executable_directory.unwrap().join("FormulaSnapData"))
}

fn selected_runtime_root(profile_root: &Path, settings: &LocalSettings) -> Result<PathBuf, String> {
    if std::env::var_os("FORMULASNAP_DATA_DIR").is_some() {
        return Ok(profile_root.to_path_buf());
    }
    let executable_directory = if cfg!(windows) && !cfg!(debug_assertions) {
        std::env::current_exe().ok().and_then(|path| path.parent().map(Path::to_path_buf))
    } else {
        None
    };
    resolve_runtime_root(profile_root, settings, executable_directory.as_deref(), has_managed_runtime(profile_root))
}

fn initialize_managed_runtime_root(profile: &Path, root: &Path) -> Result<(), String> {
    if root == profile { return Ok(()); }
    let marker = root.join(".formulasnap-data-root");
    if marker.is_file() { return Ok(()); }
    if root.exists() && fs::read_dir(root).ok().is_some_and(|mut entries| entries.next().is_some()) {
        return Err("应用目录下的 FormulaSnapData 已存在但没有 FormulaSnap 所有权标记；为保护现有数据，请在高级设置选择其他存储位置。".into());
    }
    fs::create_dir_all(root).map_err(|error| format!("创建应用运行数据目录失败：{error}"))?;
    atomic_write(&marker, b"FormulaSnap managed local runtime data v1\n")
        .map_err(|error| format!("记录本地运行数据目录所有权失败：{error}"))?;
    // Models are path-independent. Conda environments are not: keep an older
    // environment at its original prefix and reuse it via has_managed_runtime.
    let legacy_model = model_dir(profile);
    if legacy_model.exists() {
        copy_managed_tree(&legacy_model, &model_dir(root))?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_local_settings(app: AppHandle) -> Result<LocalSettings, String> {
    Ok(read_local_settings(&profile_root(&app)?))
}

fn validate_https_endpoint(value: &str, label: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() { return Ok(()); }
    let Some(authority) = value.strip_prefix("https://") else {
        return Err(format!("{label}必须使用 HTTPS 地址。"));
    };
    let host = authority.split(['/', '?', '#']).next().unwrap_or_default();
    if host.is_empty() || host.contains('@') || host.chars().any(char::is_whitespace) {
        return Err(format!("{label}不是有效的 HTTPS 地址。"));
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Option<String> {
    fs::File::open(path).ok().and_then(|file| sha256_reader(file).ok())
}

fn copy_managed_tree(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.exists() { return Ok(()); }
    fs::create_dir_all(destination).map_err(|error| format!("准备迁移目录失败：{error}"))?;
    for entry in fs::read_dir(source).map_err(|error| format!("读取原运行目录失败：{error}"))? {
        let entry = entry.map_err(|error| format!("读取原运行目录条目失败：{error}"))?;
        let kind = entry.file_type().map_err(|error| format!("检查运行目录条目失败：{error}"))?;
        if kind.is_symlink() { return Err("运行环境包含符号链接；为避免越界复制，存储迁移已停止。".into()); }
        let target = destination.join(entry.file_name());
        if kind.is_dir() {
            copy_managed_tree(&entry.path(), &target)?;
        } else if kind.is_file() {
            if target.exists() {
                let same = fs::metadata(&entry.path()).ok().zip(fs::metadata(&target).ok())
                    .is_some_and(|(a, b)| a.len() == b.len() && sha256_file(&entry.path()) == sha256_file(&target));
                if !same { return Err(format!("目标目录已有不同的 FormulaSnap 数据文件 {}；未覆盖。", entry.file_name().to_string_lossy())); }
            } else {
                fs::copy(entry.path(), &target).map_err(|error| format!("复制运行数据失败：{error}"))?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn save_local_settings(app: AppHandle, state: State<'_, AppState>, mut settings: LocalSettings) -> Result<(), String> {
    let _guard = state.setup_lock.lock().await;
    if !matches!(settings.source_policy.as_str(), "auto" | "official" | "aliyun" | "tsinghua" | "custom") {
        return Err("下载源策略无效。".into());
    }
    validate_https_endpoint(&settings.custom_pypi_index, "自定义 PyPI 源")?;
    validate_https_endpoint(&settings.custom_conda_channel, "自定义 Conda channel")?;
    validate_https_endpoint(&settings.custom_miniforge_url, "自定义 Miniforge 安装器")?;
    validate_https_endpoint(&settings.custom_model_base_url, "自定义模型源")?;
    let profile = profile_root(&app)?;
    let old_settings = read_local_settings(&profile);
    let old_root = selected_runtime_root(&profile, &old_settings).ok();
    if settings.storage_directory.trim().is_empty() {
        settings.storage_directory.clear();
    } else {
        let selected = PathBuf::from(settings.storage_directory.trim());
        if !selected.is_absolute() || !selected.is_dir() {
            return Err("请选择已经存在的本地存储目录。".into());
        }
        settings.storage_directory = fs::canonicalize(selected).map_err(|error| format!("无法解析本地存储目录：{error}"))?.to_string_lossy().into_owned();
    }
    settings.detected_region = detected_region_label();
    let new_root = selected_runtime_root(&profile, &settings)?;
    let location_changed = old_root.as_deref() != Some(new_root.as_path());
    if location_changed {
        if let Some(old_root) = old_root.as_deref() {
            if new_root.starts_with(old_root) || old_root.starts_with(&new_root) {
                return Err("本地存储位置不能是当前 FormulaSnap 数据目录的父目录或子目录。".into());
            }
        }
        let target_marker = new_root.join(".formulasnap-data-root");
        let is_profile_root = new_root == profile;
        if !is_profile_root && new_root.exists() && !target_marker.is_file() && fs::read_dir(&new_root).ok().is_some_and(|mut files| files.next().is_some()) {
            return Err("所选目录下 FormulaSnap 子目录已有未标记内容；为保护文件，请选择空目录或此前由 FormulaSnap 使用的目录。".into());
        }
        if let Some(old_root) = old_root.as_deref() {
            // Stop the old worker before changing data roots; its child is configured kill-on-drop.
            state.local_worker.lock().await.take();
            let old_models = model_dir(old_root);
            if old_models.exists() { copy_managed_tree(&old_models, &model_dir(&new_root))?; }
        }
        fs::create_dir_all(&new_root).map_err(|error| format!("创建本地数据目录失败：{error}"))?;
        atomic_write(&target_marker, b"FormulaSnap managed local runtime data v1\n")
            .map_err(|error| format!("记录本地数据目录所有权失败：{error}"))?;
        // Conda environments embed their prefix. Keep the original environment in place;
        // the newly selected root will be configured on first recognition.
    }
    let bytes = serde_json::to_vec_pretty(&settings).map_err(|_| "生成本地设置失败。")?;
    atomic_write(&settings_path(&profile), &bytes).map_err(|error| format!("保存本地设置失败：{error}"))?;
    if location_changed { release_runtime_mount(); }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelStatus {
    model_name: String,
    model_version: String,
    model_directory: String,
    model_installed: bool,
    model_bytes: u64,
    python_executable: Option<String>,
    runtime_installed: bool,
    runtime_manifest_valid: bool,
    status_readable: bool,
    available_providers: Vec<String>,
    selected_device: String,
    active_backend: Option<String>,
    worker_running: bool,
    runtime_error: Option<String>,
    error: Option<String>,
}

pub(crate) fn app_root(app: &AppHandle) -> Result<PathBuf, String> {
    let profile = profile_root(app)?;
    let settings = read_local_settings(&profile);
    let root = selected_runtime_root(&profile, &settings)?;
    initialize_managed_runtime_root(&profile, &root)?;
    fs::create_dir_all(&root).map_err(|e| format!("无法创建 FormulaSnap 本地数据目录：{e}"))?;
    if runtime_path_needs_alias(&root) { ensure_runtime_mount(&root)?; }
    Ok(root)
}

fn detected_region_label() -> String {
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        unsafe extern "system" { fn GetUserGeoID(geo_class: i32) -> i32; }
        const GEOCLASS_NATION: i32 = 16;
        let geo_id = unsafe { GetUserGeoID(GEOCLASS_NATION) };
        return match geo_id {
            45 => "mainland".into(),
            104 | 115 | 237 => "non-mainland".into(),
            value if value > 0 => "non-mainland".into(),
            _ => "unknown".into(),
        };
    }
    #[cfg(not(windows))]
    { "unknown".into() }
}

#[derive(Clone, Copy)]
enum DownloadArtifact { Pypi, Conda }

fn source_candidates_for(
    policy: &str,
    region: &str,
    artifact: DownloadArtifact,
    custom_pypi: &str,
    custom_conda: &str,
) -> Vec<(String, String)> {
    let official = match artifact {
        DownloadArtifact::Pypi => ("https://pypi.org/simple/".to_string(), "PyPI 官方源".to_string()),
        DownloadArtifact::Conda => ("conda-forge".to_string(), "conda-forge 官方源".to_string()),
    };
    let aliyun = ("https://mirrors.aliyun.com/pypi/simple/".to_string(), "阿里云 PyPI 镜像".to_string());
    let tsinghua_pypi = ("https://pypi.tuna.tsinghua.edu.cn/simple/".to_string(), "清华 PyPI 镜像".to_string());
    let tsinghua_conda = ("https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge/".to_string(), "清华 conda-forge 镜像".to_string());
    let mut choices = match (policy, artifact) {
        ("custom", DownloadArtifact::Pypi) if !custom_pypi.trim().is_empty() =>
            vec![(custom_pypi.trim().to_string(), "自定义 PyPI 源".to_string()), official.clone()],
        ("custom", DownloadArtifact::Conda) if !custom_conda.trim().is_empty() =>
            vec![(custom_conda.trim().to_string(), "自定义 Conda channel".to_string()), official.clone()],
        ("aliyun", DownloadArtifact::Pypi) => vec![aliyun.clone(), official.clone()],
        ("aliyun", DownloadArtifact::Conda) => vec![tsinghua_conda.clone(), official.clone()],
        ("tsinghua", DownloadArtifact::Pypi) => vec![tsinghua_pypi.clone(), official.clone()],
        ("tsinghua", DownloadArtifact::Conda) => vec![tsinghua_conda.clone(), official.clone()],
        ("official", _) | ("custom", _) => vec![official.clone()],
        ("auto", DownloadArtifact::Pypi) if region == "mainland" =>
            vec![aliyun.clone(), tsinghua_pypi.clone()],
        ("auto", DownloadArtifact::Conda) if region == "mainland" =>
            vec![tsinghua_conda.clone(), official.clone()],
        ("auto", DownloadArtifact::Pypi) =>
            vec![official.clone(), aliyun.clone(), tsinghua_pypi.clone()],
        _ => vec![official.clone()],
    };
    choices.dedup_by(|left, right| left.0 == right.0);
    choices
}

fn source_candidates(app: &AppHandle, artifact: DownloadArtifact) -> Vec<(String, String)> {
    let settings = profile_root(app).map(|path| read_local_settings(&path)).unwrap_or_default();
    source_candidates_for(
        &settings.source_policy,
        &settings.detected_region,
        artifact,
        &settings.custom_pypi_index,
        &settings.custom_conda_channel,
    )
}

fn miniforge_asset_candidates(app: &AppHandle) -> Vec<(String, String)> {
    let settings = profile_root(app).map(|path| read_local_settings(&path)).unwrap_or_default();
    let official = format!("https://github.com/conda-forge/miniforge/releases/download/{MINIFORGE_TAG}/{MINIFORGE_ASSET}");
    let mut urls = Vec::new();
    if settings.source_policy == "custom" && !settings.custom_miniforge_url.trim().is_empty() {
        urls.push((settings.custom_miniforge_url.trim().to_owned(), "自定义 Miniforge 源".to_string()));
    }
    urls.push((official, "Miniforge 官方发布源".to_string()));
    urls.dedup_by(|left, right| left.0 == right.0);
    urls
}

fn model_asset_candidates(app: &AppHandle, filename: &str) -> Vec<(String, String)> {
    let settings = profile_root(app).map(|path| read_local_settings(&path)).unwrap_or_default();
    let official = format!("{MODEL_RELEASE}/{filename}");
    let mut urls = Vec::new();
    if settings.source_policy == "custom" && !settings.custom_model_base_url.trim().is_empty() {
        urls.push((format!("{}/{filename}", settings.custom_model_base_url.trim().trim_end_matches('/')), "自定义模型源".to_string()));
    }
    urls.push((official, "RapidLaTeXOCR 官方发布源".to_string()));
    urls.dedup_by(|left, right| left.0 == right.0);
    urls
}

async fn download_verified_asset(
    app: &AppHandle,
    client: &reqwest::Client,
    urls: &[(String, String)],
    temporary: &Path,
    expected_size: u64,
    expected_hash: &str,
    progress_stage: &str,
    progress_message: &str,
    completed_before: u64,
    total_bytes: u64,
) -> Result<(), String> {
    let mut last_error = String::new();
    for (source_index, (url, label)) in urls.iter().enumerate() {
        if source_index > 0 {
            reset_download_sample(completed_before);
            emit_setup(app, "source-switch", &format!("主下载源暂不可用，正在切换到 {label}…"), None);
        }
        let _ = async_fs::remove_file(temporary).await;
        let attempt: Result<(), String> = async {
            let response = client.get(url).send().await
                .map_err(|error| format!("连接{label}失败：{}", error.without_url()))?;
            if !response.status().is_success() { return Err(format!("{label}返回 HTTP {}。", response.status().as_u16())); }
            let mut completed = 0_u64;
            let mut hasher = Sha256::new();
            let mut file = async_fs::File::create(temporary).await.map_err(|error| format!("创建下载临时文件失败：{error}"))?;
            let mut stream = response.bytes_stream();
            loop {
                let next = tokio::time::timeout(Duration::from_secs(45), stream.next()).await
                    .map_err(|_| format!("{label}下载连续 45 秒没有收到数据，正在切换来源。"))?;
                let Some(chunk) = next else { break; };
                let chunk = chunk.map_err(|error| format!("{label}下载中断：{}", error.without_url()))?;
                completed = completed.saturating_add(chunk.len() as u64);
                if completed > expected_size { drop(file); return Err(format!("{label}下载大小超过固定版本文件大小。")); }
                hasher.update(&chunk);
                file.write_all(&chunk).await.map_err(|error| format!("写入下载文件失败：{error}"))?;
                emit_download_progress(app, progress_stage, progress_message, completed_before.saturating_add(completed), total_bytes);
            }
            file.flush().await.map_err(|error| format!("刷新下载文件失败：{error}"))?;
            drop(file);
            let actual_size = async_fs::metadata(temporary).await.map_err(|error| format!("检查下载文件失败：{error}"))?.len();
            emit_setup(app, "verify-download", "下载完成，正在校验文件大小和 SHA-256…", None);
            let actual_hash = format!("{:X}", hasher.finalize());
            if actual_size != expected_size || !actual_hash.eq_ignore_ascii_case(expected_hash) {
                return Err("固定版本文件的大小或 SHA-256 不匹配。".into());
            }
            Ok(())
        }.await;
        match attempt {
            Ok(()) => return Ok(()),
            Err(error) => {
                last_error = format!("{label}：{error}");
                let _ = async_fs::remove_file(temporary).await;
                if let Ok(root) = app_root(app) { write_frontend_diagnostic(&root, "download-source", &last_error); }
            }
        }
    }
    Err(format!("下载源暂不可用，请检查网络环境后重试。{}", last_error))
}

fn normalize_windows_path_for_comparison(path: &str) -> String {
    let path = path.replace('/', "\\");
    let path = if let Some(unc_path) = path.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{unc_path}")
    } else if let Some(plain_path) = path.strip_prefix("\\\\?\\") {
        plain_path.to_string()
    } else {
        path
    };
    path.trim_end_matches('\\').to_ascii_lowercase()
}

fn runtime_path_needs_alias(root: &Path) -> bool {
    let path = normalize_windows_path_for_comparison(&root.to_string_lossy());
    path.len() > 150 || !path.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, ':' | '\\' | '/' | '.' | '_' | '-')
    })
}

#[cfg(windows)]
#[derive(Clone)]
struct RuntimeMount { root: PathBuf, letter: char }

#[cfg(windows)]
static RUNTIME_MOUNT: OnceLock<Mutex<Option<RuntimeMount>>> = OnceLock::new();

#[cfg(windows)]
fn drive_is_in_use(letter: char) -> bool {
    #[link(name = "kernel32")]
    unsafe extern "system" { fn GetLogicalDrives() -> u32; }
    let index = letter.to_ascii_uppercase() as u32 - 'A' as u32;
    unsafe { GetLogicalDrives() & (1_u32 << index) != 0 }
}

#[cfg(windows)]
fn subst_command() -> Command {
    let executable = std::env::var_os("WINDIR").map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows")).join("System32").join("subst.exe");
    no_window_command(&executable)
}

#[cfg(windows)]
fn subst_maps_to(letter: char, root: &Path) -> bool {
    let Ok(output) = subst_command().output() else { return false; };
    if !output.status.success() { return false; }
    let needle = normalize_windows_path_for_comparison(&root.to_string_lossy());
    String::from_utf8_lossy(&output.stdout).lines().any(|line| {
        let Some((left, right)) = line.split_once("=>") else { return false; };
        left.trim().to_ascii_uppercase().starts_with(&format!("{}:", letter.to_ascii_uppercase()))
            && normalize_windows_path_for_comparison(right.trim()) == needle
    })
}

#[cfg(windows)]
fn ensure_runtime_mount(root: &Path) -> Result<char, String> {
    let mount = RUNTIME_MOUNT.get_or_init(|| Mutex::new(None));
    let mut active = mount.lock().map_err(|_| "本地运行目录状态不可用。")?;
    if let Some(current) = active.as_ref() {
        if current.root == root { return Ok(current.letter); }
        return Err("FormulaSnap 检测到另一个运行数据目录正在使用本地运行时。请先关闭另一个 FormulaSnap 窗口。".into());
    }
    let marker = root.join(".runtime-drive");
    let stored_letter = fs::read_to_string(&marker).ok().and_then(|text| text.trim().chars().next())
        .map(|letter| letter.to_ascii_uppercase());
    if let Some(letter) = stored_letter {
        if subst_maps_to(letter, root) {
            *active = Some(RuntimeMount { root: root.to_path_buf(), letter });
            return Ok(letter);
        }
        if !drive_is_in_use(letter) {
            let mut command = subst_command();
            command.arg(format!("{letter}:")).arg(root);
            let output = command.output().map_err(|error| format!("准备本地运行路径失败：{error}"))?;
            if output.status.success() {
                *active = Some(RuntimeMount { root: root.to_path_buf(), letter });
                return Ok(letter);
            }
        }
    }
    for byte in (b'D'..=b'Z').rev() {
        let letter = char::from(byte);
        if drive_is_in_use(letter) {
            if subst_maps_to(letter, root) {
                fs::write(&marker, letter.to_string()).map_err(|error| format!("记录本地运行路径失败：{error}"))?;
                *active = Some(RuntimeMount { root: root.to_path_buf(), letter });
                return Ok(letter);
            }
            continue;
        }
        let mut command = subst_command();
        command.arg(format!("{letter}:")).arg(root);
        let output = command.output().map_err(|error| format!("准备本地运行路径失败：{error}"))?;
        if !output.status.success() { continue; }
        fs::write(&marker, letter.to_string()).map_err(|error| format!("记录本地运行路径失败：{error}"))?;
        *active = Some(RuntimeMount { root: root.to_path_buf(), letter });
        return Ok(letter);
    }
    Err("没有可用于兼容本地 Python 安装器的临时盘符。关闭未使用的磁盘映射后重试。".into())
}
#[cfg(not(windows))]
fn ensure_runtime_mount(_root: &Path) -> Result<char, String> { Ok(' ') }

#[cfg(windows)]
fn runtime_tool_path(root: &Path, relative: impl AsRef<Path>) -> Result<PathBuf, String> {
    if runtime_path_needs_alias(root) {
        let letter = ensure_runtime_mount(root)?;
        Ok(PathBuf::from(format!("{letter}:\\")).join(relative))
    } else {
        Ok(root.join(relative))
    }
}

#[cfg(not(windows))]
fn runtime_tool_path(root: &Path, relative: impl AsRef<Path>) -> Result<PathBuf, String> {
    Ok(root.join(relative))
}

pub(crate) fn release_runtime_mount() {
    #[cfg(windows)]
    if let Some(mount) = RUNTIME_MOUNT.get().and_then(|mount| mount.lock().ok().and_then(|mut slot| slot.take())) {
        if subst_maps_to(mount.letter, &mount.root) {
            let mut command = subst_command();
            command.arg(format!("{}:", mount.letter)).arg("/D");
            let _ = command.output();
        }
    }
}
fn model_dir(root: &Path) -> PathBuf { root.join("models").join("rapid-latex-ocr-v0.0.0") }
fn model_owner_marker(root: &Path) -> PathBuf { model_dir(root).join(".formulasnap-owned") }
fn mark_model_owned(root: &Path) -> Result<(), String> {
    let directory = model_dir(root);
    let marker = model_owner_marker(root);
    if directory.exists() && !marker.is_file() {
        let is_empty = fs::read_dir(&directory).ok().is_some_and(|mut entries| entries.next().is_none());
        if !is_empty && verify_model_directory(&directory).is_err() {
            return Err("模型目录中有未标记的文件；为保护现有模型数据，FormulaSnap 不会覆盖或删除它。请更改应用数据目录后重试。".into());
        }
    }
    fs::create_dir_all(&directory).map_err(|error| format!("创建模型目录失败：{error}"))?;
    if !marker.is_file() {
        fs::write(marker, "FormulaSnap managed RapidLaTeXOCR model\n")
            .map_err(|error| format!("标记 FormulaSnap 模型目录失败：{error}"))?;
    }
    Ok(())
}
fn bundled_model_dir(app: &AppHandle) -> Option<PathBuf> {
    let packaged = app.path().resolve("resources/ocr-model", BaseDirectory::Resource).ok();
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/ocr-model");
    packaged.into_iter().chain(std::iter::once(development))
        .find(|directory| complete_model_directory(directory))
}
fn runtime_dir(root: &Path) -> PathBuf { root.join("runtime") }
fn validate_owned_model_cleanup(root: &Path, path: &Path) -> Result<(), String> {
    let expected = model_dir(root);
    let expected_parent = root.join("models");
    if path != expected || path.parent() != Some(expected_parent.as_path()) {
        return Err("拒绝删除应用数据目录以外的模型文件。".into());
    }
    if path.exists() && !model_owner_marker(root).is_file() {
        return Err("模型目录没有 FormulaSnap 所有权标记；为保护现有模型文件，未执行删除。".into());
    }
    Ok(())
}

async fn ensure_model_files(app: &AppHandle, root: &Path) -> Result<(), String> {
    let destination = model_dir(root);
    if verify_model_directory(&destination).is_ok() {
        mark_model_owned(root)?;
        return Ok(());
    }
    mark_model_owned(root)?;
    if let Some(source) = bundled_model_dir(app) {
        emit_setup(app, "model", "正在把随安装包预置的公式识别模型准备到应用数据目录…", Some(20));
        async_fs::create_dir_all(&destination).await.map_err(|error| format!("创建本地模型目录失败：{error}"))?;
        for (filename, _, _) in MODEL_FILES {
            async_fs::copy(source.join(filename), destination.join(filename)).await
                .map_err(|error| format!("复制预置模型文件 {filename} 失败：{error}"))?;
        }
        verify_model_directory(&destination)?;
        return Ok(());
    }
    emit_setup(app, "model", "安装包没有找到完整的预置模型，正在下载并校验模型…", Some(20));
    download_local_model_inner(app.clone(), root.to_path_buf()).await
}
fn runtime_error_file(root: &Path) -> PathBuf { runtime_dir(root).join("local-setup-error.txt") }

fn saved_runtime_error(root: &Path) -> Option<String> {
    fs::read_to_string(runtime_error_file(root)).ok().map(|value| value.trim().to_owned()).filter(|value| !value.is_empty())
}

fn save_runtime_error(root: &Path, error: &str) {
    let path = runtime_error_file(root);
    if let Some(parent) = path.parent() { let _ = fs::create_dir_all(parent); }
    let message = sanitize_diagnostic(root, error);
    let _ = fs::write(path, message);
}

fn clear_runtime_error(root: &Path) {
    let _ = fs::remove_file(runtime_error_file(root));
}
fn providers_file(root: &Path) -> PathBuf { root.join("runtime").join("providers.json") }
fn selected_device_file(root: &Path) -> PathBuf { root.join("runtime").join("selected-device") }

fn environment_dir(root: &Path, device: &str) -> PathBuf {
    runtime_dir(root).join("environments").join(device)
}

fn python_in(environment: &Path) -> PathBuf {
    if cfg!(windows) { environment.join("python.exe") }
    else { environment.join("bin").join("python") }
}

fn tool_environment_dir(root: &Path, device: &str) -> Result<PathBuf, String> {
    runtime_tool_path(root, PathBuf::from("runtime").join("environments").join(device))
}

fn tool_model_dir(root: &Path) -> Result<PathBuf, String> {
    runtime_tool_path(root, PathBuf::from("models").join("rapid-latex-ocr-v0.0.0"))
}

fn venv_python(root: &Path) -> Result<PathBuf, String> {
    let selected = fs::read_to_string(selected_device_file(root)).unwrap_or_else(|_| "cpu".into());
    let selected = match selected.trim() { "cuda" => "cuda", _ => "cpu" };
    let current_physical = python_in(&environment_dir(root, selected));
    if current_physical.is_file() {
        return Ok(python_in(&tool_environment_dir(root, selected)?));
    }
    let legacy_physical = python_in(&runtime_dir(root).join("conda"));
    if legacy_physical.is_file() {
        return Ok(python_in(&runtime_tool_path(root, PathBuf::from("runtime").join("conda"))?));
    }
    Ok(python_in(&tool_environment_dir(root, selected)?))
}
fn complete_model_directory(dir: &Path) -> bool {
    MODEL_FILES.iter().all(|(name, size, _)| dir.join(name).metadata().map(|meta| meta.len() == *size).unwrap_or(false))
}

fn sha256_reader(mut reader: impl Read) -> io::Result<String> {
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 { break; }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:X}", hasher.finalize()))
}

fn verify_model_directory(dir: &Path) -> Result<(), String> {
    for (name, expected_size, expected_hash) in MODEL_FILES {
        let path = dir.join(name);
        let metadata = fs::metadata(&path).map_err(|_| format!("缺少模型文件 {name}，请重新下载。"))?;
        if metadata.len() != expected_size {
            return Err(format!("模型文件 {name} 大小不符，文件可能损坏；请删除并重新下载。"));
        }
        let file = fs::File::open(&path).map_err(|e| format!("无法读取模型文件 {name}：{e}"))?;
        let actual_hash = sha256_reader(file).map_err(|e| format!("校验模型文件 {name} 失败：{e}"))?;
        if actual_hash != expected_hash {
            return Err(format!("模型文件 {name} 校验失败，文件可能损坏或被替换；请删除并重新下载。"));
        }
    }
    Ok(())
}

fn available_providers(root: &Path) -> Vec<String> {
    fs::read(providers_file(root)).ok().and_then(|bytes| serde_json::from_slice::<Vec<String>>(&bytes).ok()).unwrap_or_default()
}

fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "file path has no parent"))?;
    fs::create_dir_all(parent)?;
    let temporary = path.with_extension(format!("{}.tmp", path.extension().and_then(|value| value.to_str()).unwrap_or("data")));
    {
        use io::Write as _;
        let mut file = fs::OpenOptions::new().create(true).truncate(true).write(true).open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    replace_file_atomic(&temporary, path)
}

#[cfg(windows)]
fn replace_file_atomic(source: &Path, destination: &Path) -> io::Result<()> {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt};
    #[link(name = "kernel32")]
    unsafe extern "system" { fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32; }
    let wide = |value: &OsStr| value.encode_wide().chain(std::iter::once(0)).collect::<Vec<_>>();
    let source_wide = wide(source.as_os_str());
    let destination_wide = wide(destination.as_os_str());
    let result = unsafe { MoveFileExW(source_wide.as_ptr(), destination_wide.as_ptr(), 0x1 | 0x8) };
    if result == 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
}

#[cfg(not(windows))]
fn replace_file_atomic(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

fn write_runtime_manifest(root: &Path, manifest: &Value) -> Result<(), String> {
    let path = runtime_dir(root).join("runtime-manifest.json");
    let bytes = serde_json::to_vec_pretty(manifest).map_err(|_| "生成运行时清单失败。")?;
    atomic_write(&path, &bytes).map_err(|error| format!("原子保存运行时版本清单失败：{error}"))
}

fn runtime_manifest_compatible(root: &Path) -> bool {
    let path = runtime_dir(root).join("runtime-manifest.json");
    let Ok(contents) = fs::read(path) else { return false; };
    let Ok(value) = serde_json::from_slice::<Value>(&contents) else { return false; };
    let manifest_backend = value.get("backend").and_then(Value::as_str);
    let recorded_providers = available_providers(root);
    let selected = fs::read_to_string(selected_device_file(root)).unwrap_or_else(|_| "cpu".into());
    let selected = match selected.trim() { "cuda" => "cuda", _ => "cpu" };
    python_in(&environment_dir(root, selected)).is_file()
        && value.get("rapidLatexOcr").and_then(Value::as_str) == Some("0.0.9")
        && value.get("onnxRuntime").and_then(Value::as_str) == Some("1.23.2")
        && value.get("miniforge").and_then(Value::as_str).is_some_and(|version| version.starts_with(MINIFORGE_TAG))
        && value.get("smokeTest").and_then(Value::as_str).is_some_and(|value| !value.trim().is_empty())
        && manifest_backend.is_some_and(|backend| recorded_providers.iter().any(|provider| provider == backend))
}

#[tauri::command]
pub async fn check_local_model(app: AppHandle, state: State<'_, AppState>) -> Result<LocalModelStatus, String> {
    let _setup_guard = state.setup_lock.lock().await;
    let root = app_root(&app)?;
    let directory = model_dir(&root);
    let selected_for_recovery = fs::read_to_string(selected_device_file(&root)).unwrap_or_else(|_| "cpu".into());
    restore_interrupted_rebuild(&root, selected_for_recovery.trim())?;
    let installed = complete_model_directory(&directory);
    let bundled = bundled_model_dir(&app).is_some();
    let size = if installed {
        MODEL_FILES.iter().filter_map(|(name, _, _)| fs::metadata(directory.join(name)).ok()).map(|meta| meta.len()).sum()
    } else if bundled {
        MODEL_FILES.iter().map(|(_, expected, _)| *expected).sum()
    } else { 0 };
    let python = venv_python(&root);
    let runtime_installed = python.as_ref().is_ok_and(|path| path.is_file()) && providers_file(&root).is_file();
    let runtime_manifest_valid = runtime_installed && runtime_manifest_compatible(&root);
    let python = python.unwrap_or_else(|_| PathBuf::new());
    let selected_device = fs::read_to_string(selected_device_file(&root)).unwrap_or_else(|_| "cpu".into()).trim().to_owned();
    let mut worker = state.local_worker.lock().await;
    let worker_running = worker.as_mut().is_some_and(|item| matches!(item.child.try_wait(), Ok(None)));
    if !worker_running { worker.take(); }
    let active_backend = worker.as_ref().map(|item| item.backend.clone());
    let runtime_error = if runtime_manifest_valid { None } else { saved_runtime_error(&root) };
    let available = if runtime_installed { available_providers(&root) } else { Vec::new() };    Ok(LocalModelStatus {
        model_name: "RapidLaTeXOCR".into(),
        model_version: MODEL_VERSION.into(),
        model_directory: directory.to_string_lossy().into_owned(),
        model_installed: installed || bundled,
        model_bytes: size,
        python_executable: if python.is_file() { Some(python.to_string_lossy().into_owned()) } else { None },
        runtime_installed,
        runtime_manifest_valid,
        status_readable: true,
        available_providers: available,
        selected_device,
        active_backend,
        worker_running,
        runtime_error: runtime_error.clone(),
        error: runtime_error.or_else(|| if !runtime_installed { Some("本地识别尚未配置；点击“一键配置本地识别”即可自动准备运行环境和模型。".into()) } else { None }),
    })
}

#[tauri::command]
pub async fn download_local_model(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let _guard = state.setup_lock.lock().await;
    let root = app_root(&app)?;
    begin_setup_task(None);
    let result = download_local_model_inner(app.clone(), root.clone()).await;
    if let Err(error) = &result { save_runtime_error(&root, error); }
    result
}

async fn download_local_model_inner(app: AppHandle, root: PathBuf) -> Result<(), String> {
    mark_model_owned(&root)?;
    let directory = model_dir(&root);
    let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(15)).timeout(Duration::from_secs(300)).build().map_err(|_| "初始化模型下载器失败。")?;
    let total_bytes = MODEL_FILES.iter().map(|(_, size, _)| *size).sum::<u64>();
    let mut completed_before_file = 0_u64;
    for (filename, expected_size, expected_hash) in MODEL_FILES {
        let destination = directory.join(filename);
        if destination.metadata().map(|meta| meta.len() == expected_size).unwrap_or(false) {
            if let Ok(file) = fs::File::open(&destination) {
                if sha256_reader(file).ok().as_deref() == Some(expected_hash) {
                    completed_before_file = completed_before_file.saturating_add(expected_size);
                    continue;
                }
            }
        }
        let temp = directory.join(format!("{filename}.part"));
        let _ = async_fs::remove_file(&temp).await;
        let urls = model_asset_candidates(&app, filename);
        download_verified_asset(
            &app, &client, &urls, &temp, expected_size, expected_hash,
            "download-model", &format!("正在下载模型文件 {filename}"),
            completed_before_file, total_bytes,
        ).await?;
        if destination.exists() { async_fs::remove_file(&destination).await.map_err(|e| format!("替换已有模型文件失败：{e}"))?; }
        async_fs::rename(&temp, &destination).await.map_err(|e| format!("安装模型文件 {filename} 失败：{e}"))?;
        completed_before_file = completed_before_file.saturating_add(expected_size);
    }
    verify_model_directory(&directory)?;
    Ok(())
}

#[derive(Clone, Copy)]
enum ProcessEnvironment {
    Installer,
    Conda,
    Pip,
    Python,
    Worker,
}

fn emit_setup(app: &AppHandle, stage: &str, message: &str, _legacy_percent: Option<u8>) {
    ensure_progress_task();
    let status = match stage {
        "ready" => "complete",
        "failed" => "failed",
        "cancelled" => "cancelled",
        _ => "running",
    };
    let event = if let Ok(mut tracker) = progress_tracker().lock() {
        tracker.last_activity = epoch_millis();
        json!({
            "taskId": tracker.task_id,
            "status": status,
            "stage": stage,
            "message": message,
            "percent": if status == "complete" { Some(100_u8) } else { None },
            "downloadedBytes": null,
            "totalBytes": null,
            "bytesPerSecond": null,
            "elapsedMs": tracker.started.elapsed().as_millis() as u64,
            "estimatedRemainingMs": null,
            "lastActivityAt": tracker.last_activity
        })
    } else {
        json!({"taskId":"local-setup-unavailable","status":status,"stage":stage,"message":message,"percent":null})
    };
    let _ = app.emit("local-setup-progress", event);
}

fn download_percent(downloaded: u64, total: u64) -> Option<u8> {
    if total == 0 { None } else { Some(((downloaded.saturating_mul(100) / total).min(99)) as u8) }
}

fn reset_download_sample(downloaded: u64) {
    if let Ok(mut tracker) = progress_tracker().lock() {
        tracker.last_sample_at = Instant::now();
        tracker.last_sample_bytes = downloaded;
        tracker.smoothed_bytes_per_second = None;
    }
}

fn smooth_download_speed(previous: Option<f64>, transferred: u64, elapsed_seconds: f64) -> Option<f64> {
    if !elapsed_seconds.is_finite() || elapsed_seconds <= 0.0 { return previous; }
    let sample = transferred as f64 / elapsed_seconds;
    if !sample.is_finite() || sample <= 0.0 { return previous; }
    Some(previous.map_or(sample, |prior| prior * 0.72 + sample * 0.28))
}

fn remaining_download_ms(total: u64, downloaded: u64, bytes_per_second: Option<f64>) -> Option<u64> {
    let speed = bytes_per_second.filter(|value| value.is_finite() && *value > 0.0)?;
    Some((total.saturating_sub(downloaded) as f64 / speed * 1000.0).round() as u64)
}

fn emit_download_progress(app: &AppHandle, stage: &str, message: &str, downloaded: u64, total: u64) {
    ensure_progress_task();
    let now = Instant::now();
    let wall_now = epoch_millis();
    let event = if let Ok(mut tracker) = progress_tracker().lock() {
        let interval = now.duration_since(tracker.last_sample_at).as_secs_f64();
        if interval >= 0.35 && downloaded >= tracker.last_sample_bytes {
            tracker.smoothed_bytes_per_second = smooth_download_speed(
                tracker.smoothed_bytes_per_second,
                downloaded - tracker.last_sample_bytes,
                interval,
            );
            tracker.last_sample_at = now;
            tracker.last_sample_bytes = downloaded;
        }
        tracker.last_activity = wall_now;
        let speed = tracker.smoothed_bytes_per_second.filter(|value| value.is_finite() && *value > 0.0);
        let remaining = remaining_download_ms(total, downloaded, speed);
        let percent = download_percent(downloaded, total);
        json!({
            "taskId": tracker.task_id,
            "status": "running",
            "stage": stage,
            "message": message,
            "percent": percent,
            "downloadedBytes": downloaded,
            "totalBytes": (total > 0).then_some(total),
            "bytesPerSecond": speed,
            "elapsedMs": tracker.started.elapsed().as_millis() as u64,
            "estimatedRemainingMs": remaining,
            "lastActivityAt": tracker.last_activity
        })
    } else {
        json!({"taskId":"local-setup-unavailable","status":"running","stage":stage,"message":message,"percent":null,"downloadedBytes":downloaded,"totalBytes":total})
    };
    let _ = app.emit("local-setup-progress", event);
}

fn miniforge_dir(root: &Path) -> PathBuf {
    runtime_dir(root).join(format!("miniforge-{MINIFORGE_TAG}"))
}

fn miniforge_python(root: &Path) -> Result<PathBuf, String> {
    Ok(python_in(&runtime_tool_path(
        root,
        PathBuf::from("runtime").join(format!("miniforge-{MINIFORGE_TAG}")),
    )?))
}

fn no_window_command(program: &Path) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

fn setup_temp(root: &Path) -> PathBuf {
    runtime_dir(root).join("temp")
}

fn configure_process_environment(
    command: &mut Command,
    root: &Path,
    profile: ProcessEnvironment,
) -> Result<(), String> {
    let runtime = runtime_dir(root);
    let temp = setup_temp(root);
    let package_cache = runtime.join("conda-pkgs");
    let pip_cache = runtime.join("pip-cache");
    let home = runtime.join("home");
    let appdata = home.join("AppData").join("Roaming");
    let local_appdata = home.join("AppData").join("Local");
    let cache = runtime.join("cache");
    for directory in [
        &temp, &package_cache, &pip_cache, &home, &appdata, &local_appdata, &cache,
    ] {
        fs::create_dir_all(directory)
            .map_err(|error| format!("创建本地运行时目录失败：{error}"))?;
    }
    let tool_runtime = runtime_tool_path(root, "runtime")?;
    let tool_temp = tool_runtime.join("temp");
    let tool_package_cache = tool_runtime.join("conda-pkgs");
    let tool_pip_cache = tool_runtime.join("pip-cache");
    let tool_home = tool_runtime.join("home");
    let tool_appdata = tool_home.join("AppData").join("Roaming");
    let tool_local_appdata = tool_home.join("AppData").join("Local");
    let tool_cache = tool_runtime.join("cache");
    let pip_config = tool_runtime.join("pip.ini");
    if !runtime.join("pip.ini").exists() {
        fs::write(runtime.join("pip.ini"), "")
            .map_err(|error| format!("准备独立 pip 配置失败：{error}"))?;
    }
    let tool_condarc = tool_runtime.join("condarc");
    let mut isolated_paths = Vec::new();
    let base = PathBuf::from("runtime").join(format!("miniforge-{MINIFORGE_TAG}"));
    for device in ["cpu", "cuda"] {
        let environment = PathBuf::from("runtime").join("environments").join(device);
        isolated_paths.push(runtime_tool_path(root, &environment)?);
        isolated_paths.push(runtime_tool_path(root, environment.join("Scripts"))?);
    }
    isolated_paths.push(runtime_tool_path(root, base.join("Scripts"))?);
    isolated_paths.push(runtime_tool_path(root, &base)?);
    isolated_paths.push(runtime_tool_path(root, base.join("Library").join("bin"))?);
    if let Some(windows) = std::env::var_os("WINDIR") {
        isolated_paths.push(PathBuf::from(windows).join("System32"));
        isolated_paths.push(PathBuf::from(std::env::var_os("WINDIR").unwrap()).join("System32").join("WindowsPowerShell").join("v1.0"));
    }
    let isolated_path = std::env::join_paths(isolated_paths).map_err(|_| "无法隔离本地运行时的 PATH。")?;
    command
        .env_remove("PYTHONPATH")
        .env_remove("PYTHONHOME")
        .env_remove("CONDA_PREFIX")
        .env_remove("CONDA_DEFAULT_ENV")
        .env_remove("CONDA_EXE")
        .env_remove("CONDA_PYTHON_EXE")
        .env_remove("CONDA_SHLVL")
        .env_remove("CONDA_ENVS_PATH")
        .env_remove("CONDA_PKGS_DIRS")
        .env_remove("CONDA_NO_PLUGINS")
        .env_remove("PIP_USER")
        .env("TEMP", &tool_temp)
        .env("TMP", &tool_temp)
        .env("HOME", &tool_home)
        .env("USERPROFILE", &tool_home)
        .env("APPDATA", &tool_appdata)
        .env("LOCALAPPDATA", &tool_local_appdata)
        .env("XDG_CACHE_HOME", &tool_cache)
        .env("CONDA_PKGS_DIRS", &tool_package_cache)
        .env("CONDA_ENVS_PATH", tool_runtime.join("environments"))
        .env("CONDA_NUMBER_CHANNEL_NOTICES", "0")
        .env("CONDARC", tool_condarc)
        .env("PIP_CONFIG_FILE", pip_config)
        .env("PIP_CACHE_DIR", tool_pip_cache)
        .env("PIP_NO_INPUT", "1")
        .env("PYTHONNOUSERSITE", "1")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("PATH", isolated_path);
    if matches!(profile, ProcessEnvironment::Conda) {
        command.env("CONDA_NO_PLUGINS", "true");
    }
    Ok(())
}

#[cfg(windows)]
static MANAGED_PROCESS_IDS: OnceLock<Mutex<HashSet<u32>>> = OnceLock::new();

#[cfg(windows)]
fn register_managed_process(pid: u32) {
    if let Ok(mut values) = MANAGED_PROCESS_IDS.get_or_init(|| Mutex::new(HashSet::new())).lock() {
        values.insert(pid);
    }
}

#[cfg(not(windows))]
fn register_managed_process(_pid: u32) {}

#[cfg(windows)]
fn unregister_managed_process(pid: u32) {
    if let Some(values) = MANAGED_PROCESS_IDS.get() {
        if let Ok(mut values) = values.lock() { values.remove(&pid); }
    }
}

#[cfg(not(windows))]
fn unregister_managed_process(_pid: u32) {}

fn drain_bounded(mut reader: impl Read) -> Vec<u8> {
    let mut output = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                output.extend_from_slice(&chunk[..count]);
                if output.len() > MAX_COMMAND_OUTPUT {
                    let excess = output.len() - MAX_COMMAND_OUTPUT;
                    output.drain(..excess);
                }
            }
        }
    }
    output
}

fn sanitize_diagnostic(root: &Path, value: &str) -> String {
    let mut result = value.replace(&root.to_string_lossy().to_string(), "<app-data>");
    if let Some(home) = std::env::var_os("USERPROFILE") {
        result = result.replace(&PathBuf::from(home).to_string_lossy().to_string(), "<user-profile>");
    }
    let mut redacted = String::with_capacity(result.len());
    let mut rest = result.as_str();
    while let Some(index) = rest.find("sk-") {
        redacted.push_str(&rest[..index]);
        redacted.push_str("sk-[REDACTED]");
        let after = &rest[index + 3..];
        let token_end = after.find(|character: char| character.is_whitespace() || matches!(character, '"' | '\'' | ',' | ';'))
            .unwrap_or(after.len());
        rest = &after[token_end..];
    }
    redacted.push_str(rest);
    for marker in ["Bearer ", "bearer "] {
        if let Some(index) = redacted.find(marker) {
            let token_start = index + marker.len();
            let token_end = redacted[token_start..].find(char::is_whitespace).map(|offset| token_start + offset).unwrap_or(redacted.len());
            redacted.replace_range(token_start..token_end, "[REDACTED]");
        }
    }
    redacted
}

fn append_bounded_log(root: &Path, path: &Path, contents: &str) {
    if let Some(parent) = path.parent() { let _ = fs::create_dir_all(parent); }
    let safe = sanitize_diagnostic(root, contents);
    let previous = fs::read_to_string(path).unwrap_or_default();
    let mut combined = previous;
    combined.push_str(&safe);
    if combined.len() as u64 > MAX_DIAGNOSTIC_LOG {
        let keep_from = combined.len().saturating_sub(MAX_DIAGNOSTIC_LOG as usize);
        let boundary = combined.char_indices().find(|(index, _)| *index >= keep_from).map(|(index, _)| index).unwrap_or(combined.len());
        combined.drain(..boundary);
    }
    let _ = fs::write(path, combined);
}

pub(crate) fn write_frontend_diagnostic(root: &Path, category: &str, message: &str) {
    let category = category.chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .take(48)
        .collect::<String>();
    let path = runtime_dir(root).join("diagnostics").join("frontend.log");
    append_bounded_log(root, &path, &format!("[{category}] {message}\n"));
}
fn command_log(root: &Path) -> PathBuf {
    runtime_dir(root).join("diagnostics").join("commands.log")
}

fn record_process_event(root: &Path, stage: &str, action: &str, pid: u32, executable: &Path) {
    let parent_executable = std::env::current_exe().unwrap_or_default();
    let executable_display = executable.strip_prefix(root).map(Path::to_path_buf).unwrap_or_else(|_| executable.to_path_buf());
    let parent_display = parent_executable.strip_prefix(root).map(Path::to_path_buf).unwrap_or(parent_executable);
    append_bounded_log(
        root,
        &command_log(root),
        &format!(
            "[process] action={action}; stage={stage}; parent_pid={}; parent_executable={}; child_pid={pid}; executable={}\n",
            std::process::id(), parent_display.display(), executable_display.display()
        ),
    );
}

#[cfg(windows)]
fn stop_process_tree(pid: u32) {
    let executable = std::env::var_os("WINDIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows")).join("System32").join("taskkill.exe");
    let mut command = no_window_command(&executable);
    let _ = command.args(["/PID", &pid.to_string(), "/T", "/F"]).output();
}

#[cfg(not(windows))]
fn stop_process_tree(_pid: u32) {}

pub(crate) fn terminate_managed_processes() {
    #[cfg(windows)]
    if let Some(values) = MANAGED_PROCESS_IDS.get() {
        let pids = values.lock().map(|mut ids| {
            let result = ids.iter().copied().collect::<Vec<_>>();
            ids.clear();
            result
        }).unwrap_or_default();
        for pid in pids { stop_process_tree(pid); }
    }
}

fn run_command(
    program: &Path,
    args: &[String],
    what: &str,
    root: &Path,
    profile: ProcessEnvironment,
    timeout: Duration,
) -> Result<Output, String> {
    let mut command = no_window_command(program);
    command.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    configure_process_environment(&mut command, root, profile)?;
    let mut child = command.spawn().map_err(|error| {
        let message = format!("{what}启动失败：{error}");
        append_bounded_log(root, &command_log(root), &format!("{message}\n"));
        message
    })?;
    let pid = child.id();
    register_managed_process(pid);
    record_process_event(root, what, "started", pid, program);
    let stdout_reader = child.stdout.take().map(|stdout| thread::spawn(move || drain_bounded(stdout)));
    let stderr_reader = child.stderr.take().map(|stderr| thread::spawn(move || drain_bounded(stderr)));
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(100)),
            Ok(None) => {
                stop_process_tree(pid);
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Err(error) => {
                stop_process_tree(pid);
                let _ = child.kill();
                let _ = child.wait();
                record_process_event(root, what, "wait-error-terminated", pid, program);
                unregister_managed_process(pid);
                return Err(format!("{what}状态读取失败：{error}"));
            }
        }
    };
    match &status {
        Some(status) => record_process_event(root, what, &format!("exited-code-{:?}", status.code()), pid, program),
        None => record_process_event(root, what, "timeout-termination-requested", pid, program),
    }
    unregister_managed_process(pid);
    let stdout = stdout_reader.and_then(|handle| handle.join().ok()).unwrap_or_default();
    let stderr = stderr_reader.and_then(|handle| handle.join().ok()).unwrap_or_default();
    let Some(status) = status else {
        let stdout_text = sanitize_diagnostic(root, &String::from_utf8_lossy(&stdout));
        let stderr_text = sanitize_diagnostic(root, &String::from_utf8_lossy(&stderr));
        append_bounded_log(root, &command_log(root), &format!("{what}超时（{:?}）\nstdout:\n{stdout_text}\nstderr:\n{stderr_text}\n", timeout));
        return Err(format!("{what}超过 {:?}，应用已停止该安装进程。可重试；诊断已保存在应用数据目录。", timeout));
    };
    let output = Output { status, stdout, stderr };
    if !output.status.success() {
        let stdout_text = String::from_utf8_lossy(&output.stdout);
        let stderr_text = String::from_utf8_lossy(&output.stderr);
        append_bounded_log(root, &command_log(root), &format!("{what}退出码 {:?}\nstdout:\n{stdout_text}\nstderr:\n{stderr_text}\n", output.status.code()));
    }
    Ok(output)
}

fn command_failure(what: &str, output: &Output, root: &Path) -> String {
    let stdout = sanitize_diagnostic(root, &String::from_utf8_lossy(&output.stdout));
    let stderr = sanitize_diagnostic(root, &String::from_utf8_lossy(&output.stderr));
    let log = command_log(root);
    let detail = if !stderr.trim().is_empty() { stderr } else { stdout };
    let detail = detail.chars().rev().take(1800).collect::<String>().chars().rev().collect::<String>();
    if detail.trim().is_empty() {
        format!("{what}失败（退出码 {:?}）。可在设置中重试；诊断已保存到应用数据目录。", output.status.code())
    } else {
        format!("{what}失败（退出码 {:?}）：{}\n诊断：{}", output.status.code(), detail.trim(), log.display())
    }
}

fn run_checked(
    program: &Path,
    args: &[String],
    what: &str,
    root: &Path,
    profile: ProcessEnvironment,
    timeout: Duration,
) -> Result<(), String> {
    let output = run_command(program, args, what, root, profile, timeout)?;
    if output.status.success() { Ok(()) } else { Err(command_failure(what, &output, root)) }
}

fn run_pip_with_failover(
    app: &AppHandle,
    python: &Path,
    args: &[String],
    what: &str,
    root: &Path,
    timeout: Duration,
) -> Result<(), String> {
    let sources = source_candidates(app, DownloadArtifact::Pypi);
    let mut last_error = String::new();
    for (index, (url, label)) in sources.iter().enumerate() {
        if index > 0 {
            emit_setup(app, "source-switch", &format!("PyPI 主源暂不可用，正在切换到 {label}…"), None);
        }
        let mut attempt_args = args.to_vec();
        attempt_args.extend(["--index-url".into(), url.clone(), "--retries".into(), "2".into(), "--timeout".into(), "30".into()]);
        match run_checked(python, &attempt_args, what, root, ProcessEnvironment::Pip, timeout) {
            Ok(()) => return Ok(()),
            Err(error) => last_error = format!("{label}：{error}"),
        }
    }
    Err(format!("依赖下载源暂不可用，请检查网络环境后重试。{last_error}"))
}

fn miniforge_installer_args(prefix: &Path) -> Vec<String> {
    vec![
        "/S".to_string(),
        "/Q".to_string(),
        "/InstallationType=JustMe".to_string(),
        "/RegisterPython=0".to_string(),
        "/AddToPath=0".to_string(),
        format!("/D={}", prefix.display()),
    ]
}
fn miniforge_owner_marker(root: &Path) -> PathBuf {
    runtime_dir(root).join(format!(".owned-miniforge-{MINIFORGE_TAG}"))
}

fn owned_environment_marker(root: &Path, device: &str) -> PathBuf {
    runtime_dir(root).join(format!(".owned-environment-{device}"))
}

fn owned_environment(root: &Path, device: &str) -> bool {
    matches!(device, "cpu" | "cuda") && owned_environment_marker(root, device).is_file()
}

fn cleanup_owned_runtime(root: &Path, path: &Path, marker: &Path) -> Result<(), String> {
    if !marker.is_file() { return Ok(()); }
    let expected_parent = runtime_dir(root);
    if !path.starts_with(&expected_parent) || path == expected_parent {
        return Err("拒绝清理不属于 FormulaSnap 的运行目录。".into());
    }
    if path.exists() {
        fs::remove_dir_all(path).map_err(|error| format!("清理 FormulaSnap 未完成运行目录失败：{error}"))?;
    }
    let _ = fs::remove_file(marker);
    Ok(())
}

fn cleanup_environment_if_owned(root: &Path, device: &str) -> Result<(), String> {
    let directory = environment_dir(root, device);
    if directory.exists() {
        let marker = owned_environment_marker(root, device);
        if marker.is_file() {
            cleanup_owned_runtime(root, &directory, &marker)?;
        } else {
            write_frontend_diagnostic(root, "runtime-cleanup", &format!("Preserved unmarked {device} environment at <app-data>."));
        }
    }
    Ok(())
}

fn rebuild_backup_directory(root: &Path, device: &str) -> PathBuf {
    runtime_dir(root).join("rebuild-backups").join(device)
}

fn rebuild_backup_marker(root: &Path, device: &str) -> PathBuf {
    runtime_dir(root).join(format!(".owned-rebuild-backup-{device}"))
}

fn rebuild_environment_marker(root: &Path, device: &str) -> PathBuf {
    runtime_dir(root).join(format!(".owned-environment-backup-{device}"))
}

fn copy_state_snapshot(root: &Path, device: &str, backup: &Path) -> Result<(), String> {
    fs::create_dir_all(backup).map_err(|error| format!("创建环境回滚目录失败：{error}"))?;
    let marker = rebuild_backup_marker(root, device);
    if !marker.exists() {
        fs::write(&marker, format!("FormulaSnap rebuild backup for {device}\n"))
            .map_err(|error| format!("记录回滚目录所有权失败：{error}"))?;
    }
    let files = [
        ("providers.json", providers_file(root)),
        ("selected-device", selected_device_file(root)),
        ("runtime-manifest.json", runtime_dir(root).join("runtime-manifest.json")),
    ];
    let mut state = serde_json::Map::new();
    for (name, source) in files {
        let exists = source.is_file();
        state.insert(name.to_owned(), Value::Bool(exists));
        if exists {
            fs::copy(&source, backup.join(name)).map_err(|error| format!("备份本地环境状态失败：{error}"))?;
        }
    }
    let bytes = serde_json::to_vec(&Value::Object(state)).map_err(|_| "生成环境回滚清单失败。")?;
    atomic_write(&backup.join("state.json"), &bytes).map_err(|error| format!("保存环境回滚清单失败：{error}"))?;
    Ok(())
}

fn restore_state_snapshot(root: &Path, backup: &Path) -> Result<(), String> {
    let metadata: Value = serde_json::from_slice(&fs::read(backup.join("state.json"))
        .map_err(|error| format!("读取环境回滚清单失败：{error}"))?)
        .map_err(|_| "环境回滚清单损坏；请保留诊断目录并联系支持。")?;
    let files = [
        ("providers.json", providers_file(root)),
        ("selected-device", selected_device_file(root)),
        ("runtime-manifest.json", runtime_dir(root).join("runtime-manifest.json")),
    ];
    for (name, destination) in files {
        if metadata.get(name).and_then(Value::as_bool) == Some(true) {
            let bytes = fs::read(backup.join(name)).map_err(|error| format!("读取环境备份 {name} 失败：{error}"))?;
            atomic_write(&destination, &bytes).map_err(|error| format!("恢复环境状态 {name} 失败：{error}"))?;
        } else if destination.exists() {
            fs::remove_file(&destination).map_err(|error| format!("恢复环境状态 {name} 失败：{error}"))?;
        }
    }
    Ok(())
}

fn cleanup_rebuild_backup(root: &Path, device: &str) -> Result<(), String> {
    let backup = rebuild_backup_directory(root, device);
    let marker = rebuild_backup_marker(root, device);
    if backup.exists() {
        if !marker.is_file() { return Err("环境回滚目录缺少 FormulaSnap 所有权标记；为保护数据，未删除该目录。".into()); }
        cleanup_owned_runtime(root, &backup, &marker)?;
    }
    let old_environment_marker = rebuild_environment_marker(root, device);
    if old_environment_marker.is_file() { fs::remove_file(old_environment_marker).map_err(|error| format!("清理环境备份标记失败：{error}"))?; }
    Ok(())
}

fn restore_interrupted_rebuild(root: &Path, device: &str) -> Result<(), String> {
    if !matches!(device, "cpu" | "cuda") { return Ok(()); }
    let backup = rebuild_backup_directory(root, device);
    let old_environment = backup.join("environment");
    if !backup.exists() && !rebuild_backup_marker(root, device).exists() { return Ok(()); }
    if !rebuild_backup_marker(root, device).is_file() {
        return Err("检测到未标记的环境回滚目录；为保护其中的数据，未自动修改。".into());
    }
    if runtime_manifest_compatible(root) {
        return cleanup_rebuild_backup(root, device);
    }
    let current = environment_dir(root, device);
    if old_environment.exists() {
        if current.exists() {
            if !owned_environment(root, device) {
                return Err("恢复环境时发现未标记的目标目录；为保护文件，未覆盖该目录。".into());
            }
            cleanup_environment_if_owned(root, device)?;
        }
        fs::rename(&old_environment, &current).map_err(|error| format!("恢复上次可用的本地环境失败：{error}"))?;
        let backup_marker = rebuild_environment_marker(root, device);
        if backup_marker.is_file() {
            fs::rename(&backup_marker, owned_environment_marker(root, device))
                .map_err(|error| format!("恢复本地环境所有权标记失败：{error}"))?;
        }
        restore_state_snapshot(root, &backup)?;
    }
    cleanup_rebuild_backup(root, device)
}
async fn ensure_miniforge(app: &AppHandle, root: &Path) -> Result<String, String> {
    let install_prefix = miniforge_dir(root);
    let python = miniforge_python(root)?;
    if python.is_file() {
        let probe = run_command(
            &python,
            &["-c".into(), "import conda; print(conda.__version__)".into()],
            "检查应用内 Conda 运行时",
            root,
            ProcessEnvironment::Python,
            Duration::from_secs(30),
        )?;
        if probe.status.success() {
            let version = String::from_utf8_lossy(&probe.stdout).trim().to_owned();
            if version == MINIFORGE_CONDA_VERSION {
                return Ok(format!("{MINIFORGE_TAG} / conda {version}"));
            }
        }
    }

    emit_setup(app, "bootstrap", "正在下载并校验应用内 Miniforge 运行时…", Some(2));
    let runtime = runtime_dir(root);
    fs::create_dir_all(&runtime).map_err(|error| format!("创建运行时目录失败：{error}"))?;
    let download_dir = runtime.join("downloads");
    async_fs::create_dir_all(&download_dir).await.map_err(|error| format!("创建运行时下载目录失败：{error}"))?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(1200))
        .user_agent("FormulaSnap/0.1.5 local-runtime")
        .build()
        .map_err(|_| "初始化独立运行时下载器失败。")?;
    let urls = miniforge_asset_candidates(app);
    let installer = download_dir.join(MINIFORGE_ASSET);
    let mut verified = false;
    if fs::metadata(&installer).is_ok_and(|metadata| metadata.len() == MINIFORGE_SIZE) {
        if let Ok(file) = fs::File::open(&installer) {
            verified = sha256_reader(file).is_ok_and(|actual| actual.eq_ignore_ascii_case(MINIFORGE_SHA256));
        }
    }
    if !verified {
        if installer.exists() { async_fs::remove_file(&installer).await.map_err(|error| format!("移除损坏的运行时安装包失败：{error}"))?; }
        let partial = installer.with_extension("part");
        if partial.exists() { async_fs::remove_file(&partial).await.map_err(|error| format!("清理未完成的运行时下载失败：{error}"))?; }
        download_verified_asset(
            app, &client, &urls, &partial, MINIFORGE_SIZE, MINIFORGE_SHA256,
            "download-runtime", "正在下载固定版本的 Miniforge 运行环境",
            0, MINIFORGE_SIZE,
        ).await?;
        async_fs::rename(&partial, &installer).await.map_err(|error| format!("保存 Miniforge 安装包失败：{error}"))?;
    }

    let owner = miniforge_owner_marker(root);
    if install_prefix.exists() {
        if !owner.is_file() {
            return Err("Miniforge 目标目录已存在但没有 FormulaSnap 所有权标记。为保护已有文件，安装已停止；请在设置中更改应用数据目录后重试。".into());
        }
        cleanup_owned_runtime(root, &install_prefix, &owner)?;
    }
    fs::write(&owner, format!("FormulaSnap Miniforge {MINIFORGE_TAG}\n"))
        .map_err(|error| format!("标记本应用创建的 Miniforge 目录失败：{error}"))?;
    fs::create_dir_all(&install_prefix).map_err(|error| format!("准备 Miniforge 安装目录失败：{error}"))?;
    emit_setup(app, "bootstrap", "正在静默安装隔离运行时…", None);
    let tool_installer = runtime_tool_path(root, PathBuf::from("runtime").join("downloads").join(MINIFORGE_ASSET))?;
    let tool_prefix = runtime_tool_path(root, PathBuf::from("runtime").join(format!("miniforge-{MINIFORGE_TAG}")))?;
    let args = miniforge_installer_args(&tool_prefix);
    let output = run_command(
        &tool_installer,
        &args,
        "静默安装 Miniforge",
        root,
        ProcessEnvironment::Installer,
        Duration::from_secs(20 * 60),
    );
    let mut install_error = output.as_ref().err().cloned();
    if let Ok(output) = &output {
        if !output.status.success() {
            install_error = Some(command_failure("静默安装 Miniforge", output, root));
        }
    }
    if !python.is_file() {
        install_error.get_or_insert_with(|| "安装器已结束，但未找到应用内 Python 解释器。".into());
    }
    if let Some(error) = install_error {
        let step_logs = [
            install_prefix.join(".step.log"),
            install_prefix.join("conda-meta").join(".step.log"),
            runtime.join("miniforge").join(".step.log"),
        ];
        let mut log = format!("版本：{MINIFORGE_TAG}\n安装器：{error}\n");
        if let Ok(output) = output {
            log.push_str(&format!("退出码：{:?}\n", output.status.code()));
            log.push_str("stdout:\n");
            log.push_str(&String::from_utf8_lossy(&output.stdout));
            log.push_str("\nstderr:\n");
            log.push_str(&String::from_utf8_lossy(&output.stderr));
        }
        for path in step_logs {
            if let Ok(contents) = fs::read_to_string(path) {
                log.push_str("\n.step.log:\n");
                log.push_str(&contents);
                break;
            }
        }
        let diagnostic_path = runtime.join("diagnostics").join("miniforge-install.log");
        append_bounded_log(root, &diagnostic_path, &log);
        let _ = cleanup_owned_runtime(root, &install_prefix, &owner);
        return Err(format!("{error}\n安装诊断已保存在应用数据目录：{}", diagnostic_path.display()));
    }
    let version_probe = run_command(
        &python,
        &["-c".into(), "import conda; print(conda.__version__)".into()],
        "验证应用内 Conda 运行时",
        root,
        ProcessEnvironment::Python,
        Duration::from_secs(30),
    )?;
    if !version_probe.status.success() {
        let diagnostic_path = runtime.join("diagnostics").join("miniforge-install.log");
        let error = command_failure("验证应用内 Conda 运行时", &version_probe, root);
        append_bounded_log(root, &diagnostic_path, &error);
        let _ = cleanup_owned_runtime(root, &install_prefix, &owner);
        return Err(error);
    }
    let conda_version = String::from_utf8_lossy(&version_probe.stdout).trim().to_owned();
    if conda_version != MINIFORGE_CONDA_VERSION {
        return Err(format!("Miniforge 版本校验失败：期望 conda {MINIFORGE_TAG}，实际为 {conda_version}。"));
    }
    let version_file = runtime.join("miniforge-version");
    fs::write(version_file, MINIFORGE_TAG).map_err(|error| format!("记录 Miniforge 版本失败：{error}"))?;
    Ok(format!("{MINIFORGE_TAG} / conda {conda_version}"))
}
fn nvidia_driver_summary() -> Option<String> {
    let mut command = no_window_command(Path::new("nvidia-smi"));
    command.args(["--query-gpu=name,driver_version", "--format=csv,noheader"]);
    let output = command.output().ok()?;
    if !output.status.success() { return None; }
    let summary = String::from_utf8_lossy(&output.stdout).lines().next()?.trim().to_owned();
    if summary.is_empty() { None } else { Some(summary) }
}

fn verify_providers(python: &Path, root: &Path) -> Result<Vec<String>, String> {
    let output = run_command(
        python,
        &[
            "-c".into(),
            "import json,onnxruntime; print(json.dumps(onnxruntime.get_available_providers()))".into(),
        ],
        "检查 ONNX Runtime 后端",
        root,
        ProcessEnvironment::Python,
        Duration::from_secs(60),
    )?;
    if !output.status.success() {
        return Err(command_failure("检查 ONNX Runtime 后端", &output, root));
    }
    serde_json::from_slice(&output.stdout).map_err(|_| "无法解析 ONNX Runtime 后端列表。".into())
}

fn install_runtime_blocking(app: AppHandle, root: PathBuf, device: String) -> Result<Vec<String>, String> {
    if !matches!(device.as_str(), "cpu" | "cuda") {
        return Err("推理设备只支持自动选择的 CUDA 或 CPU。".into());
    }
    let base_python = miniforge_python(&root)?;
    if !base_python.is_file() { return Err("应用内 Miniforge 运行时尚未安装。".into()); }
    let environment = environment_dir(&root, &device);
    let tool_environment = tool_environment_dir(&root, &device)?;
    let python = python_in(&environment);
    let tool_python = python_in(&tool_environment);
    let runtime = runtime_dir(&root);
    let required_provider = if device == "cuda" { "CUDAExecutionProvider" } else { "CPUExecutionProvider" };
    if python.is_file() {
        if let Ok(providers) = verify_providers(&tool_python, &root) {
            if providers.iter().any(|provider| provider == required_provider) {
                atomic_write(&providers_file(&root), &serde_json::to_vec(&providers).map_err(|_| "保存后端信息失败。")?)
                    .map_err(|error| format!("保存后端信息失败：{error}"))?;
                atomic_write(&selected_device_file(&root), device.as_bytes()).map_err(|error| format!("保存设备设置失败：{error}"))?;
                return Ok(providers);
            }
        }
        if owned_environment(&root, &device) {
            cleanup_owned_runtime(&root, &environment, &owned_environment_marker(&root, &device))?;
        } else {
            return Err(format!("应用内 {device} Python 环境存在但无法通过后端验证；为保护未标记目录，未自动删除。请更改应用数据目录后重试。"));
        }
    } else if environment.exists() {
        if owned_environment(&root, &device) {
            cleanup_owned_runtime(&root, &environment, &owned_environment_marker(&root, &device))?;
        } else {
            return Err(format!("应用内 {device} 环境目录已存在但不是 FormulaSnap 创建的目录；为保护其中的文件，未自动删除。"));
        }
    }
    fs::create_dir_all(environment.parent().ok_or("无法解析隔离 Python 环境目录。")?)
        .map_err(|error| format!("创建隔离 Python 环境目录失败：{error}"))?;
    fs::create_dir_all(&runtime).map_err(|error| format!("创建运行时目录失败：{error}"))?;
    fs::write(owned_environment_marker(&root, &device), format!("FormulaSnap isolated {device} environment\n"))
        .map_err(|error| format!("标记应用内 Python 环境失败：{error}"))?;
    emit_setup(&app, "environment", "正在创建隔离 Python 3.10 环境…", Some(30));
    let channels = source_candidates(&app, DownloadArtifact::Conda);
    let mut environment_created = false;
    let mut last_channel_error = String::new();
    for (channel_index, (channel, label)) in channels.iter().enumerate() {
        if channel_index > 0 {
            emit_setup(&app, "source-switch", &format!("Conda 主源暂不可用，正在切换到 {label}…"), None);
        }
        let create_args = vec![
            "-m".into(), "conda".into(), "create".into(), "--yes".into(),
            "--prefix".into(), tool_environment.to_string_lossy().into_owned(),
            "--override-channels".into(), "--channel".into(), channel.clone(),
            "--solver".into(), "classic".into(), "python=3.10".into(), "pip".into(),
        ];
        match run_checked(
            &base_python, &create_args, "创建应用内 Python 3.10 隔离环境",
            &root, ProcessEnvironment::Conda, Duration::from_secs(45 * 60),
        ) {
            Ok(()) => { environment_created = true; break; }
            Err(error) => {
                last_channel_error = format!("{label}：{error}");
                cleanup_environment_if_owned(&root, &device)?;
                fs::write(owned_environment_marker(&root, &device), format!("FormulaSnap isolated {device} environment\n"))
                    .map_err(|write_error| format!("准备 Conda 备用源重试失败：{write_error}"))?;
            }
        }
    }
    if !environment_created {
        return Err(format!("Conda 环境源暂不可用，请检查网络环境后重试。{last_channel_error}"));
    }
    if !python.is_file() {
        return Err("Conda 创建完成但隔离 Python 解释器不存在；可重试一键配置。".into());
    }
    emit_setup(&app, "dependencies", "正在安装公式识别和推理依赖…", None);
    let ocr_args = vec![
        "-m".into(), "pip".into(), "install".into(), "--disable-pip-version-check".into(),
        "--no-warn-script-location".into(), "--no-deps".into(), "rapid-latex-ocr==0.0.9".into(),
    ];
    run_pip_with_failover(
        &app, &tool_python, &ocr_args, "安装公式识别组件", &root, Duration::from_secs(30 * 60),
    )?;
    let runtime_package = if device == "cuda" {
        "onnxruntime-gpu[cuda,cudnn]==1.23.2"
    } else {
        "onnxruntime==1.23.2"
    };
    let runtime_args = vec![
        "-m".into(), "pip".into(), "install".into(), "--disable-pip-version-check".into(),
        "--no-warn-script-location".into(), "tokenizers>=0.13.2".into(), "numpy<2.0.0".into(),
        "opencv-python==4.11.0.86".into(), "Pillow>=9.2.0".into(), "PyYAML".into(), "chardet".into(),
        "requests>=2.32,<3".into(), "tqdm>=4.67,<5".into(), runtime_package.into(),
    ];
    run_pip_with_failover(
        &app,
        &tool_python,
        &runtime_args,
        if device == "cuda" { "安装 CUDA 12.8 / cuDNN 9 推理运行时" } else { "安装 CPU 推理运行时" },
        &root,
        Duration::from_secs(45 * 60),
    )?;
    let providers = verify_providers(&tool_python, &root)?;
    if !providers.iter().any(|provider| provider == required_provider) {
        return Err(format!("所选后端 {required_provider} 未出现在 ONNX Runtime 列表 [{}] 中。", providers.join(", ")));
    }
    atomic_write(&providers_file(&root), &serde_json::to_vec(&providers).map_err(|_| "保存后端信息失败。")?)
        .map_err(|error| format!("保存后端信息失败：{error}"))?;
    atomic_write(&selected_device_file(&root), device.as_bytes()).map_err(|error| format!("保存设备设置失败：{error}"))?;
    Ok(providers)
}
#[tauri::command]
pub async fn install_local_runtime(app: AppHandle, state: State<'_, AppState>, device: String) -> Result<(), String> {
    let _guard = state.setup_lock.lock().await;
    let root = app_root(&app)?;
    begin_setup_task(None);
    *state.local_worker.lock().await = None;
    let result = async {
        ensure_miniforge(&app, &root).await?;
        let stage_device = device.clone();
        let stage_app = app.clone();
        let stage_root = root.clone();
        tokio::task::spawn_blocking(move || install_runtime_blocking(stage_app, stage_root, stage_device))
            .await.map_err(|error| format!("本地运行时安装任务异常：{error}"))?
    }.await;
    match result {
        Ok(_) => { clear_runtime_error(&root); Ok(()) }
        Err(error) => {
            save_runtime_error(&root, &error);
            emit_setup(&app, "failed", &sanitize_diagnostic(&root, &error), None);
            Err(error)
        }
    }
}
fn worker_log(root: &Path) -> PathBuf {
    runtime_dir(root).join("diagnostics").join("local-worker.log")
}

fn worker_error(root: &Path, message: &str) -> String {
    let diagnostic = fs::read_to_string(worker_log(root)).unwrap_or_default();
    let tail = diagnostic.chars().rev().take(1400).collect::<String>().chars().rev().collect::<String>();
    if tail.trim().is_empty() {
        format!("{message}；诊断日志位于应用数据目录。")
    } else {
        format!("{message}\n工作进程诊断：{tail}")
    }
}

impl Drop for PythonWorker {
    fn drop(&mut self) {
        let action = match self.child.try_wait() {
            Ok(Some(status)) => format!("worker-exited-code-{:?}", status.code()),
            Ok(None) => "worker-drop-kill-requested".into(),
            Err(_) => "worker-state-unavailable-on-drop".into(),
        };
        record_process_event(&self.diagnostic_root, "Python OCR worker", &action, self.pid, &self.executable);
        unregister_managed_process(self.pid);
    }
}

async fn spawn_worker(app: &AppHandle, device: &str) -> Result<PythonWorker, String> {
    let root = app_root(app)?;
    let python = venv_python(&root)?;
    if !python.is_file() || !providers_file(&root).is_file() {
        return Err("先安装本地 Python 运行环境。".into());
    }
    let dir = model_dir(&root);
    if !complete_model_directory(&dir) {
        return Err("本地模型文件缺失或大小异常，请重新下载。".into());
    }
    verify_model_directory(&dir)?;
    let runner = runtime_dir(&root).join("local_runner.py");
    if !runner.is_file() {
        async_fs::write(&runner, RUNNER).await.map_err(|error| format!("准备本地模型工作进程失败：{error}"))?;
    }
    let tool_runtime = runtime_tool_path(&root, "runtime")?;
    let tool_runner = tool_runtime.join("local_runner.py");
    let tool_model = tool_model_dir(&root)?;
    let cache = tool_runtime.join("cache");
    let mut command = tokio::process::Command::new(&python);
    command.arg("-u").arg(&tool_runner).arg("--serve").arg("--model-dir").arg(&tool_model).arg("--device").arg(device);
    configure_process_environment(command.as_std_mut(), &root, ProcessEnvironment::Worker)?;
    command
        .env("HF_HOME", cache.join("huggingface"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.as_std_mut().creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(|error| {
        append_bounded_log(
            &root,
            &command_log(&root),
            &format!("[process] action=spawn-failed; stage=Python OCR worker; parent_pid={}; executable={} ; error={error}\n", std::process::id(), python.display()),
        );
        format!("启动本地模型工作进程失败：{error}")
    })?;
    let pid = child.id().ok_or("无法读取本地模型工作进程 ID。")?;
    register_managed_process(pid);
    record_process_event(&root, "Python OCR worker", "started", pid, &python);
    let stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            stop_process_tree(pid);
            let _ = child.kill().await;
            unregister_managed_process(pid);
            return Err(worker_error(&root, "无法连接本地模型输入流"));
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            stop_process_tree(pid);
            let _ = child.kill().await;
            unregister_managed_process(pid);
            return Err(worker_error(&root, "无法连接本地模型输出流"));
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            stop_process_tree(pid);
            let _ = child.kill().await;
            unregister_managed_process(pid);
            return Err(worker_error(&root, "无法收集本地模型诊断"));
        }
    };
    let stderr_path = worker_log(&root);
    let stderr_root = root.clone();
    let stderr_task = tokio::spawn(async move {
        let mut stderr = stderr;
        let mut buffer = [0_u8; 4096];
        let mut recent = Vec::new();
        loop {
            let count = match stderr.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(count) => count,
            };
            recent.extend_from_slice(&buffer[..count]);
            if recent.len() > MAX_DIAGNOSTIC_LOG as usize {
                let excess = recent.len() - MAX_DIAGNOSTIC_LOG as usize;
                recent.drain(..excess);
            }
            let text = sanitize_diagnostic(&stderr_root, &String::from_utf8_lossy(&recent));
            if let Some(parent) = stderr_path.parent() { let _ = async_fs::create_dir_all(parent).await; }
            let _ = async_fs::write(&stderr_path, text).await;
        }
    });
    let mut reader = BufReader::new(stdout);
    let mut ready_line = String::new();
    let read_result = tokio::time::timeout(Duration::from_secs(120), reader.read_line(&mut ready_line)).await;
    let read_count = match read_result {
        Ok(Ok(count)) => count,
        Ok(Err(error)) => {
            stop_process_tree(pid);
            let _ = child.kill().await;
            unregister_managed_process(pid);
            let _ = tokio::time::timeout(Duration::from_secs(1), stderr_task).await;
            return Err(worker_error(&root, &format!("读取本地模型启动状态失败：{error}")));
        }
        Err(_) => {
            stop_process_tree(pid);
            let _ = child.kill().await;
            unregister_managed_process(pid);
            let _ = tokio::time::timeout(Duration::from_secs(1), stderr_task).await;
            return Err(worker_error(&root, "本地模型加载超过 120 秒，进程已终止。请检查内存或切换到 CPU"));
        }
    };
    if read_count == 0 {
        unregister_managed_process(pid);
        let _ = tokio::time::timeout(Duration::from_secs(1), stderr_task).await;
        return Err(worker_error(&root, "本地模型进程意外退出；请检查 Python/ONNX Runtime 安装"));
    }
    let response: Value = match serde_json::from_str(&ready_line) {
        Ok(response) => response,
        Err(_) => {
            stop_process_tree(pid);
            let _ = child.kill().await;
            unregister_managed_process(pid);
            let _ = tokio::time::timeout(Duration::from_secs(1), stderr_task).await;
            return Err(worker_error(&root, "本地模型返回了无效的启动状态"));
        }
    };
    if let Some(error) = response.get("error").and_then(Value::as_str) {
        stop_process_tree(pid);
        let _ = child.kill().await;
        unregister_managed_process(pid);
        let _ = tokio::time::timeout(Duration::from_secs(1), stderr_task).await;
        return Err(worker_error(&root, &format!("本地模型加载失败：{error}")));
    }
    if response.get("ready") != Some(&Value::Bool(true)) {
        stop_process_tree(pid);
        let _ = child.kill().await;
        unregister_managed_process(pid);
        let _ = tokio::time::timeout(Duration::from_secs(1), stderr_task).await;
        return Err(worker_error(&root, "本地模型没有进入就绪状态"));
    }
    let backend = match response.get("backend").and_then(Value::as_str) {
        Some(backend) => backend.to_owned(),
        None => {
            stop_process_tree(pid);
            let _ = child.kill().await;
            unregister_managed_process(pid);
            let _ = tokio::time::timeout(Duration::from_secs(1), stderr_task).await;
            return Err(worker_error(&root, "运行时没有报告实际推理后端"));
        }
    };
    if let Err(error) = fs::write(selected_device_file(&root), device) {
        stop_process_tree(pid);
        let _ = child.kill().await;
        unregister_managed_process(pid);
        let _ = tokio::time::timeout(Duration::from_secs(1), stderr_task).await;
        return Err(format!("保存设备设置失败：{error}"));
    }
    Ok(PythonWorker {
        child,
        pid,
        diagnostic_root: root.clone(),
        executable: python,
        stdin: BufWriter::new(stdin),
        stdout: reader,
        backend,
        _stderr_task: stderr_task,
    })
}
async fn smoke_test_worker(worker: &mut PythonWorker) -> Result<LocalRecognitionResult, String> {
    const SMOKE_TEST_PNG: &[u8] = include_bytes!("../../../test-data/gaussian-integral.png");
    let payload = json!({"imageBase64": STANDARD.encode(SMOKE_TEST_PNG)});
    let mut line = serde_json::to_vec(&payload).map_err(|_| "无法序列化本地公式自检请求。")?;
    line.push(b'\n');
    worker.stdin.write_all(&line).await.map_err(|_| "无法向本地模型发送公式自检图片。")?;
    worker.stdin.flush().await.map_err(|_| "刷新公式自检请求失败。")?;
    let mut response_line = String::new();
    let read = tokio::time::timeout(Duration::from_secs(120), worker.stdout.read_line(&mut response_line))
        .await.map_err(|_| "本地公式自检超过 120 秒。")?
        .map_err(|_| "读取本地公式自检结果失败。")?;
    if read == 0 { return Err("本地模型在公式自检期间退出。".into()); }
    let reply: LocalReply = serde_json::from_str(&response_line).map_err(|_| "本地模型返回了无效的公式自检结果。")?;
    if let Some(error) = reply.error { return Err(format!("真实公式图片自检失败：{error}")); }
    let latex = reply.latex.unwrap_or_default();
    let normalized = latex.chars().filter(|character| !character.is_whitespace()).collect::<String>().to_lowercase();
    if !normalized.contains("int") || !normalized.contains("sqrt") || !normalized.contains("pi") {
        return Err("公式图片自检未识别出预期的高斯积分及其根号/π结果。".into());
    }
    Ok(LocalRecognitionResult {
        latex,
        backend: reply.backend.unwrap_or_else(|| worker.backend.clone()),
        elapsed_ms: reply.elapsed_ms.unwrap_or(0),
    })
}

#[tauri::command]
pub async fn rebuild_local_environment(app: AppHandle, state: State<'_, AppState>, task_id: String) -> Result<String, String> {
    let _guard = state.setup_lock.lock().await;
    let root = app_root(&app)?;
    begin_setup_task(Some(&task_id));
    *state.local_worker.lock().await = None;
    let device_value = fs::read_to_string(selected_device_file(&root)).unwrap_or_else(|_| "cpu".into());
    let device = match device_value.trim() { "cuda" => "cuda", "cpu" => "cpu", _ => return Err("保存的推理设备无效；请重试本地环境配置。".into()) };
    restore_interrupted_rebuild(&root, device)?;
    let environment = environment_dir(&root, device);
    let owner = owned_environment_marker(&root, device);
    if !environment.is_dir() || !owner.is_file() {
        return Err("当前环境没有 FormulaSnap 所有权标记，无法安全重建；请使用本地识别卡片中的重试操作。".into());
    }
    if !miniforge_python(&root)?.is_file() {
        return Err("应用内固定版本 Miniforge 不完整，暂不能安全重建隔离环境；请先重试本地识别配置。".into());
    }
    verify_model_directory(&model_dir(&root))?;
    let backup = rebuild_backup_directory(&root, device);
    if backup.exists() || rebuild_backup_marker(&root, device).exists() {
        return Err("检测到尚未完成的环境回滚记录；已尝试恢复，请刷新状态后重试。".into());
    }
    copy_state_snapshot(&root, device, &backup)?;
    let backup_environment = backup.join("environment");
    let backup_environment_marker = rebuild_environment_marker(&root, device);
    if let Err(error) = fs::rename(&environment, &backup_environment) {
        let _ = cleanup_rebuild_backup(&root, device);
        return Err(format!("备份当前隔离环境失败，原环境仍保留：{error}"));
    }
    if let Err(error) = fs::rename(&owner, &backup_environment_marker) {
        let _ = fs::rename(&backup_environment, &environment);
        let _ = cleanup_rebuild_backup(&root, device);
        return Err(format!("备份环境所有权标记失败，原环境已恢复：{error}"));
    }
    let prior_manifest = runtime_dir(&root).join("runtime-manifest.json");
    if prior_manifest.exists() {
        if let Err(error) = fs::remove_file(&prior_manifest) {
            let _ = fs::rename(&backup_environment, &environment);
            let _ = fs::rename(&backup_environment_marker, &owner);
            let _ = restore_state_snapshot(&root, &backup);
            let _ = cleanup_rebuild_backup(&root, device);
            return Err(format!("准备重建环境清单失败，原环境已恢复：{error}"));
        }
    }
    emit_setup(&app, "rebuild", "已安全备份当前环境，正在重建隔离 Python 和推理依赖…", None);
    let result: Result<(String, PythonWorker), String> = async {
        let install_app = app.clone();
        let install_root = root.clone();
        let install_device = device.to_owned();
        tokio::task::spawn_blocking(move || install_runtime_blocking(install_app, install_root, install_device))
            .await.map_err(|error| format!("重建隔离环境任务异常：{error}"))??;
        emit_setup(&app, "self-test", "依赖已安装，正在加载模型并执行真实公式图片自检…", None);
        let mut worker = spawn_worker(&app, device).await?;
        let smoke = smoke_test_worker(&mut worker).await?;
        let expected = if device == "cuda" { "CUDAExecutionProvider" } else { "CPUExecutionProvider" };
        if smoke.backend != expected {
            return Err(format!("重建自检实际使用了 {}，与所选的 {} 不符。", smoke.backend, expected));
        }
        let runtime_version = format!("{MINIFORGE_TAG} / conda {MINIFORGE_CONDA_VERSION}");
        let manifest = json!({
            "miniforge": runtime_version,
            "rapidLatexOcr": "0.0.9",
            "onnxRuntime": "1.23.2",
            "backend": smoke.backend,
            "smokeTest": "test-data/gaussian-integral.png",
            "rebuild": true
        });
        write_runtime_manifest(&root, &manifest)?;
        Ok((smoke.backend, worker))
    }.await;
    match result {
        Ok((backend, worker)) => {
            *state.local_worker.lock().await = Some(worker);
            cleanup_rebuild_backup(&root, device)?;
            clear_runtime_error(&root);
            emit_setup(&app, "ready", "本地隔离环境重建完成，真实公式图片自检已通过。", None);
            Ok(backend)
        }
        Err(error) => {
            *state.local_worker.lock().await = None;
            let rollback = (|| -> Result<(), String> {
                cleanup_environment_if_owned(&root, device)?;
                if backup_environment.is_dir() {
                    if environment.exists() {
                        return Err("新环境无法安全清理；已保留回滚副本和诊断。".into());
                    }
                    fs::rename(&backup_environment, &environment).map_err(|failure| format!("恢复原环境目录失败：{failure}"))?;
                    if backup_environment_marker.is_file() {
                        fs::rename(&backup_environment_marker, &owner).map_err(|failure| format!("恢复原环境所有权标记失败：{failure}"))?;
                    }
                    restore_state_snapshot(&root, &backup)?;
                }
                cleanup_rebuild_backup(&root, device)
            })();
            let message = match rollback {
                Ok(()) => format!("环境重建失败，已恢复原环境：{error}"),
                Err(rollback_error) => format!("环境重建失败：{error}；自动恢复也未完成：{rollback_error}。请保留应用诊断目录。"),
            };
            save_runtime_error(&root, &message);
            emit_setup(&app, "failed", &sanitize_diagnostic(&root, &message), None);
            Err(message)
        }
    }
}

#[tauri::command]
pub async fn setup_local_model(app: AppHandle, state: State<'_, AppState>, task_id: String) -> Result<String, String> {
    let _guard = state.setup_lock.lock().await;
    let root = app_root(&app)?;
    begin_setup_task(Some(&task_id));
    let result = setup_local_model_inner(app.clone(), state.inner(), root.clone()).await;
    match result {
        Ok(backend) => { clear_runtime_error(&root); Ok(backend) }
        Err(error) => {
            save_runtime_error(&root, &error);
            emit_setup(&app, "failed", &sanitize_diagnostic(&root, &error), None);
            Err(error)
        }
    }
}

async fn setup_local_model_inner(app: AppHandle, state: &AppState, root: PathBuf) -> Result<String, String> {
    *state.local_worker.lock().await = None;
    emit_setup(&app, "detect", "正在检查 NVIDIA 驱动和可用推理设备…", Some(1));
    let candidate_gpu = if cfg!(windows) {
        tokio::task::spawn_blocking(nvidia_driver_summary).await
            .map_err(|error| format!("显卡检测任务异常：{error}"))?
    } else {
        None
    };
    if let Some(summary) = &candidate_gpu {
        emit_setup(&app, "detect", &format!("发现 NVIDIA 候选设备：{summary}；将用 CUDA 实际推理验证。"), Some(5));
    } else {
        emit_setup(&app, "detect", "没有可用的 NVIDIA 驱动响应，将配置 CPU 推理。", Some(5));
    }

    let runtime_version = ensure_miniforge(&app, &root).await?;
    let mut cuda_failure: Option<String> = None;
    ensure_model_files(&app, &root).await?;
    let can_use_cuda = candidate_gpu.is_some();
    if can_use_cuda {
        emit_setup(&app, "dependencies", "正在准备 CUDA 12.8 / cuDNN 9 推理环境…", Some(25));
        let stage_app = app.clone();
        let stage_root = root.clone();
        let cuda_install = tokio::task::spawn_blocking(move || install_runtime_blocking(stage_app, stage_root, "cuda".into())).await;
        match cuda_install {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => cuda_failure = Some(error),
            Err(error) => cuda_failure = Some(format!("CUDA 环境配置任务异常：{error}")),
        }
        if cuda_failure.is_none() {
            emit_setup(&app, "self-test", "CUDA 环境已安装；正在加载模型并识别真实公式图片…", Some(88));
            match spawn_worker(&app, "cuda").await {
                Ok(mut worker) => match smoke_test_worker(&mut worker).await {
                    Ok(result) if result.backend == "CUDAExecutionProvider" => {
                        let manifest = json!({
                            "miniforge": runtime_version,
                            "rapidLatexOcr": "0.0.9",
                            "onnxRuntime": "1.23.2",
                            "backend": result.backend,
                            "smokeTest": "test-data/gaussian-integral.png"
                        });
                        write_runtime_manifest(&root, &manifest)?;
                        *state.local_worker.lock().await = Some(worker);
                        emit_setup(&app, "ready", "CUDA 实际推理和真实公式图片自检均已通过。", Some(100));
                        return Ok(result.backend);
                    }
                    Ok(result) => cuda_failure = Some(format!("CUDA 请求实际使用了 {}。", result.backend)),
                    Err(error) => cuda_failure = Some(error),
                },
                Err(error) => cuda_failure = Some(error),
            }
        }
        if let Some(reason) = &cuda_failure {
            emit_setup(&app, "fallback", &format!("CUDA 自检未通过：{reason} 正在清理 GPU 环境并自动配置 CPU。"), Some(24));
        }
        *state.local_worker.lock().await = None;
        cleanup_environment_if_owned(&root, "cuda")
            .map_err(|error| format!("清理 FormulaSnap CUDA 环境失败：{error}"))?;
    } else {
        cleanup_environment_if_owned(&root, "cuda")
            .map_err(|error| format!("清理 FormulaSnap CUDA 环境失败：{error}"))?;
    }
    let stage_app = app.clone();
    let stage_root = root.clone();
    tokio::task::spawn_blocking(move || install_runtime_blocking(stage_app, stage_root, "cpu".into()))
        .await.map_err(|error| format!("CPU 环境配置任务异常：{error}"))??;
    let directory = model_dir(&root);
    if verify_model_directory(&directory).is_err() {
        emit_setup(&app, "model", "正在下载并校验约 171 MiB 的公式识别模型…", Some(55));
        download_local_model_inner(app.clone(), root.to_path_buf()).await?;
    }
    emit_setup(&app, "self-test", "正在加载模型并识别内置高斯积分公式图片…", Some(90));
    let mut worker = spawn_worker(&app, "cpu").await?;
    let result = smoke_test_worker(&mut worker).await?;
    if result.backend != "CPUExecutionProvider" {
        return Err(format!("CPU 回退自检实际使用了 {}。", result.backend));
    }
    let manifest = json!({
        "miniforge": runtime_version,
        "rapidLatexOcr": "0.0.9",
        "onnxRuntime": "1.23.2",
        "backend": result.backend,
        "smokeTest": "test-data/gaussian-integral.png",
        "cudaFallback": cuda_failure
    });
    write_runtime_manifest(&root, &manifest)?;
    *state.local_worker.lock().await = Some(worker);
    let ready_message = if let Some(reason) = cuda_failure {
        format!("CUDA 未通过实际推理验证，已自动回退 CPU；本地公式图片自检通过。原因：{reason}")
    } else {
        "CPU 实际推理和真实公式图片自检均已通过。".into()
    };
    emit_setup(&app, "ready", &ready_message, Some(100));
    Ok(result.backend)
}

#[tauri::command]
pub async fn load_local_model(app: AppHandle, state: State<'_, AppState>, device: String) -> Result<String, String> {
    let _guard = state.setup_lock.lock().await;
    let worker = spawn_worker(&app, &device).await?;
    let backend = worker.backend.clone();
    *state.local_worker.lock().await = Some(worker);
    Ok(backend)
}

#[tauri::command]
pub async fn unload_local_model(state: State<'_, AppState>) -> Result<(), String> {
    let _guard = state.setup_lock.lock().await;
    *state.local_worker.lock().await = None;
    Ok(())
}

#[tauri::command]
pub async fn delete_local_model(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let _guard = state.setup_lock.lock().await;
    *state.local_worker.lock().await = None;
    let root = app_root(&app)?;
    let path = model_dir(&root);
    validate_owned_model_cleanup(&root, &path)?;
    if path.exists() {
        async_fs::remove_dir_all(&path).await.map_err(|e| format!("删除本地模型失败：{e}"))?;
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalReply { latex: Option<String>, elapsed_ms: Option<u64>, backend: Option<String>, error: Option<String> }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRecognitionResult { latex: String, backend: String, elapsed_ms: u64 }

#[tauri::command]
pub async fn recognize_local(state: State<'_, AppState>, task_id: String, image_data_url: String, device: String) -> Result<LocalRecognitionResult, String> {
    let _guard = state.setup_lock.lock().await;
    let token = CancellationToken::new();
    {
        let mut tasks = state.cancellations.lock().map_err(|_| "任务状态不可用。")?;
        tasks.insert(task_id.clone(), token.clone());
    }
    let worker_arc: Arc<tokio::sync::Mutex<Option<PythonWorker>>> = state.local_worker.clone();
    let result = async {
        let mut worker_slot = worker_arc.lock().await;
        let worker = worker_slot.as_mut().ok_or("本地模型尚未加载，请先在设置中加载模型。")?;
        let encoded = image_data_url.split_once(',').map(|(_, data)| data).ok_or("图片数据格式无效。")?;
        let image = STANDARD.decode(encoded).map_err(|_| "图片 Base64 数据无效。")?;
        if image.is_empty() || image.len() > 32 * 1024 * 1024 { return Err("图片为空或超过 32 MiB 限制。".into()); }
        let expected_backend = match device.as_str() { "cpu" => "CPUExecutionProvider", "cuda" => "CUDAExecutionProvider", _ => return Err("未知的推理设备。".into()) };
        if worker.backend != expected_backend { return Err(format!("当前加载的是 {}；选择了 {}。请先卸载模型，再使用所选设备加载。", worker.backend, expected_backend)); }
        let payload = json!({"imageBase64": STANDARD.encode(image)});
        let mut line = serde_json::to_vec(&payload).map_err(|_| "无法序列化本地推理请求。")?;
        line.push(b'\n');
        worker.stdin.write_all(&line).await.map_err(|_| "无法向本地模型进程发送图片。请重新加载模型。")?;
        worker.stdin.flush().await.map_err(|_| "刷新本地模型请求失败。")?;
        let mut response_line = String::new();
        let child = &mut worker.child;
        let stdout = &mut worker.stdout;
        let mut cancelled = false;
        let mut io_result = None;
        tokio::select! {
            _ = token.cancelled() => { cancelled = true; }
            result = stdout.read_line(&mut response_line) => { io_result = Some(result); }
        }
        if cancelled {
            let _ = child.kill().await;
            worker_slot.take();
            return Err("识别已取消；模型工作进程已停止，请重新加载模型后再识别。".into());
        }
        let read = io_result.ok_or("没有收到本地模型响应。")?.map_err(|_| "读取本地模型响应失败。")?;
        if read == 0 { worker_slot.take(); return Err("本地模型进程已退出；请检查模型和运行时。".into()); }
        let reply: LocalReply = serde_json::from_str(&response_line).map_err(|_| "本地模型返回了无效数据。")?;
        if let Some(error) = reply.error { return Err(format!("本地识别失败：{error}")); }
        Ok(LocalRecognitionResult {
            latex: reply.latex.unwrap_or_default(),
            backend: reply.backend.unwrap_or_else(|| worker.backend.clone()),
            elapsed_ms: reply.elapsed_ms.unwrap_or(0),
        })
    }.await;
    if let Ok(mut tasks) = state.cancellations.lock() { tasks.remove(&task_id); }
    result
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_progress_uses_real_bytes_and_smoothed_speed() {
        assert_eq!(download_percent(0, 0), None);
        assert_eq!(download_percent(63, 100), Some(63));
        assert_eq!(download_percent(100, 100), Some(99));
        assert_eq!(remaining_download_ms(2_000, 1_000, Some(1_000.0)), Some(1_000));
        assert_eq!(remaining_download_ms(2_000, 1_000, None), None);
        let speed = smooth_download_speed(Some(1_000.0), 3_000, 2.0).unwrap();
        assert!((speed - 1_140.0).abs() < 0.001);
    }

    #[test]
    fn source_policy_orders_only_verified_endpoints() {
        let mainland_pypi = source_candidates_for("auto", "mainland", DownloadArtifact::Pypi, "", "");
        assert_eq!(mainland_pypi[0].0, "https://mirrors.aliyun.com/pypi/simple/");
        assert_eq!(mainland_pypi[1].0, "https://pypi.tuna.tsinghua.edu.cn/simple/");
        assert_eq!(mainland_pypi.len(), 2);

        let mainland_conda = source_candidates_for("auto", "mainland", DownloadArtifact::Conda, "", "");
        assert_eq!(mainland_conda[0].0, "https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge/");
        assert_eq!(mainland_conda[1].0, "conda-forge");

        let unknown = source_candidates_for("auto", "unknown", DownloadArtifact::Pypi, "", "");
        assert_eq!(unknown[0].0, "https://pypi.org/simple/");
        let custom = source_candidates_for("custom", "mainland", DownloadArtifact::Pypi, "https://packages.example/simple/", "");
        assert_eq!(custom[0].0, "https://packages.example/simple/");
        assert_eq!(custom[1].0, "https://pypi.org/simple/");
    }

    #[test]
    fn custom_sources_require_https_without_embedded_credentials() {
        assert!(validate_https_endpoint("https://mirror.example/simple/", "mirror").is_ok());
        assert!(validate_https_endpoint("", "mirror").is_ok());
        assert!(validate_https_endpoint("http://mirror.example/simple/", "mirror").is_err());
        assert!(validate_https_endpoint("https://user:secret@mirror.example/simple/", "mirror").is_err());
    }

    #[test]
    fn runtime_manifest_health_requires_python_provider_and_successful_smoke_record() {
        use std::time::{SystemTime, UNIX_EPOCH};
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let root = workspace.join(".toolchain/tmp").join(format!("manifest-test-{unique}"));
        fs::create_dir_all(environment_dir(&root, "cpu")).unwrap();
        fs::write(python_in(&environment_dir(&root, "cpu")), b"test").unwrap();
        atomic_write(&providers_file(&root), br#"["CPUExecutionProvider"]"#).unwrap();
        atomic_write(&selected_device_file(&root), b"cpu").unwrap();
        let manifest = json!({
            "miniforge": format!("{MINIFORGE_TAG} / conda {MINIFORGE_CONDA_VERSION}"),
            "rapidLatexOcr": "0.0.9",
            "onnxRuntime": "1.23.2",
            "backend": "CPUExecutionProvider",
            "smokeTest": "test-data/gaussian-integral.png"
        });
        write_runtime_manifest(&root, &manifest).unwrap();
        assert!(runtime_manifest_compatible(&root));
        let broken = json!({"rapidLatexOcr":"0.0.9"});
        write_runtime_manifest(&root, &broken).unwrap();
        assert!(!runtime_manifest_compatible(&root));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn runtime_root_prefers_override_legacy_then_install_data() {
        let profile = PathBuf::from(r"E:\FormulaSnap\.runtime\profile");
        let executable = PathBuf::from(r"E:\Apps\FormulaSnap");
        let settings = LocalSettings::default();
        assert_eq!(resolve_runtime_root(&profile, &settings, Some(&executable), false).unwrap(), executable.join("FormulaSnapData"));
        assert_eq!(resolve_runtime_root(&profile, &settings, Some(&executable), true).unwrap(), profile);
        assert_eq!(resolve_runtime_root(&profile, &settings, None, false).unwrap(), profile);
        let selected = LocalSettings { storage_directory: r"E:\Models".into(), ..LocalSettings::default() };
        assert_eq!(resolve_runtime_root(&profile, &selected, Some(&executable), false).unwrap(), PathBuf::from(r"E:\Models\FormulaSnap"));
    }

    #[test]
    fn runtime_directories_are_scoped_by_device() {
        let root = PathBuf::from(r"E:\FormulaSnap\.runtime\test");
        assert_eq!(environment_dir(&root, "cpu"), root.join("runtime/environments/cpu"));
        assert_eq!(environment_dir(&root, "cuda"), root.join("runtime/environments/cuda"));
        assert_eq!(miniforge_dir(&root), root.join("runtime/miniforge-26.7.2-0"));
        assert_eq!(model_dir(&root), root.join("models/rapid-latex-ocr-v0.0.0"));
    }

    #[test]
    fn bundled_model_manifest_has_unique_file_names_and_positive_sizes() {
        let mut names = std::collections::HashSet::new();
        for (name, size, hash) in MODEL_FILES {
            assert!(names.insert(name));
            assert!(size > 0);
            assert_eq!(hash.len(), 64);
        }
    }

    #[test]
    fn model_cleanup_requires_the_exact_app_owned_directory() {
        use std::time::{SystemTime, UNIX_EPOCH};
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let root = workspace.join(".toolchain/tmp").join(format!("model-owner-test-{unique}"));
        let model_path = model_dir(&root);
        fs::create_dir_all(&model_path).unwrap();
        fs::write(model_path.join("user-model.txt"), "preserve").unwrap();

        assert!(validate_owned_model_cleanup(&root, &model_path).is_err());
        assert!(mark_model_owned(&root).is_err());

        fs::remove_file(model_path.join("user-model.txt")).unwrap();
        assert!(mark_model_owned(&root).is_ok());
        assert!(validate_owned_model_cleanup(&root, &model_path).is_ok());
        assert!(validate_owned_model_cleanup(&root, &root.join("other-model")).is_err());

        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn extended_ascii_workspace_path_does_not_require_a_runtime_alias() {
        assert!(!runtime_path_needs_alias(Path::new(
            r"\\?\E:\FormulaSnap\.runtime\workspace-launcher"
        )));
    }

    #[test]
    fn windows_path_comparison_normalizes_extended_prefix_case_and_trailing_slash() {
        assert_eq!(
            normalize_windows_path_for_comparison(
                r"\\?\E:\FormulaSnap\.runtime\workspace-launcher\"
            ),
            normalize_windows_path_for_comparison(
                r"e:\formulasnap\.runtime\workspace-launcher"
            )
        );
        assert_eq!(
            normalize_windows_path_for_comparison(r"\\?\UNC\server\share\folder\"),
            normalize_windows_path_for_comparison(r"\\server\share\folder")
        );
    }
    #[test]
    fn runtime_path_aliases_cover_spaces_unicode_and_long_paths() {
        assert!(runtime_path_needs_alias(Path::new(r"E:\FormulaSnap Data")));
        assert!(runtime_path_needs_alias(Path::new(r"E:\公式识别\FormulaSnap")));
        assert!(runtime_path_needs_alias(Path::new(&format!(r"E:\{}", "a".repeat(170)))));
        assert!(!runtime_path_needs_alias(Path::new(r"E:\FormulaSnap\.runtime\desktop")));
    }

    #[test]
    fn installer_profile_removes_conda_no_plugins_but_conda_profile_sets_it() {
        use std::ffi::OsStr;
        use std::time::{SystemTime, UNIX_EPOCH};
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let root = workspace.join(".toolchain/tmp").join(format!("profile-test-{unique}"));
        fs::create_dir_all(&root).unwrap();

        let mut installer = Command::new("unused-test-command");
        installer.env("CONDA_NO_PLUGINS", "true");
        configure_process_environment(&mut installer, &root, ProcessEnvironment::Installer).unwrap();
        assert!(installer.get_envs().any(|(key, value)| key == OsStr::new("CONDA_NO_PLUGINS") && value.is_none()));

        let mut conda = Command::new("unused-test-command");
        configure_process_environment(&mut conda, &root, ProcessEnvironment::Conda).unwrap();
        assert!(conda.get_envs().any(|(key, value)| key == OsStr::new("CONDA_NO_PLUGINS") && value == Some(OsStr::new("true"))));

        let mut pip = Command::new("unused-test-command");
        configure_process_environment(&mut pip, &root, ProcessEnvironment::Pip).unwrap();
        assert!(pip.get_envs().any(|(key, value)| key == OsStr::new("CONDA_NO_PLUGINS") && value.is_none()));

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn miniforge_is_pinned_and_silent_destination_is_last() {
        assert_eq!(MINIFORGE_TAG, "26.7.2-0");
        assert_eq!(MINIFORGE_ASSET, "Miniforge3-26.7.2-0-Windows-x86_64.exe");
        assert_eq!(MINIFORGE_SIZE, 148_256_480);
        assert_eq!(MINIFORGE_SHA256.len(), 64);
        let prefix = Path::new(r"Q:\Formula Snap\含中文\runtime\miniforge");
        let args = miniforge_installer_args(prefix);
        assert!(args.iter().any(|arg| arg == "/S"));
        assert!(args.iter().any(|arg| arg == "/Q"));
        let first_value_argument = args.iter().position(|arg| arg.starts_with("/InstallationType=")).unwrap();
        let silent_argument = args.iter().position(|arg| arg == "/S").unwrap();
        let quiet_argument = args.iter().position(|arg| arg == "/Q").unwrap();
        assert!(silent_argument < first_value_argument);
        assert!(quiet_argument < first_value_argument);
        assert_eq!(args.last().unwrap(), &format!("/D={}", prefix.display()));
    }

    #[test]
    fn diagnostics_redact_secrets_and_workspace_paths() {
        let root = PathBuf::from(r"E:\FormulaSnap");
        let safe = sanitize_diagnostic(&root, r"token sk-abc123 at E:\FormulaSnap\runtime");
        assert!(safe.contains("sk-[REDACTED]"));
        assert!(safe.contains("<app-data>"));
        assert!(!safe.contains("abc123"));
    }

}
