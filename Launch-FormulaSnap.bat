@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Launch-FormulaSnap.ps1"
if errorlevel 1 (
    echo FormulaSnap launcher failed. See the error above.
    pause
)
