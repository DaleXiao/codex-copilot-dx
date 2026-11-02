import { execFileSync } from "node:child_process";
const runId = process.env.CCDX_CI_RUN, repository = process.env.GITHUB_REPOSITORY;
if (!/^\d+$/.test(runId || "") || !/^[\w.-]+\/[\w.-]+$/.test(repository || "")) throw Error("Supply the complete CI run and repository");
const api = route => JSON.parse(execFileSync("gh", ["api", `repos/${repository}/${route}`], { encoding: "utf8" }));
const run = api(`actions/runs/${runId}`), sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (run.head_sha !== sha || run.event !== "push" || run.head_branch !== "main" || run.path !== ".github/workflows/ci.yml" || run.status !== "completed" || run.conclusion !== "success") throw Error("Release requires successful full CI on these exact source bytes");
const jobs = api(`actions/runs/${runId}/jobs?per_page=100`);
if (jobs.total_count !== jobs.jobs.length || jobs.jobs.some(job => job.conclusion !== "success")) throw Error("CI jobs are incomplete or did not all succeed");
const required = ["codex-client", "privacy-native-windows",
  ...["22.15.0", "24.x"].flatMap(node => [`macos (${node})`, `windows-prediction (${node})`]),
  ...["macos-latest", "windows-latest"].flatMap(os => ["prediction-browsers", "npm12-install", "bootstrap"].map(job => `${job} (${os})`)),
  ...["chromium", "webkit"].flatMap(engine => ["green", "klein", "pink", "mono"].map(palette => `dashboard-browsers (${engine}, ${palette})`)),
  ...[["macos-latest", "darwin-arm64"], ["macos-15-intel", "darwin-x64"], ["windows-latest", "win32-x64"], ["windows-11-arm", "win32-arm64"]]
    .map(([os, target]) => `runtime-packages / runtime (${os}, ${target})`)];
for (const name of required) if (!jobs.jobs.some(job => job.name === name)) throw Error(`Missing release gate: ${name}`);
if (process.env.CCDX_RESUME_RUN) {
  if (!/^\d+$/.test(process.env.CCDX_RESUME_RUN)) throw Error("Invalid original publication run");
  const original = api(`actions/runs/${process.env.CCDX_RESUME_RUN}`);
  if (original.path !== ".github/workflows/publish.yml" || original.event !== "workflow_dispatch" || original.status !== "completed") throw Error("Resume requires an original completed publication run");
}
console.log(JSON.stringify({ commit: sha, ci_run: runId, jobs: jobs.jobs.length, passed: true }));
