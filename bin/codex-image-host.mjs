#!/usr/bin/env node
import path from "node:path";
import { runCodexImageHost } from "../src/codex-image-host.mjs";

const args = process.argv.slice(2), split = args.indexOf("--");
const hostArgs = args.slice(0, split), argv = args.slice(split + 1);
const codex = hostArgs[hostArgs.indexOf("--codex") + 1];
const baseUrl = hostArgs[hostArgs.indexOf("--base-url") + 1];
if (split < 0 || !path.isAbsolute(codex || "") || !baseUrl) { console.error("Invalid CCDX image host launch configuration");process.exit(2); }
try { process.exitCode = await runCodexImageHost({ codex, argv, baseUrl }); }
catch { console.error("CCDX image host could not start the configured Codex runtime");process.exitCode = 1; }
