// The headers that get a request through Cloudflare Access with a service token. Used for the sources that sit
// behind a Cloudflare Tunnel (adopt-dont-shop's Loki and GlitchTip).
export type AccessToken = { accessClientId: string; accessClientSecret: string };

export function accessHeaders(token: AccessToken): Record<string, string> {
  return { 'cf-access-client-id': token.accessClientId, 'cf-access-client-secret': token.accessClientSecret };
}
