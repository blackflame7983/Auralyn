param(
    [Parameter(Mandatory)][string]$RuntimeDirectory,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [ValidatePattern('^\d+\.\d+\.\d+\.\d+$')][string]$PackageVersion = '1.1.0.0',
    [string]$SdkBinDirectory
)

$ErrorActionPreference = 'Stop'
$versionParts = $PackageVersion.Split('.') | ForEach-Object { [uint64]$_ }
if (@($versionParts | Where-Object { $_ -gt 65535 }).Count -gt 0 -or $versionParts[0] -eq 0) {
    throw 'MSIXのバージョンは先頭が1以上、各要素が65535以下である必要があります。'
}
$projectRoot = Split-Path $PSScriptRoot -Parent
$runtime = (Resolve-Path -LiteralPath $RuntimeDirectory).Path
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) {
    throw '出力先は新しいフォルダーを指定してください。既存の試験結果は上書きしません。'
}

$binaryNames = @('AuralynHost.exe', 'audio_engine.exe', 'plugin_scanner.exe')
foreach ($name in $binaryNames) {
    $file = Join-Path $runtime $name
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "release実行ファイルが不足しています: $name"
    }
    $stream = [IO.File]::OpenRead($file)
    try {
        $reader = [IO.BinaryReader]::new($stream)
        if ($stream.Length -lt 64 -or $reader.ReadUInt16() -ne 0x5A4D) {
            throw "Windows x64実行ファイルではありません: $name"
        }
        $stream.Position = 0x3C
        $peOffset = $reader.ReadUInt32()
        if ($peOffset -gt $stream.Length - 6) {
            throw "PEヘッダーが不正です: $name"
        }
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550 -or $reader.ReadUInt16() -ne 0x8664) {
            throw "Windows x64実行ファイルではありません: $name"
        }
    } finally {
        $stream.Dispose()
    }
}

if (-not $SdkBinDirectory) {
    $sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
    $candidate = Get-ChildItem -LiteralPath $sdkRoot -Directory |
        Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
        Sort-Object { [version]$_.Name } -Descending |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'x64/makeappx.exe') } |
        Select-Object -First 1
    if (-not $candidate) { throw 'Windows SDKのx64 MakeAppx.exeが必要です。' }
    $SdkBinDirectory = Join-Path $candidate.FullName 'x64'
}
$makeappx = Join-Path $SdkBinDirectory 'makeappx.exe'
if (-not (Test-Path -LiteralPath $makeappx -PathType Leaf)) {
    throw '指定したSDKフォルダーにMakeAppx.exeがありません。'
}

# 音声エンジン等の正しいrelease構成は、呼出側で最終ビルドと照合する。
# この処理はビルド・署名・証明書の信頼登録・インストールを行わない。
$layout = Join-Path $output 'layout'
$assets = Join-Path $layout 'Assets'
$null = New-Item -ItemType Directory -Path $assets
foreach ($name in $binaryNames) {
    Copy-Item -LiteralPath (Join-Path $runtime $name) -Destination (Join-Path $layout $name)
}
foreach ($name in @('LICENSE', 'NOTICE.md', 'SOURCE-DISTRIBUTION.md')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination (Join-Path $layout $name)
}
foreach ($name in @('StoreLogo.png', 'Square150x150Logo.png', 'Square44x44Logo.png')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot "src-tauri/icons/$name") -Destination (Join-Path $assets $name)
}

[xml]$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'packaging/msix-prototype/AppxManifest.xml') -Raw -Encoding UTF8
$manifest.Package.Identity.Version = $PackageVersion
$manifest.Save((Join-Path $layout 'AppxManifest.xml'))
$package = Join-Path $output "Auralyn.CompatibilityPrototype_$($PackageVersion)_x64.msix"
& $makeappx pack /d $layout /p $package /h SHA256
if ($LASTEXITCODE -ne 0) { throw "MakeAppxが失敗しました: $LASTEXITCODE" }

$binaries = @($binaryNames | ForEach-Object {
    $source = Join-Path $runtime $_
    $staged = Join-Path $layout $_
    $hash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
    if ($hash -ne (Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash) {
        throw "配置後のハッシュが一致しません: $_"
    }
    @{ name = $_; sourcePath = $source; sha256 = $hash; bytes = (Get-Item -LiteralPath $source).Length }
})
@{
    prototypeOnly = $true
    packageIdentity = $manifest.Package.Identity.Name
    packageVersion = $PackageVersion
    packagePath = $package
    unsignedPackageSha256 = (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash
    makeappx = $makeappx
    binaries = $binaries
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $output 'package-manifest.json') -Encoding utf8
Write-Output "ローカル試験専用の未署名MSIXを作成しました: $package"
