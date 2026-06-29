// Self-update. `squirm update` checks the latest GitHub release and, if a newer
// one exists, re-runs the platform installer — install.sh via bash on
// macOS/Linux, install.ps1 via PowerShell on Windows. Mirrors loop's upgrade.

import { spawnSync } from "node:child_process";

const REPO_SLUG = "notshekhar/squirm";
const INSTALL_SH = `https://raw.githubusercontent.com/${REPO_SLUG}/main/install.sh`;
const INSTALL_PS1 = `https://raw.githubusercontent.com/${REPO_SLUG}/main/install.ps1`;
const RELEASES_API = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`;

function semverGt(a: string, b: string): boolean {
    const norm = (v: string) =>
        v
            .replace(/^v/, "")
            .split(".")
            .map((n) => Number.parseInt(n, 10) || 0);
    const [a1, a2, a3] = norm(a);
    const [b1, b2, b3] = norm(b);
    if (a1 !== b1) return a1 > b1;
    if (a2 !== b2) return a2 > b2;
    return a3 > b3;
}

async function fetchLatestTag(): Promise<string | null> {
    // The releases/latest redirect isn't subject to the anonymous GitHub API
    // rate limit (60 req/h/IP) that bites CI and shared networks.
    try {
        const r = await fetch(`https://github.com/${REPO_SLUG}/releases/latest`, {
            method: "HEAD",
            redirect: "follow",
        });
        const tag = r.url.split("/").pop() ?? "";
        if (/^v\d/.test(tag)) return tag;
    } catch {}
    try {
        const r = await fetch(RELEASES_API, { headers: { accept: "application/vnd.github+json" } });
        if (!r.ok) return null;
        const j = (await r.json()) as { tag_name?: string };
        return j.tag_name ?? null;
    } catch {
        return null;
    }
}

export async function runUpdate(version: string, opts: { force?: boolean } = {}): Promise<void> {
    process.stdout.write(`▶ Checking for updates (current v${version})…\n`);
    const latest = await fetchLatestTag();
    if (!opts.force && latest) {
        if (!semverGt(latest, `v${version}`)) {
            process.stdout.write(`✓ Up to date (latest ${latest})\n`);
            return;
        }
        process.stdout.write(`▶ Updating ${version} → ${latest}\n`);
    } else if (!latest) {
        process.stdout.write("▶ Could not query latest release; running installer anyway.\n");
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (opts.force) env.SQUIRM_FORCE = "1";

    // Windows: invoke the PowerShell installer. macOS/Linux: bash.
    const isWin = process.platform === "win32";
    const shell = isWin ? "powershell" : "bash";
    const args = isWin
        ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `irm ${INSTALL_PS1} | iex`]
        : ["-c", `curl -fsSL ${INSTALL_SH} | bash`];

    const r = spawnSync(shell, args, { stdio: "inherit", env });
    process.exit(r.status ?? 1);
}
