# squirm installer (Windows PowerShell) — downloads a prebuilt binary tarball
# from GitHub Releases. No runtime required.
#
#   irm https://raw.githubusercontent.com/notshekhar/squirm/main/install.ps1 | iex
#
# Layout after install:
#   $env:USERPROFILE\.squirm-bin\
#     ├── squirm.exe
#     └── package.json
#   Adds $env:USERPROFILE\.squirm-bin to user PATH (and the current session).
#
# Env knobs:
#   $env:SQUIRM_REPO_SLUG  notshekhar/squirm
#   $env:SQUIRM_VERSION    vX.Y.Z       pin a specific tag
#   $env:SQUIRM_HOME       %USERPROFILE%\.squirm-bin
#   $env:SQUIRM_FORCE      1            skip "already up to date" gate
#   $env:SQUIRM_UNINSTALL  1            remove the install + PATH entry and exit

$ErrorActionPreference = "Stop"

function Bold($msg)  { Write-Host $msg -ForegroundColor White }
function Dim($msg)   { Write-Host $msg -ForegroundColor DarkGray }
function Err($msg)   { Write-Host $msg -ForegroundColor Red }

$RepoSlug   = if ($env:SQUIRM_REPO_SLUG) { $env:SQUIRM_REPO_SLUG } else { "notshekhar/squirm" }
$SquirmHome = if ($env:SQUIRM_HOME)      { $env:SQUIRM_HOME }      else { Join-Path $env:USERPROFILE ".squirm-bin" }
$Force      = $env:SQUIRM_FORCE -eq "1"
$PinVersion = $env:SQUIRM_VERSION

# ── Uninstall ─────────────────────────────────────────────────────────────
if ($env:SQUIRM_UNINSTALL -eq "1") {
    Bold "▶ Uninstalling squirm"
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath) {
        $newPath = ($userPath.Split(";") | Where-Object { $_ -and $_ -ne $SquirmHome }) -join ";"
        if ($newPath -ne $userPath) {
            [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
            Dim "  removed $SquirmHome from user PATH"
        }
    }
    if (Test-Path $SquirmHome) {
        Remove-Item -Recurse -Force $SquirmHome -ErrorAction SilentlyContinue
        Dim "  removed $SquirmHome"
    }
    Get-ChildItem -Path (Split-Path $SquirmHome -Parent) -Filter "$(Split-Path $SquirmHome -Leaf).old.*" -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue }
    Bold "✓ Uninstalled."
    exit 0
}

# ── Detect arch ───────────────────────────────────────────────────────────
if (-not [Environment]::Is64BitOperatingSystem) {
    Err "32-bit Windows not supported."
    exit 1
}
$target = "windows-x64"
if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64" -or $env:PROCESSOR_ARCHITEW6432 -eq "ARM64") {
    # No native windows-arm64 release yet; the x64 build runs fine under
    # Windows 11's x64 emulation.
    Dim "  Windows on ARM detected — installing the x64 build (runs emulated)."
}
Dim "  target: $target"

# ── Resolve target version ────────────────────────────────────────────────
# Prefer the releases/latest redirect — it isn't subject to the anonymous
# GitHub API rate limit. Fall back to the API.
function Resolve-LatestTag {
    try {
        $resp = Invoke-WebRequest "https://github.com/$RepoSlug/releases/latest" `
                                  -Method Head -MaximumRedirection 5 -UseBasicParsing
        $final = $resp.BaseResponse.ResponseUri  # Windows PowerShell 5.x
        if (-not $final) { $final = $resp.BaseResponse.RequestMessage.RequestUri }  # PowerShell 7+
        $tag = ([string]$final).Split("/")[-1]
        if ($tag -match "^v[0-9]") { return $tag }
    } catch {}
    try {
        $resp = Invoke-RestMethod "https://api.github.com/repos/$RepoSlug/releases/latest" `
                                  -Headers @{ "User-Agent" = "squirm-installer" }
        return $resp.tag_name
    } catch {
        return $null
    }
}

$latest = $PinVersion
if (-not $latest) {
    Bold "▶ Resolving latest release"
    $latest = Resolve-LatestTag
    if (-not $latest) {
        Err "Could not resolve latest release tag from $RepoSlug."
        Err "  Set `$env:SQUIRM_VERSION = 'vX.Y.Z' to pin."
        exit 1
    }
}
if (-not $latest.StartsWith("v")) { $latest = "v$latest" }

# ── Detect installed version ──────────────────────────────────────────────
$installed = ""
$installedPkgJson = Join-Path $SquirmHome "package.json"
if (Test-Path $installedPkgJson) {
    try {
        $installed = (Get-Content $installedPkgJson -Raw | ConvertFrom-Json).version
    } catch {}
}
if (-not $Force -and $installed) {
    $latestSemver    = [version]($latest.TrimStart("v"))
    $installedSemver = [version]($installed.TrimStart("v"))
    if ($latestSemver -le $installedSemver) {
        Bold "✓ Up to date (installed $installed, latest $latest)"
        Dim  "  Set `$env:SQUIRM_FORCE = '1' to reinstall."
        exit 0
    }
    Dim "  update: $installed → $latest"
} else {
    Dim "  installing $latest"
}

# ── Download tarball + verify sha256 ─────────────────────────────────────
$tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) "squirm-install-$(Get-Random)"
New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null

$base = "https://github.com/$RepoSlug/releases/download/$latest"
$url  = "$base/squirm-$target.tar.gz"
$tar  = Join-Path $tmpRoot "squirm.tar.gz"

Bold "▶ Downloading $($url.Split('/')[-1])"
try {
    Invoke-WebRequest -Uri $url -OutFile $tar -UseBasicParsing
} catch {
    Err "download failed: $url"
    Err "  release may not have $target asset"
    exit 1
}

try {
    $sumUrl = "$url.sha256"
    $resp = Invoke-WebRequest -Uri $sumUrl -UseBasicParsing
    # .Content is byte[] when server sends application/octet-stream — decode.
    $sumTxt = if ($resp.Content -is [byte[]]) {
        [System.Text.Encoding]::ASCII.GetString($resp.Content)
    } else {
        [string]$resp.Content
    }
    $expected = ($sumTxt.Trim() -split '\s+')[0]
    $got = (Get-FileHash -Algorithm SHA256 -Path $tar).Hash.ToLower()
    if ($expected.ToLower() -ne $got) {
        Err "sha256 mismatch (expected $expected, got $got)"
        exit 1
    }
    Dim "  sha256 ok"
} catch {
    Dim "  sha256 file missing — skipping verify"
}

# ── Extract (tar.exe ships with Windows 10 1803+) ─────────────────────────
Bold "▶ Extracting"
Push-Location $tmpRoot
tar -xzf "squirm.tar.gz"
Pop-Location

$srcDir = Join-Path $tmpRoot $target
$binExe = Join-Path $srcDir "squirm.exe"
if (-not (Test-Path $binExe)) {
    Err "tarball missing $target\squirm.exe"
    exit 1
}

# ── Swap into place ───────────────────────────────────────────────────────
Bold "▶ Installing to $SquirmHome"
$parent = Split-Path $SquirmHome -Parent
if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }

# Sweep backup dirs left by earlier installs (a running squirm.exe can't be
# deleted at update time, only renamed — by now those locks are gone).
Get-ChildItem -Path $parent -Filter "$(Split-Path $SquirmHome -Leaf).old.*" -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue }

# A running squirm.exe locks deletion but allows renames — move the old dir
# aside, place the new one, then best-effort clean.
if (Test-Path $SquirmHome) {
    $backup = "$SquirmHome.old.$(Get-Random)"
    Move-Item -Force $SquirmHome $backup
    try { Remove-Item -Recurse -Force $backup -ErrorAction SilentlyContinue } catch {}
}
Move-Item -Force $srcDir $SquirmHome

Remove-Item -Recurse -Force $tmpRoot -ErrorAction SilentlyContinue

# ── Add to PATH: user (persistent) + current session (works right now) ───
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not $userPath) { $userPath = "" }
$paths = $userPath.Split(";") | Where-Object { $_ -ne "" }
if ($paths -notcontains $SquirmHome) {
    Bold "▶ Adding $SquirmHome to user PATH"
    $newPath = if ($userPath) { "$userPath;$SquirmHome" } else { $SquirmHome }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
}
$sessionPaths = $env:Path.Split(";") | Where-Object { $_ -ne "" }
if ($sessionPaths -notcontains $SquirmHome) {
    $env:Path = "$env:Path;$SquirmHome"
    Dim "  PATH updated for this session too — `squirm` works right away."
}

# ── Smoke test: the binary must actually run ──────────────────────────────
try {
    $v = & (Join-Path $SquirmHome "squirm.exe") --version 2>&1
    if ($LASTEXITCODE -ne 0) { throw "exit code $LASTEXITCODE`: $v" }
    Dim "  verified: squirm v$v"
} catch {
    Err "installed binary failed to run: $_"
    exit 1
}

Bold "✓ Installed $latest"
Write-Host "  squirm:  $(Join-Path $SquirmHome 'squirm.exe')"
Write-Host "  target:  $SquirmHome"
Write-Host ""
Dim "Run ``squirm`` (worm) or ``squirm rabbit`` to start."
Dim "First-run SmartScreen warning: click 'More info' → 'Run anyway'."
