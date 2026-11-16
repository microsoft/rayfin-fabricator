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

Cargo uses the same feed's crates.io upstream through a generated `.cargo/config.toml`
and `CargoAuthenticate@0`. The Cargo client first saves the pinned wry package from the
upstream; Azure Artifacts requires an official client for upstream ingestion.
Vendored-wry verification then reads that saved package through the sparse registry,
authenticates with the task's token, and verifies the archive against the registry checksum.
The official build does not fall back to blocked public package endpoints.

The pipeline checks application versions in npm, Tauri, Cargo, and both lockfiles, verifies
the checked-out commit against `Build.SourceVersion`, runs the renderer/backend checks,
and builds the desktop binary without an installer. Its only published artifact is
`windows-validation`, containing source/version metadata and `windows-binaries.json`.
The inventory records SHA-256, PE machine type, and existing Authenticode status for
top-level release PE outputs, the pinned sidecar, and files inside both embedded Copilot
SDK archives (including native `.node` modules). Archives are inspected in a temporary
directory, never executed or modified; only metadata is published. This is not a complete
installer or recursively embedded sidecar inventory, and signature status is evidence,
not an approved signing-policy determination. It does **not** sign, publish
executables, create a GitHub release, access the ESRP connection, or generate updater assets.
Official-template security checks are not disabled.

The optional `SignWindowsPilot` parameter defaults to `false`. An authorized manual run
can set it to `true` to sign temporary copies of Fabricator (`CP-230012`) and the received
OSS sidecar (`CP-231522`) with `EsrpCodeSigning@6`, reusing the approved AppDev connection
and Key Vault request-signing certificate. The copies must initially be unsigned.
Verification requires valid timestamped Microsoft signatures and rechecks that the original
build outputs and all embedded SDK payloads are unchanged. ESRP's generated
`CodeSignSummary-<guid>.md` files are permitted metadata, not signing inputs.
Only `windows-signing-pilot.json`
is published; signed executables remain outside the artifact directory on the agent.
This does not package an installer, generate updater signatures, or clear release-compliance
requirements. The other approved keycodes are not exercised by this Windows-only pilot.

Register the pipeline against this YAML in the GitHub repository and authorize the GitHub
connection, template repository, and Windows pool only for that pipeline. ESRP resource
authorization and a protected release environment are separate prerequisites for the later
signing/publishing stages. Keep those credentials in ADO/Key Vault, not in this repository.
macOS remains blocked until an approved Apple Silicon pool is available.

### Opt-in PR review alphas

The PR author or someone who has submitted a review can apply the `release-test`
label to an open, same-repository PR targeting `main`. An authorized ADO operator
then manually queues [pipeline 20869](https://dev.azure.com/powerbi/AppDev/_build?definitionId=20869)
from that PR's exact current head branch/commit with `testReleasePr=<PR number>`.
The default `0` publishes nothing. Labels and PR events do not automatically queue
a privileged run. Applying labels requires the usual GitHub repository permissions.

The pipeline checks the label's latest applying actor, open PR, repository, target
branch and current head both before building and immediately before publishing.
Removing the label, closing the PR or moving its head revokes publication for that
run. API failures block release. Same-repo code and pipeline YAML must be trusted
and reviewed before queueing: this is **not** a safe execution boundary for
arbitrary PR code. Build scripts execute in a signing-capable job, and the
no-checkout publication job uses a helper from that run's artifact. Restrict ADO
queue and service-connection permissions accordingly; forks are not supported.

Only the agent checkout's application manifests/lockfiles get the version
`<base>-alpha.<Build.BuildId>`. No version change is committed. Both binaries are
ESRP-signed and verified, then packaged into a Windows x64 **portable ZIP** with
the sidecar, required icon resources, license and `SMOKE-TEST.txt`. Archive
extraction must preserve every packaged file and both valid timestamped signatures.
The release stage waits for the build and 1ES source-security stage, rechecks
source/build/PR metadata and the ZIP hash, then creates a GitHub prerelease tagged
`v<base>-alpha.<Build.BuildId>`, with `makeLatest=false`. Existing releases are never
overwritten. Public assets include the ZIP, `SHA256SUMS.txt`,
`windows-alpha.json`, an NSIS `*-setup.exe`, its updater `.sig`, and a
Windows-only `latest.json`; no private signing credentials or build logs are uploaded.
The existing GitHub Actions installer workflow excludes alpha tags, including
manual dispatch on those tags, so it cannot append unsigned installers or updater
assets to an ADO alpha release.

Extract the whole ZIP and run `rayfin-fabricator.exe` beside `rayfin-local.exe`
and `resources/`. Windows x64, WebView2 Runtime, Node.js/npm and git are required.
It uses the normal Fabricator user profile, so back up important data first.
Smoke-test launch, sign-in, a disposable project's local backend and preview,
and closing/reopening the app; record results on the PR. A release-producing PR
should link at least one alpha for manual review before merge.

Alpha versions never contact the stable updater endpoint. Their release-specific
`latest.json` is validation evidence, not a stable updater rollout. No macOS
assets are published; macOS work is deferred pending the Microsoft sidecar.
Installing this Microsoft-channel build is a manual migration from upstream
builds, which trust a different updater key and repository.

Installer packaging uses `tauri bundle --no-binary-patching` after signing the
app and sidecar, so bundling cannot invalidate their signatures. A bounded
agent-local callback bridge pauses Tauri for each required signature while an
`EsrpCodeSigning@6` task signs a staged copy. Only a verified timestamped Microsoft
signature releases the callback. NSIS DLLs use the component key; the generated
uninstaller and final installer use the application key. Tool-cache originals
are not modified. The Windows job requires actual silent installation,
update-mode reinstallation without launching the GUI, payload/hash/signature
verification, and uninstallation. These checks do not replace manual GUI smoke
testing or an actual two-version in-app update.

The stock NSIS 3.13 stub has no base relocations and fails mandatory BinSkim
BA2009. PR alphas rebuild that same NSIS version from immutable source with the
SHA-256-pinned GNU compiler and SCons inputs in `scripts/nsis-aslr.lock.json`.
Two independent source/build directories must produce byte-identical LZMA stubs.
The source changes enable actual relocations and place `.reloc` before the
`.ndata` and `.rsrc` sections that NSIS edits; they do not merely set an ASLR flag.
Only those two stubs are replaced in a build-local copy of the pinned toolset.
Tauri's shared cache and installer hooks/UX are unchanged.

`scripts/build-nsis-stub.ps1` requires the locked Python version and accepts
`-WorkFolder`, `-ToolsFolder` and `-EvidenceFolder`; all must refer to dedicated
build paths, not a shared tool installation. The pipeline records input/output
hashes in `nsis-stub.json`, checks the complete local toolset before and after
packaging, and rejects missing, stale or malformed relocations before signing
the uninstaller or installer. Installation checks require the actual installer
process to load at a relocated base. Mandatory Guardian/BinSkim checks remain
enabled; no ASLR baseline or suppression is used.

Only the separate no-checkout release job receives the updater secrets. It
signs the final Authenticode-signed installer with pinned Tauri tooling, verifies
the signature against the committed Microsoft public key, and binds its trusted
comment to the exact alpha version. The app requires signed versions. PR opt-in,
artifact hashes and updater assets are checked again immediately before create-only
publication. The release helper still comes from trusted/reviewed PR artifacts;
this is not isolation against malicious producer code.

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

For the Microsoft ADO channel, bootstrap a **new** updater key into the existing
`appdev-team-kv` in subscription `47d8d56c-3a05-4e1a-805b-87cc4b1ba5a3`,
resource group `team-rg`, rather than reusing the upstream owner's key. From your
usual login shell on macOS/Linux, with dependencies restored and Azure CLI signed
in as an identity allowed to read vault metadata and list/get/set secrets:

```bash
# Read-only: validate the exact vault and check active and soft-deleted secret names.
node scripts/bootstrap-updater-key.mjs

# Explicitly create and upload a new pair. Run only one bootstrap at a time.
node scripts/bootstrap-updater-key.mjs --create
```

The script generates a 48-byte cryptographically random password, uploads it as
`fabricator-updater-password`, then generates a password-encrypted Tauri key and
uploads it as `fabricator-updater-private-key`. These are **Key Vault secrets**,
not Key Vault cryptographic keys: Tauri needs its own encrypted minisign private-key
format. Azure authentication stays with Azure CLI; no token is exported. Secret
uploads use protected files, not command-line secret values. Tauri receives its
password through an in-memory native API in a worker with piped input, never a
password in the OS argument list. Raw tool diagnostics are suppressed on failure
because they may contain secret data; the failed operation is reported instead.

After each upload the exact returned secret version is read back. The script
compares the bytes and verifies an actual Tauri signing proof using the restored
key/password and generated public key. Only then does it retain
`src-tauri/updater.pub` and a nonsecret `src-tauri/updater.pub.vault.json` receipt
containing versioned secret IDs and the public-key hash. Successful completion
removes local temporary secret files. The public key is safe to commit; this does
not automatically configure pipeline access. The Microsoft configuration embeds
the resulting public key, also committed as `src-tauri/updater.pub`.

Existing or soft-deleted names and existing public-key outputs block creation.
There is deliberately no overwrite, rotation, deletion or purge switch. Key Vault
does not make the preflight plus two secret uploads a transaction: serialize
issuance and do not run concurrent bootstraps. If an operation fails, protected
`0700` recovery-directory / `0600` secret files and the known secret-version IDs
are retained; inspect and recover that pair before retrying. Do not delete vault
entries or pick new names merely to bypass the refusal.

No vault firewall/RBAC/retention settings are changed. The vault currently has
soft delete enabled but purge protection is not enabled; arrange appropriate
recovery retention and a protected backup with the vault owner. Keeping the key
and password in the same vault is convenient custody, not access separation:
an identity able to read both can sign updates. Restrict the eventual pipeline
identity to the required secrets, gate signing, and never expose them to arbitrary
PR build code.

Direct pipeline access to Key Vault is deferred. For now, definition 20869 uses
two saved **secret** ADO variables, `fabricator-updater-private-key` and
`fabricator-updater-password`. They map to Tauri environment variables only on the
updater-signing task, never into PowerShell source, OS arguments, artifacts or
logs. A child worker receives native API arguments over stdin; raw native
diagnostics are captured and suppressed on failure. Do not copy secret values
into YAML. The vault and ESRP connection use different tenants, so future direct
vault retrieval needs a separate appropriate service connection and read scope.

The following describes the **existing upstream GitHub Actions channel**, not
the Microsoft ADO configuration:

Update packages are verified against the public key baked into `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). The upstream workflow expects these two GitHub Actions secrets; their presence is not established by the public configuration, and they are not configured in the Microsoft repository:

- `TAURI_SIGNING_PRIVATE_KEY` — the minisign private key.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — its password.

If the private key is lost, you cannot sign updates that existing clients will accept; recovery requires shipping a new public key in a build that users install manually. Generate a key with `npx @tauri-apps/cli signer generate -w <keyfile>` and set the secrets with `gh secret set`.

### First-rollout caveat

Auto-update only works for installs built **with** the updater (the first updater-enabled release onward). Users on an earlier build must install that first release manually; subsequent updates are automatic.
