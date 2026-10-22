export const DASHBOARD_PATHS = new Set(["/", "/ui.css", "/theme.js", "/language.js", "/refresh.js", "/time.js", "/animation.js", "/status.js", "/activity.js", "/usage.js", "/ui.js", "/console.js", "/updates.js", "/icons.js", "/tools.js"]);
export const DASHBOARD_API_PATHS = new Set(["/_ccdx/ui/animation", "/_ccdx/ui/models/live", "/_ccdx/ui/usage", "/_ccdx/ui/auth", "/_ccdx/ui/providers", "/_ccdx/ui/settings", "/_ccdx/ui/m365/accounts", "/_ccdx/ui/updates", "/_ccdx/ui/account", "/_ccdx/ui/checks"]);

export function isOptionalRoute(method, pathname) {
  return DASHBOARD_API_PATHS.has(pathname) || pathname === "/mcp/image"
    || ((method === "GET" || method === "HEAD") && DASHBOARD_PATHS.has(pathname));
}

// Optional handlers load only on their own routes. Failure is contained by the
// shared HTTP dispatcher and cannot initialize or change core inference.
export function createOptionalRoutes(options = {}) {
  let imageMcpHandler = options.imageMcpHandler || null;
  let tools = null;
  return {
    dispose() { tools?.dispose(); },
    imageStats() { return imageMcpHandler?.stats?.(); },
    async handle(req, res, pathname) {
      if (DASHBOARD_API_PATHS.has(pathname)) {
        const { handleDashboardApi } = await import("./dashboard-api.mjs");
        if (["/_ccdx/ui/account", "/_ccdx/ui/checks"].includes(pathname)) {
          const { createDashboardTools } = await import("./dashboard-tools.mjs");
          tools ||= createDashboardTools(options.dashboardOptions);
        }
        return handleDashboardApi(req, res, pathname, { ...options.dashboardOptions, tools });
      }
      if ((req.method === "GET" || req.method === "HEAD") && DASHBOARD_PATHS.has(pathname)) {
        const { serveDashboard } = await import("./dashboard.mjs");
        return serveDashboard(req, res, pathname);
      }
      if (pathname === "/mcp/image") {
        if (imageMcpHandler) return imageMcpHandler(req, res);
        return import("./image-mcp.mjs").then(({ createImageMcpHandler }) => {
          imageMcpHandler ||= createImageMcpHandler({ localHostname: options.imageMcpHostname });
          return imageMcpHandler(req, res);
        });
      }
    },
  };
}
