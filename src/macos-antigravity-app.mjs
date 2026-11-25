import os from "node:os";
import path from "node:path";

export const macAntigravityBundles = {
  "Gemini.app": { identifier: "com.google.GeminiMacOS", executable: "Gemini", helper: "Contents/Helpers/agy" },
  "Antigravity.app": { identifier: "com.google.antigravity", executable: "Antigravity", helper: "Contents/Resources/bin/language_server" },
};
export const googleMacTeam = "EQHXZ8M8AV";

export function macAntigravityBundlePaths(home = os.homedir()) {
  const names=Object.keys(macAntigravityBundles);
  return [...names.map(name=>"/Applications/"+name),...names.map(name=>path.join(home,"Applications",name))];
}
