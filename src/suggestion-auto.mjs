import { pathToFileURL } from "node:url";

// Older configurations may still invoke this retired hook after an upgrade.
// Do not consume stdin, read session data, or request another model response.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write("{}\n");
}
