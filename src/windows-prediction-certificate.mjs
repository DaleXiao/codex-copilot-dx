import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { windowsPowerShellEnvironment } from "./native-prediction-windows.mjs";

// Explicit Windows setup only. Private keys use stdin, never command arguments,
// environment variables, compiler source, or the Windows certificate store.
export function windowsPredictionCertificate({ env = process.env, exec = execFileSync } = {}) {
  const ca = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const leaf = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const input = JSON.stringify({ ca: ca.privateKey.export({ format: "jwk" }), leaf: leaf.privateKey.export({ format: "jwk" }) });
  const command = path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const source = fileURLToPath(new URL("./windows-prediction-certificate.cs", import.meta.url));
  let certificates;
  try {
    const raw = exec(command, ["-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop';Add-Type -Path $env:CCDX_PREDICTION_CERTIFICATE_SOURCE -ReferencedAssemblies System.dll,System.Core.dll,System.Security.dll,System.Web.Extensions.dll;[CCDXPredictionCertificate]::Run()"],
    { env: { ...windowsPowerShellEnvironment(env), CCDX_PREDICTION_CERTIFICATE_SOURCE: source }, input,
      encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true });
    certificates = JSON.parse(raw);
    for (const name of ["ca", "cert"]) {
      if (typeof certificates?.[name] !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(certificates[name])
        || certificates[name].length > 16 * 1024) throw new Error();
    }
  } catch {
    // Do not expose child-process diagnostics: they can contain private input.
    throw new Error("Windows prediction certificate generation failed; verify Windows PowerShell, .NET Framework 4.7.2 or later and current-user policy");
  }
  const pem = value => `-----BEGIN CERTIFICATE-----\n${value.match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`;
  return { ca: pem(certificates.ca), cert: pem(certificates.cert),
    key: leaf.privateKey.export({ type: "pkcs8", format: "pem" }) };
}
