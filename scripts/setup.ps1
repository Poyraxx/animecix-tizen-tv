param(
    [Parameter(Mandatory = $true)]
    [string]$TvAddress,
    [string]$PcAddress = "",
    [int]$Port = 48761
)

$parsedTv = $null
if (-not [Net.IPAddress]::TryParse($TvAddress, [ref]$parsedTv)) { throw "TV IP adresi geçersiz." }

if (-not $PcAddress) {
    $prefix = $TvAddress.Substring(0, $TvAddress.LastIndexOf('.') + 1)
    $PcAddress = Get-NetIPAddress -AddressFamily IPv4 -AddressState Preferred | Where-Object { $_.IPAddress -like "$prefix*" -and $_.IPAddress -ne $TvAddress } | Select-Object -First 1 -ExpandProperty IPAddress
    if (-not $PcAddress) { $PcAddress = Get-NetIPAddress -AddressFamily IPv4 -AddressState Preferred | Where-Object { $_.IPAddress -notlike '127.*' -and $_.InterfaceAlias -notmatch 'Loopback|vEthernet' } | Select-Object -First 1 -ExpandProperty IPAddress }
}

$parsedPc = $null
if (-not $PcAddress -or -not [Net.IPAddress]::TryParse($PcAddress, [ref]$parsedPc)) { throw "Bilgisayar IP adresi bulunamadı. -PcAddress ile elle belirtin." }

$repoRoot = Split-Path -Parent $PSScriptRoot
$appDirectory = Join-Path $repoRoot 'app'
$dataDirectory = Join-Path $env:LOCALAPPDATA 'AnimeciXTV'
$toolDirectory = Join-Path $env:USERPROFILE 'Tools\AnimeciXTV'
$keyPath = Join-Path $dataDirectory 'bridge-key.bin'

New-Item -ItemType Directory -Force -Path $dataDirectory, $toolDirectory | Out-Null

if (Test-Path -LiteralPath $keyPath) {
    $key = [IO.File]::ReadAllBytes($keyPath)
    if ($key.Length -ne 32) { throw "Mevcut bağlantı anahtarı geçersiz." }
} else {
    $key = New-Object byte[] 32
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    $random.GetBytes($key)
    $random.Dispose()
    [IO.File]::WriteAllBytes($keyPath, $key)
}

$base64Key = [Convert]::ToBase64String($key)
[IO.File]::WriteAllText((Join-Path $appDirectory 'bridge-key.js'), "window.animecixBridgeKey = `"$base64Key`";`r`n", [Text.UTF8Encoding]::new($false))

[IO.File]::WriteAllText((Join-Path $appDirectory 'bridge-config.js'), "window.animecixBridgeUrl = `"http://${PcAddress}:${Port}/api`";`r`n", [Text.UTF8Encoding]::new($false))

$config = [ordered]@{ tvAddress = $TvAddress; port = $Port }
[IO.File]::WriteAllText((Join-Path $dataDirectory 'config.json'), ($config | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath (Join-Path $repoRoot 'bridge\bridge-server.mjs') -Destination (Join-Path $toolDirectory 'bridge-server.mjs') -Force

$node = (Get-Command node.exe -ErrorAction Stop).Source
$vbs = "Set shell = CreateObject(`"WScript.Shell`")`r`nshell.Run `"`"`"$node`"`" `"`"$(Join-Path $toolDirectory 'bridge-server.mjs')`"`"`", 0, False`r`n"
[IO.File]::WriteAllText((Join-Path $toolDirectory 'start.vbs'), $vbs, [Text.UTF8Encoding]::new($false))
Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'AnimeciXTV' -Value "wscript.exe //B `"$(Join-Path $toolDirectory 'start.vbs')`""

$existing = Get-CimInstance Win32_Process -Filter "name = 'node.exe'" | Where-Object { $_.CommandLine -like "*AnimeciXTV*bridge-server.mjs*" }
foreach ($process in $existing) { Stop-Process -Id $process.ProcessId -Force }
Start-Process -FilePath $node -ArgumentList "`"$(Join-Path $toolDirectory 'bridge-server.mjs')`"" -WindowStyle Hidden
Start-Sleep -Milliseconds 700
$health = Invoke-RestMethod -Uri "http://127.0.0.1:${Port}/health" -TimeoutSec 5
if (-not $health.ready) { throw "Bağlantı servisi başlatılamadı." }

[pscustomobject]@{
    TvAddress = $TvAddress
    PcAddress = $PcAddress
    Port = $Port
    AppDirectory = $appDirectory
    BridgeDirectory = $toolDirectory
    Ready = $health.ready
} | Format-List
