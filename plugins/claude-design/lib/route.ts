// Routing Claude through the bb server from a Mac.
//
// claude.ai refuses some countries, and bb's built-in browser runs on the
// user's Mac, so the Mac's own address is what claude.ai sees. This module
// builds the two pieces that send only Claude's traffic through the server
// instead:
//   - a PAC rule, served by this plugin, that sends Claude's domains to a
//     local SOCKS proxy and everything else direct;
//   - a macOS setup command: a login item (launchd) that keeps an SSH tunnel
//     to the server open — SOCKS for Claude's traffic, plus a local forward
//     through which the Mac fetches the PAC rule — and the system setting
//     that points network services at that rule.

/** Hosts (and their subdomains) that go through the server. */
export const ROUTED_DOMAINS = [
  "claude.ai",
  "claude.com",
  "anthropic.com",
  "claudeusercontent.com",
  "claudemcpcontent.com",
  "claude.site",
  // Cloudflare's bot check must see the same address as claude.ai.
  "challenges.cloudflare.com",
] as const;

export const SOCKS_PORT = 39891;
export const PAC_PORT = 39892;
export const PAC_ROUTE = "/proxy.pac";
export const LAUNCHD_LABEL = "app.bb.claude-design-route";

/** `user@host` or `host`, with an optional `-p`-free port suffix left to ssh config. */
const SSH_TARGET = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$/;

export function isSshTarget(value: string): boolean {
  return SSH_TARGET.test(value) && value.length <= 255;
}

export function pacScript(): string {
  const list = ROUTED_DOMAINS.map((domain) => JSON.stringify(domain)).join(", ");
  return [
    "// Claude Design for bb: Claude's domains go through the bb server's SSH tunnel.",
    "function FindProxyForURL(url, host) {",
    "  host = host.toLowerCase();",
    `  var domains = [${list}];`,
    "  for (var i = 0; i < domains.length; i++) {",
    "    var domain = domains[i];",
    '    if (host === domain || dnsDomainIs(host, "." + domain)) {',
    `      return "SOCKS5 127.0.0.1:${SOCKS_PORT}; SOCKS 127.0.0.1:${SOCKS_PORT}";`,
    "    }",
    "  }",
    '  return "DIRECT";',
    "}",
    "",
  ].join("\n");
}

/** The PAC address as the Mac sees it: through the tunnel's local forward. */
export function pacUrl(pluginId: string): string {
  return `http://127.0.0.1:${PAC_PORT}/api/v1/plugins/${pluginId}/http${PAC_ROUTE}`;
}

function plist(target: string, serverPort: number): string {
  const args = [
    "/usr/bin/ssh",
    "-N",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2",
    "-D", `127.0.0.1:${SOCKS_PORT}`,
    "-L", `127.0.0.1:${PAC_PORT}:127.0.0.1:${serverPort}`,
    target,
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>Label</key><string>${LAUNCHD_LABEL}</string>`,
    "<key>ProgramArguments</key><array>",
    ...args.map((arg) => `<string>${arg}</string>`),
    "</array>",
    "<key>RunAtLoad</key><true/>",
    "<key>KeepAlive</key><true/>",
    "<key>ThrottleInterval</key><integer>10</integer>",
    "</dict></plist>",
  ].join("\n");
}

/**
 * One paste into Terminal on the Mac. Network services that already use a
 * different auto-proxy (a corporate PAC, say) are left alone and reported.
 */
export function installCommand(input: {
  target: string;
  serverPort: number;
  pluginId: string;
}): string {
  const url = pacUrl(input.pluginId);
  const file = `$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`;
  return [
    `mkdir -p "$HOME/Library/LaunchAgents" && cat > "${file}" <<'PLIST'`,
    plist(input.target, input.serverPort),
    "PLIST",
    `launchctl bootout "gui/$(id -u)/${LAUNCHD_LABEL}" 2>/dev/null; launchctl bootstrap "gui/$(id -u)" "${file}"`,
    `networksetup -listallnetworkservices | tail -n +2 | grep -v '^\\*' | while IFS= read -r s; do`,
    `  current=$(networksetup -getautoproxyurl "$s" | awk -F': ' '/^URL/{print $2}')`,
    `  enabled=$(networksetup -getautoproxyurl "$s" | awk -F': ' '/^Enabled/{print $2}')`,
    `  if [ "$enabled" = "Yes" ] && [ "$current" != "${url}" ]; then echo "skipped $s: it already uses $current"; continue; fi`,
    `  sudo networksetup -setautoproxyurl "$s" "${url}" && echo "routed $s"`,
    "done",
  ].join("\n");
}

export function uninstallCommand(pluginId: string): string {
  const url = pacUrl(pluginId);
  return [
    `launchctl bootout "gui/$(id -u)/${LAUNCHD_LABEL}" 2>/dev/null; rm -f "$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"`,
    `networksetup -listallnetworkservices | tail -n +2 | grep -v '^\\*' | while IFS= read -r s; do`,
    `  if networksetup -getautoproxyurl "$s" | grep -qF "${url}"; then sudo networksetup -setautoproxystate "$s" off && echo "restored $s"; fi`,
    "done",
  ].join("\n");
}
