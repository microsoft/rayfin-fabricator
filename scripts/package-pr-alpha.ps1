param(
    [Parameter(Mandatory)][string]$SigningFolder,
    [Parameter(Mandatory)][string]$ValidationFolder,
    [Parameter(Mandatory)][string]$OutputFolder
)

$ErrorActionPreference = 'Stop'
$source = Get-Content -Raw (Join-Path $ValidationFolder 'source.json') | ConvertFrom-Json
$signing = Get-Content -Raw (Join-Path $ValidationFolder 'windows-signing-pilot.json') | ConvertFrom-Json
if ($source.sourceCommit -cne $env:BUILD_SOURCEVERSION -or
    $signing.sourceCommit -cne $source.sourceCommit -or
    $signing.originalPayloadsUnchanged -ne $true -or
    $source.version -cnotmatch "^\d+\.\d+\.\d+-alpha\.$env:BUILD_BUILDID$") {
    throw 'Only verified signed alpha binaries from this exact build may be packaged.'
}
$package = Join-Path $env:AGENT_TEMPDIRECTORY 'fabricator-alpha-package'
New-Item -ItemType Directory -Path $package | Out-Null
foreach ($file in $signing.files) {
    $inputFile = Join-Path $SigningFolder $file.path
    $signature = Get-AuthenticodeSignature -LiteralPath $inputFile
    if ((Get-FileHash -Algorithm SHA256 $inputFile).Hash.ToLowerInvariant() -cne $file.sha256 -or
        $signature.Status -ne 'Valid' -or -not $signature.TimeStamperCertificate) {
        throw "Signed input changed or is invalid: $($file.path)"
    }
    Copy-Item -LiteralPath $inputFile -Destination $package
}
$inventory = Get-Content -Raw (Join-Path $ValidationFolder 'windows-binaries.json') | ConvertFrom-Json
foreach ($file in @($inventory.files | Where-Object { $_.path.StartsWith('release-output/') })) {
    $name = $file.path.Substring('release-output/'.Length)
    if ($name -cin @('rayfin-fabricator.exe', 'rayfin-local.exe')) { continue }
    throw "Additional release PE output needs an explicit packaging/signing policy: $name"
}
$resources = New-Item -ItemType Directory -Path (Join-Path $package 'resources')
Copy-Item -LiteralPath 'src-tauri/icons/project-file.ico', 'src-tauri/icons/app-file.ico' -Destination $resources
Copy-Item -LiteralPath 'LICENSE' -Destination $package
@"
Rayfin Fabricator $($source.version) - Windows x64 review alpha
PR: https://github.com/microsoft/rayfin-fabricator/pull/$env:TEST_RELEASE_PR
Commit: $env:BUILD_SOURCEVERSION
Build: https://dev.azure.com/powerbi/AppDev/_build/results?buildId=$env:BUILD_BUILDID

Extract this entire ZIP, then run rayfin-fabricator.exe. Keep rayfin-local.exe and
resources beside it. Requires Windows x64, Microsoft Edge WebView2 Runtime, and
Node.js/npm, git and the usual Rayfin development prerequisites.
This is a portable review build, not an installer or stable release.
It uses the normal Fabricator user profile; back up important data before testing.
Automatic updates are disabled for alpha builds. A signed installer, updater signature
and release-specific manifest are separate release assets for validation, not stable rollout.
Smoke test: launch, sign in, open/create a disposable app, start its local backend,
preview it, close and reopen Fabricator, and record results on the PR.
"@ | Set-Content -Encoding utf8 (Join-Path $package 'SMOKE-TEST.txt')
New-Item -ItemType Directory -Path $OutputFolder | Out-Null
$archiveName = "rayfin-fabricator-$($source.version)-windows-x64.zip"
$archive = Join-Path $OutputFolder $archiveName
Compress-Archive -Path "$package/*" -DestinationPath $archive
$extracted = Join-Path $env:AGENT_TEMPDIRECTORY 'fabricator-alpha-extracted'
Expand-Archive -LiteralPath $archive -DestinationPath $extracted
foreach ($file in Get-ChildItem -LiteralPath $package -Recurse -File) {
    $relative = [IO.Path]::GetRelativePath($package, $file.FullName)
    $copy = Join-Path $extracted $relative
    if ((Get-FileHash -Algorithm SHA256 $file.FullName).Hash -cne
        (Get-FileHash -Algorithm SHA256 $copy).Hash) {
        throw "Archive round-trip changed $relative"
    }
}
foreach ($file in $signing.files) {
    $signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $extracted $file.path)
    if ($signature.Status -ne 'Valid' -or -not $signature.TimeStamperCertificate) {
        throw "Extracted binary signature is invalid: $($file.path)"
    }
}
$hash = (Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant()
$installer = Get-Content -Raw (Join-Path $ValidationFolder 'windows-installer.json') | ConvertFrom-Json
if ($installer.installVerification.uninstall -ne $true) {
    throw 'Installer has not passed the install/update-mode/uninstall checks.'
}
$installerFile = Join-Path 'src-tauri/target/release/bundle/nsis' $installer.installer.path
if ((Get-FileHash -Algorithm SHA256 $installerFile).Hash.ToLowerInvariant() -cne $installer.installer.sha256) {
    throw 'Verified installer changed before artifact publication.'
}
Copy-Item -LiteralPath $installerFile -Destination $OutputFolder
@(
    "$hash  $archiveName"
    "$($installer.installer.sha256)  $($installer.installer.path)"
) | Set-Content -Encoding utf8 (Join-Path $OutputFolder 'SHA256SUMS.txt')
[ordered]@{
    sourceCommit = $env:BUILD_SOURCEVERSION
    buildId = $env:BUILD_BUILDID
    pullRequest = [int]$env:TEST_RELEASE_PR
    version = $source.version
    archive = $archiveName
    archiveSha256 = $hash
    signing = $signing
    installer = $installer
} | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8 (Join-Path $OutputFolder 'windows-alpha.json')
$helpers = New-Item -ItemType Directory -Path (Join-Path $OutputFolder '_release')
Copy-Item -LiteralPath 'scripts/pr-alpha.mjs' -Destination $helpers
Copy-Item -LiteralPath 'scripts/sign-windows-updater.mjs', 'scripts/bootstrap-updater-key.mjs',
    'src-tauri/updater.pub' -Destination $helpers
Write-Host "##vso[task.setvariable variable=ReleaseTag;isOutput=true]v$($source.version)"
