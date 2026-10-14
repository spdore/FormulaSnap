param([string]$DataDirectory)
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$rootFull = [IO.Path]::GetFullPath($root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
$env:TEMP = Join-Path $root '.toolchain\tmp'
$env:TMP = $env:TEMP
$env:CARGO_HOME = Join-Path $root '.toolchain\cargo'
$env:RUSTUP_HOME = Join-Path $root '.toolchain\rustup'
$env:npm_config_cache = Join-Path $root '.toolchain\npm-cache'
$env:PIP_CACHE_DIR = Join-Path $root '.toolchain\pip-cache'
if ([string]::IsNullOrWhiteSpace($DataDirectory)) {
    $dataRoot = Join-Path $root '.runtime\workspace-launcher'
} elseif ([IO.Path]::IsPathRooted($DataDirectory)) {
    $dataRoot = [IO.Path]::GetFullPath($DataDirectory)
} else {
    $dataRoot = [IO.Path]::GetFullPath((Join-Path $root $DataDirectory))
}
$dataRoot = [IO.Path]::GetFullPath($dataRoot)
$rootPrefix = $rootFull + [IO.Path]::DirectorySeparatorChar
if (-not $dataRoot.Equals($rootFull, [StringComparison]::OrdinalIgnoreCase) -and
    -not $dataRoot.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'FormulaSnap 数据目录必须位于仓库工作区内。'
}
$env:FORMULASNAP_DATA_DIR = $dataRoot
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $env:FORMULASNAP_DATA_DIR 'webview'


$releasePointer = Join-Path $root '.toolchain\active-release.txt'
if (Test-Path -LiteralPath $releasePointer) {
    $relativeRelease = (Get-Content -LiteralPath $releasePointer -Raw).Trim()
    if ([string]::IsNullOrWhiteSpace($relativeRelease) -or [IO.Path]::IsPathRooted($relativeRelease) -or $relativeRelease.Split([char[]]@('\','/')) -contains '..') {
        throw '当前 release 路径必须是工作区内的相对路径。'
    }
    $exe = [IO.Path]::GetFullPath((Join-Path $root $relativeRelease))
    if (-not $exe.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw '当前 release 路径越出工作区。' }
} else {
    $exe = Join-Path $root 'frontend\src-tauri\target\release\formulasnap.exe'
}
if (-not (Test-Path -LiteralPath $exe)) {
    throw "找不到 FormulaSnap 程序：$exe`n请先完成 Windows 构建。"
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class FormulaSnapLauncherWindow {
    private delegate bool EnumWindowsCallback(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int command);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    public static IntPtr FindTauriWindow(uint targetProcessId) {
        IntPtr result = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            uint processId;
            GetWindowThreadProcessId(hWnd, out processId);
            if (processId == targetProcessId) {
                var className = new StringBuilder(128);
                GetClassName(hWnd, className, className.Capacity);
                if (className.ToString() == "Tauri Window") {
                    result = hWnd;
                    return false;
                }
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
'@

$process = $null
$window = [IntPtr]::Zero
$running = Get-Process -Name 'formulasnap' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and [IO.Path]::GetFullPath($_.Path).Equals($exe, [StringComparison]::OrdinalIgnoreCase) } |
    Sort-Object StartTime -Descending

foreach ($candidate in $running) {
    $candidateWindow = [FormulaSnapLauncherWindow]::FindTauriWindow([uint32]$candidate.Id)
    if ($candidateWindow -ne [IntPtr]::Zero) {
        $process = $candidate
        $window = $candidateWindow
        break
    }
}

if ($window -ne [IntPtr]::Zero -and -not [string]::IsNullOrWhiteSpace($DataDirectory)) {
    throw 'FormulaSnap 已经在运行，启动器无法切换现有进程的数据目录。请先退出当前应用，再使用指定的验收目录启动。'
}

if ($window -eq [IntPtr]::Zero) {
    New-Item -ItemType Directory -Force -Path $env:FORMULASNAP_DATA_DIR | Out-Null
    $process = Start-Process -FilePath $exe -WorkingDirectory $root -PassThru
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        Start-Sleep -Milliseconds 500
        $process.Refresh()
        if ($process.HasExited) {
            throw "FormulaSnap 启动后立即退出，退出码：$($process.ExitCode)"
        }
        $window = [FormulaSnapLauncherWindow]::FindTauriWindow([uint32]$process.Id)
        if ($window -ne [IntPtr]::Zero) { break }
    }
}

if ($window -eq [IntPtr]::Zero) {
    throw 'FormulaSnap 进程已启动，但 30 秒内没有找到主窗口。'
}

$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$width = [Math]::Min(1440, $area.Width)
$height = [Math]::Min(940, $area.Height)
$x = $area.Left + [Math]::Max(0, [int](($area.Width - $width) / 2))
$y = $area.Top + [Math]::Max(0, [int](($area.Height - $height) / 2))

[void][FormulaSnapLauncherWindow]::ShowWindow($window, 9)
[void][FormulaSnapLauncherWindow]::SetWindowPos($window, [IntPtr]::Zero, $x, $y, $width, $height, 0x0040)
[void][FormulaSnapLauncherWindow]::SetForegroundWindow($window)
$windowShell = New-Object -ComObject WScript.Shell
[void]$windowShell.AppActivate([int]$process.Id)
Start-Sleep -Milliseconds 300

if (-not [FormulaSnapLauncherWindow]::IsWindowVisible($window)) {
    throw 'FormulaSnap 已启动，但窗口没有显示出来。'
}
