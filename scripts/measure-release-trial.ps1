param(
    [Parameter(Mandatory)][int]$HostProcessId,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [ValidateRange(1, 259200)][int]$DurationSeconds = 3600,
    [ValidateRange(1, 300)][int]$IntervalSeconds = 30
)

# プロセスを起動・終了せず、設定・優先度・タイマー解像度も変更しない。
$ErrorActionPreference = 'Stop'
$hostProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$HostProcessId"
if (-not $hostProcess -or $hostProcess.Name -ne 'AuralynHost.exe') { throw 'AuralynHost.exeのPIDを指定してください。' }
if (Test-Path -LiteralPath $OutputDirectory) { throw '出力先は新しいフォルダーを指定してください。' }
$null = New-Item -ItemType Directory -Path $OutputDirectory
$logicalCores = [Environment]::ProcessorCount
$paths = @{}
$lastCpu = @{}
$lastTime = [DateTime]::UtcNow
$start = $lastTime
$identity = @{ measurementScriptSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash; hostProcessId = $HostProcessId; hostPath = $hostProcess.ExecutablePath; hostSha256 = (Get-FileHash -LiteralPath $hostProcess.ExecutablePath -Algorithm SHA256).Hash; startedUtc = $start.ToString('o'); logicalCores = $logicalCores; intervalSeconds = $IntervalSeconds; scope = 'host and current descendants; PrivateMemorySize64 and WorkingSet64 in bytes; CPU normalized across logical cores' }
$identity | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'identity.json') -Encoding UTF8
do {
    $now = [DateTime]::UtcNow
    $all = @(Get-CimInstance Win32_Process)
    $currentHost = $all | Where-Object { $_.ProcessId -eq $HostProcessId -and $_.CreationDate -eq $hostProcess.CreationDate }
    if (-not $currentHost) { break }
    $members = @($HostProcessId)
    do {
        $children = @($all | Where-Object { $members -contains $_.ParentProcessId -and $members -notcontains $_.ProcessId } | ForEach-Object { [int]$_.ProcessId })
        $members += $children
    } while ($children.Count -gt 0)
    $seconds = ($now - $lastTime).TotalSeconds
    foreach ($processId in $members) {
        $info = $all | Where-Object { $_.ProcessId -eq $processId } | Select-Object -First 1
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if (-not $process -or -not $info) { continue }
        $key = "$processId/$($info.CreationDate.ToString('o'))"
        $cpuSeconds = $process.TotalProcessorTime.TotalSeconds
        $cpu = $null
        if ($lastCpu.ContainsKey($key) -and $seconds -gt 0) { $cpu = [Math]::Max(0.0, ($cpuSeconds - $lastCpu[$key]) / $seconds / $logicalCores * 100) }
        $lastCpu[$key] = $cpuSeconds
        if ($info.ExecutablePath -and -not $paths.ContainsKey($info.ExecutablePath)) {
            $paths[$info.ExecutablePath] = (Get-FileHash -LiteralPath $info.ExecutablePath -Algorithm SHA256).Hash
            $paths | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'binary-hashes.json') -Encoding UTF8
        }
        [pscustomobject]@{ utc = $now.ToString('o'); processId = $processId; name = $process.ProcessName; cpuPercent = $cpu; privateBytes = $process.PrivateMemorySize64; workingSetBytes = $process.WorkingSet64 } |
            Export-Csv -LiteralPath (Join-Path $OutputDirectory 'samples.csv') -NoTypeInformation -Append -Encoding UTF8
    }
    $lastTime = $now
    $remaining = $DurationSeconds - ([DateTime]::UtcNow - $start).TotalSeconds
    if ($remaining -le 0) { break }
    Start-Sleep -Milliseconds ([int]([Math]::Min([double]$IntervalSeconds, $remaining) * 1000))
} while (([DateTime]::UtcNow - $start).TotalSeconds -le $DurationSeconds)
