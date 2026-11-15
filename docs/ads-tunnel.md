# adopt-dont-shop: Loki and GlitchTip through a Cloudflare Tunnel

`idea logs ads` reads adopt-dont-shop's **staging** Loki, and `idea errors ads` reads its GlitchTip. Both run on the
ADS staging server and are not public: Loki is only on the Docker network (`loki:3100`), and GlitchTip is on the
server's loopback (`127.0.0.1:8000`, `glitchtip-web:8080` on the Docker network). Agent Idea reaches them through a
Cloudflare Tunnel, and Cloudflare Access lets through only requests that carry Agent Idea's service token.

```
Agent Idea Worker ──CF-Access-Client-Id/Secret──▶ Cloudflare Access ──▶ Tunnel ──▶ cloudflared (on the ADS server)
                                                                                     ├─▶ http://loki:3100
                                                                                     └─▶ http://glitchtip-web:8080
```

Until every step is done, both commands answer `501` ("ADS logs are not configured" / "ADS errors are not
configured"). Nothing in the adopt-dont-shop repo changes.

Below, `example.com` stands for a domain on the ideaSquared Cloudflare account. Pick two hostnames, for example
`ads-loki.example.com` and `ads-glitchtip.example.com`.

## 1. Create the tunnel (Cloudflare dashboard)

1. Zero Trust > Networks > Tunnels > **Create a tunnel** > Cloudflared. Name it `ads-staging`.
2. Copy the tunnel token from the install command it shows (the long string after `--token`). Treat it as a secret.
3. Add two **public hostnames** to the tunnel:

   | Public hostname | Service |
   | --- | --- |
   | `ads-loki.example.com` | `HTTP` `loki:3100` |
   | `ads-glitchtip.example.com` | `HTTP` `glitchtip-web:8080` |

   The service names are Docker names, because cloudflared runs on the same Docker network (next step).

## 2. Protect both hostnames with Cloudflare Access (before anything runs)

Do this before starting cloudflared. ADS's Loki has `auth_enabled: false`, so once the tunnel connects, the
hostname would serve raw logs to anyone until Access is in front of it.


1. Zero Trust > Access > Service auth > Service Tokens > **Create service token**. Name it `agent-idea`. Copy the
   **Client ID** and **Client Secret** now: the secret is shown once.
2. Zero Trust > Access > Applications > **Add an application** > Self-hosted. Name it `ads-staging-observability`
   and add both hostnames (`ads-loki.example.com`, `ads-glitchtip.example.com`), with no path, so the whole host is
   covered.
3. Add one policy: Action **Service Auth**, Include > Service Token > `agent-idea`. Add no Allow or Bypass policies:
   then nothing but that token gets through. (If staff should open GlitchTip in a browser through this hostname,
   add a separate Allow policy for their emails, and accept that it widens the door.)

Check it from any machine:

```bash
# Without the token: Access refuses (403, or a redirect to its login page).
curl -si https://ads-loki.example.com/loki/api/v1/labels | head -1

# With the token: Loki answers with its label names (expect service, env, level).
curl -s https://ads-loki.example.com/loki/api/v1/labels \
  -H "CF-Access-Client-Id: <client id>" -H "CF-Access-Client-Secret: <client secret>"
```

## 3. Run cloudflared on the ADS staging server

Only after step 2: check that opening the Loki hostname in a browser shows the Access login page, not Loki.


Run it as a container on the stack's Docker network, so it can reach `loki` and `glitchtip-web` by name. Loki has no
host port, so a cloudflared installed on the host could not reach it.

```bash
# Find the network the stack runs on (the one loki is attached to):
docker inspect "$(docker ps -qf name=loki)" -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}'

# Run cloudflared on it. Pin the image to a current release tag rather than latest.
docker run -d --name cloudflared-agent-idea --restart unless-stopped \
  --network <network from above> \
  cloudflare/cloudflared:<version> tunnel --no-autoupdate run --token <tunnel token>
```

The tunnel shows as **Healthy** in the dashboard once it connects. If GlitchTip is on a different network from Loki,
connect the container to that one too: `docker network connect <network> cloudflared-agent-idea`.

## 4. A GlitchTip API token

1. Open GlitchTip (for example over the existing SSH tunnel to `127.0.0.1:8000`) as a staff user.
2. Profile > Auth Tokens > **Create**. Give it `event:read` and `project:read` only, nothing that writes.
3. Note the **organization slug** and the **project slug** of the ADS staging project (Settings > Projects; both
   appear in the project's URL).

Check it through the tunnel:

```bash
curl -s "https://ads-glitchtip.example.com/api/0/projects/<org>/<project>/issues/?query=is:unresolved" \
  -H "CF-Access-Client-Id: <client id>" -H "CF-Access-Client-Secret: <client secret>" \
  -H "Authorization: Bearer <glitchtip token>" | head -c 300
```

## 5. Give Agent Idea the secrets and settings

The secrets, from a checkout of agent-idea (each command prompts for the value):

```bash
pnpm wrangler secret put ADS_ACCESS_CLIENT_ID       # the service token's Client ID
pnpm wrangler secret put ADS_ACCESS_CLIENT_SECRET   # the service token's Client Secret
pnpm wrangler secret put ADS_GLITCHTIP_TOKEN        # the GlitchTip API token
```

The hostnames and slugs are not secret. Set them in `wrangler.jsonc` and merge to `main` (a deploy replaces vars set
in the dashboard, so they must live in the file):

```jsonc
"vars": {
  "CF_ACCOUNT_ID": "…",
  "ADS_LOKI_URL": "https://ads-loki.example.com",
  "ADS_GLITCHTIP_URL": "https://ads-glitchtip.example.com",
  "ADS_GLITCHTIP_ORG": "<org slug>",
  "ADS_GLITCHTIP_PROJECT": "<project slug>"
}
```

## 6. Try it

```bash
idea logs ads --since 24             # the last day of staging logs, sanitised
idea logs ads --level error          # errors in the last hour
idea errors ads                      # the 10 busiest unresolved issues
idea errors ads --frames --limit 5   # with the latest event's stack frames, file:line only
```

| You see | It means |
| --- | --- |
| `ADS logs are not configured` / `ADS errors are not configured` (501) | A var is empty or a secret is missing. Logs need `ADS_LOKI_URL` and both Access secrets; errors need the GlitchTip URL, org, project and token, and both Access secrets. |
| `Loki could not be read` / `GlitchTip could not be read` (502) | The Worker got through to Cloudflare but not to the service: the tunnel is down, Access rejected the service token (check the policy is Service Auth for `agent-idea`), the GlitchTip token or slugs are wrong, or the service is down. Run the `curl` checks above. |
| `You need write access to ideaSquared/adopt-dont-shop` (403) | Your GitHub login cannot write to the repo. |

## Rotating

- Service token: create a new one, add it to the Access policy, `wrangler secret put` both values, then delete the
  old token.
- GlitchTip token: create a new one, `wrangler secret put ADS_GLITCHTIP_TOKEN`, delete the old one.
- Tunnel token: Zero Trust > Networks > Tunnels > `ads-staging` > refresh the token, then restart the container with
  the new one.
