// A stable format revision, not the CCDX package version. Existing Apps must
// load it once; later adapter upgrades keep the same URL, port and trust.
export const PREDICTION_PAC_PATH = "/proxy.pac?v=2";

export function isPredictionPacUrl(value) {
  const match = typeof value === "string" && /^http:\/\/127\.0\.0\.1:(\d{1,5})\/proxy\.pac(?:\?v=2)?$/.exec(value);
  return Boolean(match && Number(match[1]) >= 1024 && Number(match[1]) <= 65535);
}

// Chromium caches failed proxy endpoints separately from the PAC URL. A fresh
// loopback-only name lets its next resolution retry a restored listener without
// waiting for that failed endpoint's retry cache. No timer, DNS lookup in Node,
// new port, process, or system proxy mutation is involved.
export function predictionProxyExpression(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid prediction proxy port");
  return `'PROXY 127.0.0.1:${port}; PROXY ccdx-'+Math.floor(Date.now()/10000)+'.localhost:${port}'`;
}
