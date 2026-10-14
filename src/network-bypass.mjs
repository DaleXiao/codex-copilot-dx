// Pure matching shared by Node and the generated PAC. CIDRs apply to URL IP
// literals, as in Chromium's manual bypass rules; they never trigger DNS.
export function literalAddress(value) {
  var text = String(value).toLowerCase().replace(/^\[|\]$/g, "");
  var ipv4 = function (s) {
    if (!/^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}$/.test(s)) return null;
    var bytes = s.split(".").map(Number);
    return bytes.every(function (n) { return n <= 255; }) ? bytes : null;
  };
  if (text.indexOf(":") < 0) return ipv4(text);
  if (text.indexOf(".") >= 0) {
    var last = text.lastIndexOf(":"), tail = ipv4(text.slice(last + 1));
    if (!tail) return null;
    text = text.slice(0, last + 1) + (tail[0] * 256 + tail[1]).toString(16) + ":" + (tail[2] * 256 + tail[3]).toString(16);
  }
  if (!/^[0-9a-f:]+$/.test(text) || text.indexOf(":::") >= 0) return null;
  var halves = text.split("::");
  if (halves.length > 2) return null;
  var left = halves[0] ? halves[0].split(":") : [], right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  var missing = 8 - left.length - right.length;
  if (halves.length === 1 ? left.length !== 8 : missing < 1) return null;
  var groups = left.slice();
  if (halves.length === 2) for (var i = 0; i < missing; i++) groups.push("0");
  groups = groups.concat(right);
  var result = [];
  for (var j = 0; j < groups.length; j++) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[j])) return null;
    var number = parseInt(groups[j], 16);result.push(number >>> 8, number & 255);
  }
  return result;
}

export function compileBypassRules(values) {
  return values.map(raw => {
    if (raw.includes("/")) {
      const parts = raw.split("/"), address = literalAddress(parts[0]);
      if (parts.length !== 2 || !address || /[\[\]]/.test(parts[0]) || !/^\d{1,3}$/.test(parts[1]) || Number(parts[1]) > address.length * 8) {
        throw Object.assign(new Error("Invalid proxy bypass CIDR rule; existing routes were preserved"), { code: "proxy_bypass_invalid" });
      }
      return { address, prefix: Number(parts[1]), port: null };
    }
    let host = raw, port = null;
    const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(raw);
    const suffix = !literalAddress(raw) && /^(.*):(\d+)$/.exec(raw);
    if (bracket) { host = bracket[1];port = bracket[2] ? Number(bracket[2]) : null; }
    else if (suffix) { host = suffix[1];port = Number(suffix[2]); }
    if ((port !== null && (port < 1 || port > 65535)) || /[\s/@?#\\\[\]]/.test(host) || !host) {
      throw Object.assign(new Error("Invalid proxy bypass host or port; existing routes were preserved"), { code: "proxy_bypass_invalid" });
    }
    const address = literalAddress(host);
    if (bracket && address?.length !== 16) throw Object.assign(new Error("Invalid proxy bypass IPv6 literal; existing routes were preserved"), { code: "proxy_bypass_invalid" });
    if (host.includes(":") && !address) throw Object.assign(new Error("Invalid proxy bypass IP literal; existing routes were preserved"), { code: "proxy_bypass_invalid" });
    return address ? { address, prefix: address.length * 8, port }
      : { host, port, ...(host.includes("*") ? { expression: "^" + host.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*") + "$" } : {}) };
  });
}

export function matchesBypass(hostname, port, rules, excludeSimple) {
  var host = hostname.toLowerCase().replace(/^\[|\]$/g, ""), address = literalAddress(host);
  if (host === "localhost" || host === "127.0.0.1" || (address && address.length === 16 && address.slice(0, 15).every(function (n) { return n === 0; }) && address[15] === 1)
    || (excludeSimple && !address && host.indexOf(".") < 0)) return true;
  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i];
    if (rule.port !== null && rule.port !== Number(port)) continue;
    if (rule.address) {
      if (!address || address.length !== rule.address.length) continue;
      var equal = true;
      for (var index = 0; index < Math.ceil(rule.prefix / 8); index++) {
        var mask = (255 << Math.max(0, 8 - (rule.prefix - index * 8))) & 255;
        if ((address[index] & mask) !== (rule.address[index] & mask)) { equal = false;break; }
      }
      if (equal) return true;
    } else if (rule.expression ? new RegExp(rule.expression).test(host)
      : host === rule.host.replace(/^\*?\./, "") || host.slice(-(rule.host.replace(/^\*?\./, "").length + 1)) === "." + rule.host.replace(/^\*?\./, "")) return true;
  }
  return false;
}

export function bypassPacSource() { return literalAddress.toString() + "\n" + matchesBypass.toString(); }
