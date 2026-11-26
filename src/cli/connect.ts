/** The address people's Claude Code connects to, without a trailing slash. */
export function publicUrl(): string {
  const raw = process.env.OPSDESK_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
  return raw.replace(/\/+$/, "");
}

/** The one line a person pastes into their terminal to add opsdesk to Claude Code. */
export function connectCommand(url: string, token: string, name = "opsdesk"): string {
  return `claude mcp add --transport http ${name} ${url}/mcp --header "Authorization: Bearer ${token}"`;
}
