#![cfg_attr(windows, windows_subsystem = "windows")]

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

fn workspace_root() -> Result<PathBuf, String> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| "无法从启动器位置找到工作区目录。".to_string())?;
    fs::canonicalize(path).map_err(|error| format!("无法解析工作区目录：{error}"))
}

fn resolve_data_directory(root: &Path, requested: Option<PathBuf>) -> Result<PathBuf, String> {
    let relative = requested.unwrap_or_else(|| PathBuf::from(".runtime/workspace-launcher"));
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_))
        })
    {
        return Err("数据目录必须是工作区内的相对路径。".to_string());
    }
    let data = root.join(relative);
    if !data.starts_with(root) {
        return Err("FormulaSnap 数据目录必须位于仓库工作区内。".to_string());
    }
    Ok(data)
}

fn parse_release_relative(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value.trim());
    if path.as_os_str().is_empty() || path.is_absolute()
        || path.components().any(|component| matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
    {
        return Err("当前 release 路径必须是工作区内的相对路径。".into());
    }
    Ok(path)
}

fn release_executable(root: &Path) -> Result<PathBuf, String> {
    let pointer = root.join(".toolchain").join("active-release.txt");
    validate_workspace_path(root, &pointer)?;
    let relative = if pointer.is_file() {
        let text = fs::read_to_string(&pointer).map_err(|error| format!("读取当前 release 位置失败：{error}"))?;
        parse_release_relative(&text)?
    } else {
        PathBuf::from("frontend/src-tauri/target/release/formulasnap.exe")
    };
    let executable = root.join(relative);
    validate_workspace_path(root, &executable)?;
    Ok(executable)
}

fn validate_workspace_path(root: &Path, path: &Path) -> Result<(), String> {
    if !path.starts_with(root) {
        return Err(format!("拒绝工作区外路径：{}", path.display()));
    }
    let mut current = root.to_path_buf();
    let relative = path.strip_prefix(root).map_err(|_| "路径不在工作区内。".to_string())?;
    for component in relative.components() {
        if let Component::Normal(part) = component {
            current.push(part);
            if current.exists() {
                let resolved = fs::canonicalize(&current)
                    .map_err(|error| format!("无法验证工作区路径 {}：{error}", current.display()))?;
                if !resolved.starts_with(root) {
                    return Err(format!("拒绝指向工作区外的路径：{}", current.display()));
                }
                current = resolved;
            }
        }
    }
    Ok(())
}

fn append_log(root: &Path, message: &str) {
    let log_path = root.join(".runtime").join("workspace-launcher").join("launcher.log");
    if validate_workspace_path(root, &log_path).is_err() {
        return;
    }
    if let Some(parent) = log_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut log) = OpenOptions::new().create(true).append(true).open(log_path) {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or_default();
        let _ = writeln!(log, "{timestamp} {message}");
    }
}

fn run() -> Result<(), String> {
    let root = workspace_root()?;
    let mut arguments = std::env::args_os().skip(1);
    let requested_data = arguments.next().map(PathBuf::from);
    if arguments.next().is_some() {
        return Err("工作区启动器只接受一个可选的数据目录相对路径。".to_string());
    }
    let data = resolve_data_directory(&root, requested_data)?;
    let webview = data.join("webview");
    let toolchain = root.join(".toolchain");
    let temp = toolchain.join("tmp");
    let cargo = toolchain.join("cargo");
    let rustup = toolchain.join("rustup");
    let npm_cache = toolchain.join("npm-cache");
    let pip_cache = toolchain.join("pip-cache");

    for directory in [&data, &webview, &temp, &cargo, &rustup, &npm_cache, &pip_cache] {
        validate_workspace_path(&root, directory)?;
        fs::create_dir_all(directory)
            .map_err(|error| format!("无法准备工作区目录 {}：{error}", directory.display()))?;
    }

    let executable = release_executable(&root)?;
    if !executable.is_file() {
        return Err(format!("找不到 release GUI 程序：{}。请先构建 FormulaSnap。", executable.display()));
    }

    let child = Command::new(&executable)
        .current_dir(&root)
        .env("TEMP", &temp)
        .env("TMP", &temp)
        .env("CARGO_HOME", &cargo)
        .env("RUSTUP_HOME", &rustup)
        .env("npm_config_cache", &npm_cache)
        .env("PIP_CACHE_DIR", &pip_cache)
        .env("FORMULASNAP_DATA_DIR", &data)
        .env("WEBVIEW2_USER_DATA_FOLDER", &webview)
        .spawn()
        .map_err(|error| format!("启动 FormulaSnap GUI 失败：{error}"))?;

    append_log(
        &root,
        &format!(
            "action=started parent_pid={} child_pid={} data_directory={} executable={}",
            std::process::id(),
            child.id(),
            data.display(),
            executable.display()
        ),
    );
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        if let Ok(root) = workspace_root() {
            append_log(&root, &format!("action=failed error={error}"));
        }
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> PathBuf {
        fs::canonicalize(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .and_then(Path::parent)
                .unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn release_executable_pointer_is_workspace_relative() {
        let root = workspace();
        let relative = parse_release_relative(r".toolchain\cargo-target-0.1.3\release\formulasnap.exe").unwrap();
        let path = root.join(&relative);
        assert!(validate_workspace_path(&root, &path).is_ok());
        assert!(parse_release_relative(r"..\outside\formulasnap.exe").is_err());
        assert!(parse_release_relative(r"C:\outside\formulasnap.exe").is_err());
    }

    #[test]
    fn workspace_data_directory_stays_inside_repository() {
        let root = workspace();
        assert_eq!(
            resolve_data_directory(&root, None).unwrap(),
            root.join(".runtime/workspace-launcher")
        );
        let unicode = resolve_data_directory(&root, Some(PathBuf::from(".runtime/验收 数据"))).unwrap();
        assert!(unicode.starts_with(&root));
        assert!(resolve_data_directory(&root, Some(PathBuf::from("../outside"))).is_err());
        assert!(resolve_data_directory(&root, Some(PathBuf::from(r"C:\outside"))).is_err());
    }
}