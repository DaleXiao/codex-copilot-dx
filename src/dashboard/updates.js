(() => {
  const stable = value => typeof value === "string" && /^(0|[1-9]\d{0,14})\.(0|[1-9]\d{0,14})\.(0|[1-9]\d{0,14})$/.test(value) ? value : null;
  function installationCommand(platform, version, latestVersion) {
    const current = stable(version), latest = stable(latestVersion);
    if (latest && (!current || ([0, 1, 2].map(index => Number(latest.split(".")[index]) - Number(current.split(".")[index])).find(value => value !== 0) || 0) > 0)) version = latest;
    if (!stable(version)) return "";
    const base = `https://github.com/DaleXiao/codex-copilot-dx/releases/download/v${version}`;
    if (platform === "windows") return `$ccdxInstallDir = Join-Path ([IO.Path]::GetTempPath()) ("ccdx-install-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $ccdxInstallDir -ErrorAction Stop | Out-Null
try {
  $ccdxInstaller = Join-Path $ccdxInstallDir "install.ps1"
  Invoke-WebRequest -UseBasicParsing -Uri "${base}/install.ps1" -OutFile $ccdxInstaller -TimeoutSec 300 -ErrorAction Stop
  & $ccdxInstaller
} finally {
  Remove-Item -LiteralPath $ccdxInstallDir -Recurse -Force
}`;
    return `(
  set -e
  ccdx_install_dir="$(mktemp -d)"
  trap 'rm -rf "$ccdx_install_dir"' EXIT
  curl --fail --location --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 300 \\
    ${base}/install.sh \\
    --output "$ccdx_install_dir/install.sh"
  sh "$ccdx_install_dir/install.sh"
)`;
  }
  function create({ element, localize, navigator }) {
    let snapshot = null, platform = "macos";
    const date = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value.slice(0, 10) : null;
    function install() {
      const command = installationCommand(platform, snapshot?.current?.version, snapshot?.latest?.version);
      element("install-command").textContent = command;
      element("copy-install").disabled = !command;
      element("install-shell").textContent = platform === "windows" ? "Windows · PowerShell" : "macOS · Terminal";
      element("install-windows-policy").hidden = platform !== "windows";
    }
    function render(data) {
      snapshot = data;
      const checked = data.status === "checked", latest = stable(data.latest?.version), current = stable(data.current?.version);
      element("update-current-version").textContent = current ? `v${current}` : "—";
      const currentDate = date(data.current?.published_at), latestDate = date(data.latest?.published_at);
      localize(element("update-current-date"), currentDate ? "released_date" : "release_date_unknown", { date: currentDate });
      element("update-latest-row").hidden = !latest || checked && !data.update_available;
      localize(element("update-latest-row").querySelector("dt"), checked ? "available_update" : "last_known_version");
      element("update-latest-version").textContent = latest ? `v${latest}` : "—";
      localize(element("update-latest-date"), latestDate ? "released_date" : "release_date_unknown", { date: latestDate });
      localize(element("update-state"), checked ? data.update_available ? "new_version_available" : "already_latest" : data.status === "rate_limited" ? "update_rate_limited" : "update_check_failed");
      element("update-command-row").hidden = checked && !data.update_available;
      const time = typeof data.checked_at === "string" && Number.isFinite(Date.parse(data.checked_at)) ? new Date(data.checked_at).toLocaleString() : "—";
      localize(element("update-checked"), checked ? "update_checked_time" : "update_attempted_time", { time });
      install();
    }
    function state(value) {
      element("check-updates").disabled = Boolean(value.pending);
      localize(element("check-updates"), value.pending ? "checking_updates" : "check_updates");
      if (value.error) {
        render({ ...snapshot, status: "unavailable", checked_at: new Date().toISOString(), current: snapshot?.current || { version: stable(element("version").textContent.replace(/^v/, "")) } });
      }
    }
    for (const button of document.querySelectorAll("[data-install-platform]")) button.addEventListener("click", () => {
      platform = button.dataset.installPlatform;
      for (const item of document.querySelectorAll("[data-install-platform]")) item.setAttribute("aria-pressed", String(item === button));
      install();
    });
    for (const [button, target] of [["copy-update", "update-command"], ["copy-install", "install-command"]]) element(button).addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(element(target).textContent);localize(element("update-copy-note"), "copied"); }
      catch { localize(element("update-copy-note"), "update_copy_unavailable"); }
    });
    element("copy-install").disabled = true;
    return { render, state };
  }
  globalThis.ccdxDashboardUpdates = { create, installationCommand };
})();
