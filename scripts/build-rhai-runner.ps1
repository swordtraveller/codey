$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repoRoot 'native\rhai-runner\Cargo.toml'
$targetDir = Join-Path $repoRoot 'native\rhai-runner\target'
$sourcePath = Join-Path $repoRoot 'native\rhai-runner\target\release\codey-rhai-runner.exe'
$destinationPath = Join-Path $repoRoot 'native\rhai-runner.exe'
$smokeScript = Join-Path $repoRoot 'scripts\smoke-rhai-runner.mjs'

Push-Location $repoRoot
try {
  & cargo build --release --locked --manifest-path $manifestPath --target-dir $targetDir
  if ($LASTEXITCODE -ne 0) {
    throw "cargo build failed with exit code $LASTEXITCODE"
  }

  if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw "Rust build output was not found: $sourcePath"
  }

  Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force

  & node $smokeScript $destinationPath
  if ($LASTEXITCODE -ne 0) {
    throw "Rhai runner smoke test failed with exit code $LASTEXITCODE"
  }

  Write-Host "Built and verified $destinationPath"
} finally {
  Pop-Location
}
