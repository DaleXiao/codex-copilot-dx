export const DASHBOARD_PATHS = new Set(["/", "/ui.css", "/theme.js", "/language.js", "/refresh.js", "/live.js", "/time.js", "/animation.js", "/status.js", "/view-boundary.js", "/activity.js", "/flow.js", "/usage.js", "/context.js", "/ui.js", "/console.js", "/updates.js", "/preferences.js", "/icons.js", "/disclosure.js", "/tools.js", "/connections.js", "/privacy.js"]);
export const DASHBOARD_API_PATHS = new Set(["/_ccdx/ui/animation", "/_ccdx/ui/models/live", "/_ccdx/ui/usage", "/_ccdx/ui/auth", "/_ccdx/ui/providers", "/_ccdx/ui/settings", "/_ccdx/ui/m365/accounts", "/_ccdx/ui/updates", "/_ccdx/ui/account", "/_ccdx/ui/checks", "/_ccdx/ui/connections", "/_ccdx/ui/context", "/_ccdx/ui/privacy"]);

export function isOptionalRoute(method, pathname) {
  return DASHBOARD_API_PATHS.has(pathname) || pathname === "/mcp/image"
    || ((method === "GET" || method === "HEAD") && DASHBOARD_PATHS.has(pathname));
}

// Optional handlers load only on their own routes. Failure is contained by the
// shared HTTP dispatcher and cannot initialize or change core inference.
export function createOptionalRoutes(options = {}) {
  let imageMcpHandler = options.imageMcpHandler || null;
  let tools = null;
  let pending = 0;
  return {
    dispose() { tools?.dispose(); },
    busy: () => pending > 0 || tools?.busy?.() === true,
    exportState() { const images = imageMcpHandler?.exportState?.() || [];return { images, bytes: (imageMcpHandler?.referenceBytes?.() || 0) + images.length * 64 }; },
    async importState(state) {
      if (!state || !Array.isArray(state.images)) throw new Error("Invalid optional-service handoff");
      if (state.images.length) {
        const { createImageMcpHandler } = await import("./image-mcp.mjs");
        imageMcpHandler ||= createImageMcpHandler({ localHostname: options.imageMcpHostname });
        imageMcpHandler.importState(state.images);
      }
    },
    imageStats() { return imageMcpHandler?.stats?.(); },
    async handle(req, res, pathname) {
      pending++;
      try {
      if (DASHBOARD_API_PATHS.has(pathname)) {
        const { handleDashboardApi } = await import("./dashboard-api.mjs");
        if (["/_ccdx/ui/account", "/_ccdx/ui/checks"].includes(pathname)) {
          const { createDashboardTools } = await import("./dashboard-tools.mjs");
          tools ||= createDashboardTools(options.dashboardOptions);
        }
        return await handleDashboardApi(req, res, pathname, { ...options.dashboardOptions, tools });
      }
      if ((req.method === "GET" || req.method === "HEAD") && DASHBOARD_PATHS.has(pathname)) {
        const { serveDashboard } = await import("./dashboard.mjs");
        return await serveDashboard(req, res, pathname);
      }
      if (pathname === "/mcp/image") {
        if (imageMcpHandler) return await imageMcpHandler(req, res);
        return await import("./image-mcp.mjs").then(({ createImageMcpHandler }) => {
          imageMcpHandler ||= createImageMcpHandler({ localHostname: options.imageMcpHostname });
          return imageMcpHandler(req, res);
        });
      }
      } finally { pending--; }
    },
  };
}
