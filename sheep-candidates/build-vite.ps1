$ErrorActionPreference = 'Continue'
$base = "C:\Users\YHSome\Projects\OtherProjects\ZhuaNaiWa\sheep-candidates"
$env:npm_config_registry = 'https://registry.npmmirror.com'
$env:npm_config_audit = 'false'
$env:npm_config_fund = 'false'
$env:npm_config_loglevel = 'error'

function Build-Vite($dir, $label) {
  "================ $label ================"
  if (-not (Test-Path $dir)) { "跳过：目录不存在 $dir"; return }
  Push-Location $dir
  "--- npm install（镜像） ---"
  npm install --no-package-lock 2>&1 | ForEach-Object { $_ }
  "--- 安装结果：node_modules 存在 = $(Test-Path (Join-Path $dir 'node_modules')) ---"
  "--- vite build --base=./ ---"
  npx vite build --base=./ 2>&1 | ForEach-Object { $_ }
  if (-not (Test-Path (Join-Path $dir 'dist\index.html'))) {
    "--- 回退 vite@4 ---"
    npx -y vite@4 build --base=./ 2>&1 | ForEach-Object { $_ }
  }
  if (Test-Path (Join-Path $dir 'dist\index.html')) {
    $sum = (Get-ChildItem -Recurse (Join-Path $dir 'dist') -File | Measure-Object -Property Length -Sum).Sum
    "RESULT[$label]: BUILD OK, dist = $([math]::Round($sum/1MB,2)) MB"
  } else {
    "RESULT[$label]: BUILD FAILED"
  }
  Pop-Location
}

Build-Vite (Join-Path $base 'yulegeyu\yulegeyu-master') 'yulegeyu'
Build-Vite (Join-Path $base 'solvable-sheep\solvable-sheep-game-master') 'solvable-sheep'
'ALL DONE'
