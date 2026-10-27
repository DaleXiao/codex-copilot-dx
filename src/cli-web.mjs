import { startAdapter } from "./adapter.mjs";
import { defaultCopilotClient } from "./copilot.mjs";
import { createProfileRuntime } from "./profile-runtime.mjs";
import { createProfileModelRuntime } from "./profile-model-runtime.mjs";
import { createProviderRuntime } from "./provider-runtime.mjs";
import { createServiceControl } from "./service-control.mjs";
import { openDashboard } from "./browser-launch.mjs";
import { adapterBaseUrl, checkRunningAdapter } from "./running-adapter.mjs";
import { assertSafeAdapterHost, isLoopbackHost } from "./security.mjs";
import { closeHttpServer } from "./shutdown.mjs";

// Starts management without requesting sign-in or editing/launching an app.
export async function runWebCommand({ host = "127.0.0.1", port = 2026, env = process.env, home, output = console.log } = {}) {
  assertSafeAdapterHost(host, env);
  const baseUrl = adapterBaseUrl(isLoopbackHost(host) ? host : "127.0.0.1", port);
  const running = await checkRunningAdapter({ host, port });
  if (running.incompatible) throw new Error("Restart the updated CCDX service before opening the dashboard.");
  if (running.ok) { await openDashboard(baseUrl, { env, interactive: true });output(`Web UI: ${baseUrl}`);return; }
  let profile = createProfileRuntime({ home, codexClient: defaultCopilotClient });
  const models = createProfileModelRuntime({ home, env, codexClient: defaultCopilotClient, codexCredentialFingerprint: () => profile.codexCredentialFingerprint });
  const providers = createProviderRuntime({ home, env, corePort: port, githubClient: defaultCopilotClient,
    refreshGithubCatalog: () => models.refreshCodex({ strict: true }),
    githubRegistry: models.codexRegistry, githubClientConfigured: false, githubCredentialFingerprint: () => profile.codexCredentialFingerprint });
  const serviceControl = createServiceControl({ home, env, providerRuntime: providers });
  const server = await startAdapter(port, host, { providerRuntime: providers, codexModelRegistry: models.codexRegistry,
    dashboardOptions: { home, env, host, port, serviceControl, credentialsChanged: () => {
      defaultCopilotClient.invalidateCredentials();profile = createProfileRuntime({ home, codexClient: defaultCopilotClient });
    } } });
  let closing = false;
  const stop = () => { if (closing) return;closing = true;void closeHttpServer(server).catch(() => { server.closeAllConnections();server.close(); }); };
  server.ccdxWebClosed = new Promise(resolve => server.once("close", () => {
    process.removeListener("SIGINT", stop);process.removeListener("SIGTERM", stop);
    void providers.close().then(resolve, () => { output("Provider shutdown could not be verified.");resolve(); });
  }));
  process.once("SIGINT", stop);process.once("SIGTERM", stop);
  await openDashboard(baseUrl, { env, interactive: true });output(`Web UI: ${baseUrl}\nManagement service running. Ctrl+C stops it.`);
  return server;
}
