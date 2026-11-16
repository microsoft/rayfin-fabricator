param(
    [Parameter(Mandatory)][string]$WorkFolder,
    [Parameter(Mandatory)][string]$ToolsFolder,
    [Parameter(Mandatory)][string]$EvidenceFolder
)

$ErrorActionPreference = 'Stop'
$lock = Get-Content -Raw 'scripts/nsis-aslr.lock.json' | ConvertFrom-Json
if ((Test-Path $WorkFolder) -or (Test-Path $ToolsFolder)) {
    throw 'NSIS rebuild requires fresh build and local-tool directories.'
}
New-Item -ItemType Directory -Path $WorkFolder | Out-Null
$python = (Get-Command python).Source
$version = & $python -c 'import platform; print(platform.python_version())'
if ($LASTEXITCODE -ne 0 -or $version -cne $lock.pythonVersion) { throw 'Unexpected Python version.' }
$bits = & $python -c 'import struct; print(8 * struct.calcsize("P"))'
if ($LASTEXITCODE -ne 0 -or [int]$bits -ne $lock.pythonBits) { throw 'Unexpected Python architecture.' }

function Download-Input([string]$Name, [string]$Extension) {
    $item = $lock.$Name
    $file = Join-Path $WorkFolder "$Name.$Extension"
    Invoke-WebRequest -Uri $item.url -OutFile $file
    if ((Get-FileHash -Algorithm SHA256 $file).Hash.ToLowerInvariant() -cne $item.sha256) {
        throw "NSIS build input SHA-256 mismatch: $Name"
    }
    return $file
}
function Extract-Source([string]$Archive, [string]$Destination) {
    New-Item -ItemType Directory -Path $Destination | Out-Null
    tar -xzf $Archive -C $Destination --strip-components=1
    if ($LASTEXITCODE -ne 0) { throw 'Cannot extract pinned source archive.' }
}
$sourceArchive = Download-Input 'nsisSource' 'tar.gz'
$sconsArchive = Download-Input 'scons' 'tar.gz'
$compilerArchive = Download-Input 'compiler' 'zip'
$toolsetArchive = Download-Input 'toolset' 'zip'
$plugin = Download-Input 'plugin' 'dll'
$scons = Join-Path $WorkFolder 'scons'
Extract-Source $sconsArchive $scons
$compiler = Join-Path $WorkFolder 'compiler'
Expand-Archive -LiteralPath $compilerArchive -DestinationPath $compiler
$env:PATH = "$(Join-Path $compiler 'mingw32/bin');$env:PATH"
$env:PYTHONPATH = $scons
$env:SOURCE_DATE_EPOCH = [string]$lock.sourceDateEpoch
$env:TZ = 'UTC'
$stubs = @{}
$hashes = @{}
foreach ($build in @('first', 'second')) {
    $source = Join-Path $WorkFolder $build
    Extract-Source $sourceArchive $source
    node scripts/nsis-aslr.mjs patch $source
    if ($LASTEXITCODE -ne 0) { throw 'Cannot apply the exact NSIS ASLR source changes.' }
    Push-Location $source
    try {
        & $python "$scons/scripts/scons.py" -j2 TOOLSET=mingw TARGET_ARCH=x86 `
            "PATH=$env:PATH" "CC=$(Join-Path $compiler 'mingw32/bin/gcc.exe')" `
            "CXX=$(Join-Path $compiler 'mingw32/bin/g++.exe')" `
            UNICODE=yes VERSION=3.13 VER_MAJOR=3 VER_MINOR=13 VER_REVISION=0 VER_BUILD=0 `
            "NSIS_MAX_STRLEN=$($lock.maxStringLength)" `
            SKIPSTUBS=bzip2,zlib SKIPUTILS=all SKIPPLUGINS=all SKIPMISC=all SKIPDOC=all stubs
        if ($LASTEXITCODE -ne 0) { throw "Pinned NSIS stub build failed: $build" }
    }
    finally { Pop-Location }
    foreach ($name in @('lzma-x86-unicode', 'lzma_solid-x86-unicode')) {
        $file = Join-Path $source "build/urelease/stub_$name/stub_lzma.exe"
        $hash = (Get-FileHash -Algorithm SHA256 $file).Hash.ToLowerInvariant()
        if ($build -eq 'first') {
            $stubs[$name] = $file
            $hashes[$name] = $hash
        }
        elseif ($hash -cne $hashes[$name]) {
            throw "Independent NSIS builds were not byte-identical: $name"
        }
    }
}

$stock = Join-Path $WorkFolder 'stock'
Expand-Archive -LiteralPath $toolsetArchive -DestinationPath $stock
$original = Join-Path $stock 'nsis-3.13'
$header = & "$original/Bin/makensis.exe" /HDRINFO 2>&1 | Out-String
if ($LASTEXITCODE -ne 0 -or $header -notmatch "NSIS_MAX_STRLEN=$($lock.maxStringLength)(\D|$)") {
    throw 'Pinned toolset and rebuilt stub string lengths differ.'
}
New-Item -ItemType Directory -Path (Split-Path $ToolsFolder) -Force | Out-Null
Copy-Item -LiteralPath $original -Destination $ToolsFolder -Recurse
foreach ($name in $stubs.Keys) {
    Copy-Item -LiteralPath $stubs[$name] -Destination (Join-Path $ToolsFolder "Stubs/$name") -Force
}
$additional = Join-Path $ToolsFolder 'Plugins/x86-unicode/additional'
New-Item -ItemType Directory -Path $additional -Force | Out-Null
Copy-Item -LiteralPath $plugin -Destination (Join-Path $additional 'nsis_tauri_utils.dll')
$evidence = Join-Path $EvidenceFolder 'nsis-stub.json'
@{
    inputs = $lock
    reproducible = $true
    stubs = $hashes
    compilerVersion = (& gcc --version | Select-Object -First 1)
    pythonVersion = $version
    pythonBits = [int]$bits
} | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8 $evidence
node scripts/nsis-aslr.mjs record $ToolsFolder $evidence $original
if ($LASTEXITCODE -ne 0) { throw 'Rebuilt NSIS stubs or toolset failed verification.' }
