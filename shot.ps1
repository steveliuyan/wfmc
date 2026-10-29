# 用文件里的 JS 做一次页面自检截图： .\shot.ps1 <输出png> <页面> <js文件> [延迟ms]
param(
  [string]$Out = "H:\mcqidongqi\.tmp-shot\shot.png",
  [string]$Page = "resources",
  [string]$JsFile = "",
  [int]$Delay = 8000
)
Set-Location H:\mcqidongqi
New-Item -ItemType Directory -Force .tmp-shot | Out-Null
Get-Process | Where-Object { $_.ProcessName -match 'electron|WFMC' } | Stop-Process -Force -ErrorAction SilentlyContinue
$env:WFMC_SHOT = $Out
$env:WFMC_SHOT_PAGE = $Page
$env:WFMC_SHOT_DELAY = "$Delay"
if ($JsFile -and (Test-Path $JsFile)) {
  $env:WFMC_SHOT_JS = [System.IO.File]::ReadAllText((Resolve-Path $JsFile))
} else {
  $env:WFMC_SHOT_JS = ""
}
$p = Start-Process -FilePath ".\node_modules\electron\dist\electron.exe" -ArgumentList "." -PassThru
Start-Sleep -Seconds ([Math]::Ceiling(($Delay + 45000) / 1000))
Get-Process | Where-Object { $_.ProcessName -match 'electron|WFMC' } | Stop-Process -Force -ErrorAction SilentlyContinue
if (Test-Path $Out) { "SHOT OK -> $Out" } else { "SHOT MISSING" }
