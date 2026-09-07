# orca-local.ps1 - Orca launcher for this project
#
# What it does:
#   - Locates the .orca-tools\bin directory and prepends it to PATH (process-scope only).
#   - Delegates to `deno task orca` (interactive orchestrator loop).
#
# Usage:
#   .\scripts\orca-local.ps1                    # interactive loop
#   .\scripts\orca-local.ps1 --plan             # pass args to orca
#
# IMPORTANT: This script does NOT modify the global system PATH.
# It only adjusts $env:PATH for this PowerShell process and its children.

param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)

$projectRoot = Split-Path -Parent $PSScriptRoot
$localBin = Join-Path $projectRoot ".orca-tools\bin"

# Prepend local bin to PATH for this process only (never persist)
if (Test-Path $localBin) {
    $env:PATH = "$localBin;$env:PATH"
}

Write-Host "=== Orca (local) ==="
Write-Host "Project: $projectRoot"
Write-Host "Local bin: $localBin"
Write-Host ""

# Forward arguments to deno task orca
if ($Args.Count -gt 0) {
    $joinedArgs = $Args -join " "
    deno task orca -- $joinedArgs
} else {
    deno task orca
}