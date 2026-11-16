param(
    [Parameter(Mandatory)][string]$ValidationFolder
)

$ErrorActionPreference = 'Stop'
$report = Get-Content -Raw (Join-Path $ValidationFolder 'windows-installer.json') | ConvertFrom-Json
$signed = Get-Content -Raw (Join-Path $ValidationFolder 'windows-signing-pilot.json') | ConvertFrom-Json
$installer = Join-Path 'src-tauri/target/release/bundle/nsis' $report.installer.path
$destination = Join-Path $env:AGENT_TEMPDIRECTORY 'fabricator-installer-check'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Rayfin Fabricator'
if ((Test-Path $uninstallKey) -or (Test-Path $destination)) {
    throw 'Installer validation requires a clean disposable agent, not an existing installation.'
}
$observedBases = [Collections.Generic.List[long]]::new()
function Run-Installer([string]$File, [string[]]$Arguments, [bool]$CheckAslr = $false) {
    $process = Start-Process -FilePath $File -ArgumentList $Arguments -PassThru
    if ($CheckAslr) {
        $actualBase = $process.MainModule.BaseAddress.ToInt64()
        if ($actualBase -eq 0 -or $actualBase -eq $report.installer.aslr.imageBase) {
            if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
            throw 'Windows did not load the NSIS installer at a relocated image base.'
        }
        $observedBases.Add($actualBase)
    }
    if (-not $process.WaitForExit(300000)) {
        Stop-Process -Id $process.Id -Force
        throw 'Installer validation timed out.'
    }
    if ($process.ExitCode -ne 0) { throw "Installer exited with $($process.ExitCode)." }
}
function Verify-Installed {
    foreach ($file in $signed.files) {
        $installed = Join-Path $destination $file.path
        if ((Get-FileHash -Algorithm SHA256 $installed).Hash.ToLowerInvariant() -cne $file.sha256) {
            throw "Installer changed signed payload: $($file.path)"
        }
        $signature = Get-AuthenticodeSignature -LiteralPath $installed
        if ($signature.Status -ne 'Valid' -or -not $signature.TimeStamperCertificate) {
            throw "Installed payload signature invalid: $($file.path)"
        }
    }
    $uninstaller = Join-Path $destination 'uninstall.exe'
    $hash = (Get-FileHash -Algorithm SHA256 $uninstaller).Hash.ToLowerInvariant()
    if ($hash -cnotin @($report.helpers | ForEach-Object { $_.sha256 })) {
        throw 'Installed uninstaller does not match an ESRP-verified signing callback.'
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $uninstaller
    if ($signature.Status -ne 'Valid' -or -not $signature.TimeStamperCertificate -or
        $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)') {
        throw 'Installed uninstaller is not validly Microsoft-signed and timestamped.'
    }
    foreach ($icon in @('app-file.ico', 'project-file.ico')) {
        if (-not (Test-Path (Join-Path $destination "resources/$icon"))) {
            throw "Installed icon is missing: $icon"
        }
    }
}
try {
    Run-Installer $installer @('/S', '/NS', "/D=$destination") $true
    Verify-Installed
    # Exercise the updater's NSIS mode without launching the GUI or claiming a version upgrade.
    Run-Installer $installer @('/S', '/UPDATE', '/NS', "/D=$destination") $true
    Verify-Installed
    Run-Installer (Join-Path $destination 'uninstall.exe') @('/S', "_?=$destination")
    if ((Test-Path (Join-Path $destination 'rayfin-fabricator.exe')) -or
        (Test-Path (Join-Path $destination 'rayfin-local.exe')) -or
        (Test-Path $uninstallKey)) {
        throw 'Uninstall left application binaries or its uninstall registration behind.'
    }
    $report | Add-Member -NotePropertyName installVerification -NotePropertyValue @{
        silentInstall = $true
        updateModeReinstall = $true
        signedInstalledPayloads = $true
        signedUninstaller = $true
        relocatedInstaller = $true
        observedImageBases = @($observedBases)
        uninstall = $true
        guiSmokeTest = 'Not performed'
        crossVersionUpdate = 'Not performed'
    }
    $report | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8 `
        (Join-Path $ValidationFolder 'windows-installer.json')
}
finally {
    if (Test-Path (Join-Path $destination 'uninstall.exe')) {
        Write-Warning "Installer validation left its disposable test installation at $destination."
    }
}
