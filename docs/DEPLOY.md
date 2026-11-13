# Fabricator deployment

`deploy.ps1` provisions the Azure telemetry infrastructure for the app and wires the Application Insights GitHub Actions secret. Binary distribution is handled by GitHub Releases via CI.

## Prerequisites

- PowerShell 7 (`pwsh`)
- Azure CLI (`az`) signed in to the Azure subscription that should host the telemetry resources (pass `-SubscriptionId` to override; otherwise the current `az` subscription is used)
- GitHub CLI (`gh`) authenticated to `spatney/rayfin-fabricator` for automatic `APPINSIGHTS_CONNECTION_STRING` secret wiring
- Node.js/npm for local builds
- Rust toolchain (stable, MSVC) and the WebView2 runtime for `-BuildLocal` Tauri builds

## What it provisions

- Resource group `rayfin-fabricator`
- Log Analytics workspace `rayfin-fabricator-logs`
- Workspace-based Application Insights `rayfin-fabricator-insights`
- Resource-group monthly Azure budget alerts at 80% and 100%

## Cost posture

The intended steady-state cost is near $0 for light usage: Application Insights has a 5 GB/month free grant and the script sets a strict 0.1 GB/day ingestion cap; the default $5 monthly budget sends alert emails.

## Run

From the repo root:

```powershell
pwsh -NoProfile -File .\deploy.ps1
```

To provision and wire endpoints and build a local Windows installer:

```powershell
pwsh -NoProfile -File .\deploy.ps1 -BuildLocal
```

The script writes `resources/telemetry.json` and `.deploy.state.json`. If `gh` is unavailable or not authenticated, it prints the Actions secret to add manually.

## Cut a release

### ADO official-pipeline pilot

`.azure-pipelines/fabricator.official.yml` is the initial **Windows-only, build-validation**
pipeline for `powerbi/AppDev`. It extends the 1ES official template and uses the existing
Windows build pool. Both CI and PR triggers are disabled: queue it manually for an exact
commit while the ESRP integration is being established.

The Node.js task requires Node 24.15 or newer within the 24.x line, matching the
locked dependencies' engine requirements rather than accepting an older cached Node 24.
Rust setup updates the stable toolchain without self-updating the agent image's rustup
executable, avoiding replacement of the running tool and its preinstalled proxies.
Dependency setup uses AppDev's `rayfin-official` Azure Artifacts npm feed, matching
project-rayfin's official pipeline; direct npmjs.org access returns HTTP 403 on the agent.
`npmAuthenticate@0` authenticates a temporary npm config without putting credentials in
the checkout. The build identity needs feed access, including upstream-save permission
for dependencies not already cached. npm retains lockfile versions and integrity checks.
A bounded package-metadata read checks feed access before installation, which logs
HTTP/lifecycle progress and has a 20-minute timeout.

The pipeline checks application versions in npm, Tauri, Cargo, and both lockfiles, verifies
the checked-out commit against `Build.SourceVersion`, runs the renderer/backend checks,
and builds the desktop binary without an installer. Its only published artifact is
`windows-validation`, containing source/version metadata. It does **not** sign, publish
executables, create a GitHub release, access the ESRP connection, or generate updater assets.
Official-template security checks are not disabled.

Register the pipeline against this YAML in the GitHub repository and authorize the GitHub
connection, template repository, and Windows pool only for that pipeline. ESRP resource
authorization and a protected release environment are separate prerequisites for the later
signing/publishing stages. Keep those credentials in ADO/Key Vault, not in this repository.
macOS remains blocked until an approved Apple Silicon pool is available.

### Existing GitHub Actions release

Push a version tag to trigger the GitHub Actions release workflow that builds the Windows installer (Tauri/NSIS) and publishes it to a GitHub Release:

```powershell
git tag v0.1.0
git push origin v0.1.0
```

## npm during project creation

New projects are created with `npm create @microsoft/rayfin@latest -- <folder> -t universal-app`, the Universal App template built into the Rayfin CLI (its data service starts off, so no database is created until the app needs one). Fabricator doesn't bundle a template or an npm cache: npm uses its normal cache and the registry.

- **Fresh scaffold metadata.** `npm create @microsoft/rayfin@latest` explicitly disables `prefer-offline` and enables `prefer-online` for itself and its children. npm gives `prefer-offline` precedence: enabling both can resolve the latest scaffolder against an older cached CLI manifest and fail with `ETARGET` even though that CLI version is published (issue #28). The fix keeps npm's cache and the selected package versions; it does not clear caches or silently substitute an older CLI.
- **Regression coverage.** `cargo test --manifest-path src-tauri\Cargo.toml --lib npm` (PowerShell, from the repo root) checks the npm environment policy and reproduces stale-metadata `ETARGET` against a loopback registry. Requires Node.js/npm; no packages are installed, and the user's npm configuration and cache are not used.

## Auto-update

The app ships with Tauri's updater plugin. On startup (and via **Settings → Check for updates**) it fetches `latest.json` from the latest GitHub Release, downloads the new installer in the background, and prompts the user to restart and install.

### How the release workflow supports it

`.github/workflows/release.yml` signs the installer with a minisign key and publishes three assets per release: `*-setup.exe`, `*-setup.exe.sig`, and a generated `latest.json` (version, notes, `pub_date`, and the `windows-x86_64` signature + download URL). The updater endpoint is `releases/latest/download/latest.json`, which always resolves to the most recent non-prerelease release — so keep releases non-prerelease.

### Updater signing key (custody)

Update packages are verified against the public key baked into `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). The matching private key lives **only** in two GitHub Actions secrets and must be backed up offline:

- `TAURI_SIGNING_PRIVATE_KEY` — the minisign private key.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — its password.

If the private key is lost, you cannot sign updates that existing clients will accept; recovery requires shipping a new public key in a build that users install manually. Generate a key with `npx @tauri-apps/cli signer generate -w <keyfile>` and set the secrets with `gh secret set`.

### First-rollout caveat

Auto-update only works for installs built **with** the updater (the first updater-enabled release onward). Users on an earlier build must install that first release manually; subsequent updates are automatic.
