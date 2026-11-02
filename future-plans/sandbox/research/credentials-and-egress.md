# Credentials outside the sandbox and egress allowlisting for pi

Research date: 2026-11-02

Scope: keep model-provider tokens (API keys, OAuth access and refresh tokens) out of a sandbox that runs the whole `pi` process (pi-coding-agent
1.5.0, pi-ai 1.5.0), while pi still calls models; enforce a central, deny-by-default egress allowlist. Pi facts cite files under
`node_modules/@earendil-works/` (abbreviated `ca/` = `pi-coding-agent/`, `ai/` = `pi-ai/dist/`). Note: pi now lives at github.com/earendil-works/pi
(docs link there, `ca/docs/security.md` last section); badlogic/pi-mono was the old home.

Threat model in one line: anything inside the sandbox (pi, its extensions, MCP servers, `bash` children) is attacker-controlled after a prompt
injection. "Token outside" means the attacker can at most *use* the credential through the allowed path, never *carry it away*.

## A. Credential injection patterns

### A1. Forward HTTP(S) proxy that terminates TLS and injects auth (MITM injector)

Mechanism: sandbox has no route except to a proxy; `HTTPS_PROXY` points at it; sandbox trusts a proxy CA; for allowlisted hosts the proxy terminates
TLS, replaces a placeholder (or adds) `Authorization` / `x-api-key`, re-encrypts upstream with real cert verification. Non-matching hosts are
CONNECT-tunnelled opaquely (SNI/hostname checked) or refused.

Existing implementations:
- Docker Sandboxes (`sbx`): "the host-side proxy injects authentication headers into outbound HTTP requests. The raw credential values never enter the
  VM" (https://docs.docker.com/ai/sandboxes/security/, fetched 2026-11-02). Agent "sees a sentinel value"; proxy "swaps the sentinel for the real
  credential ... after the request has left the microVM" (https://docs.docker.com/ai/sandboxes/architecture/, 2026-11-02). `sbx secret set-custom
  --host <domain> --env <VAR>` gives a placeholder like `sbx-cs-<rand>`; "Replacement applies only to HTTP request headers, not request bodies";
  `--ref` (1Password, AWS Secrets Manager) or `--command` sources cached 55 min; built-in `anthropic` service hosts: api.anthropic.com,
  console.anthropic.com, claude.ai, mcp-proxy.anthropic.com; `openai`: api.openai.com, openai.com, chatgpt.com; proxy "handles OAuth token refresh";
  OAuth `passthrough: true` sends the real token in (https://docs.docker.com/ai/sandboxes/configuration/credentials/, 2026-11-02). Only the forward
  proxy injects; transparent path does not (https://docs.docker.com/ai/sandboxes/security/isolation/, search 2026-11-02). Per-session "Docker
  Sandboxes Proxy CA" (seen in a user-filed issue, not in the docs) trusted in VM, exposed as `$PROXY_CA_CERT_B64`; nested `docker build` does not inherit it
  (https://github.com/docker/sbx-releases/issues/322, 2026). Pi's own doc uses this with placeholder `sk-ant-oat01-{rand}` for Claude Pro/Max
  (`ca/docs/containerization.md:91-98`) and warns not to `/login` inside (`:86`).
- NVIDIA OpenShell: all egress via a CONNECT proxy in a per-sandbox netns with veth, OPA policy; on TLS ClientHello the proxy terminates with a
  per-sandbox ephemeral CA, enabling L7 inspection and placeholder credential rewriting; `tls: skip` disables both per endpoint
  (https://docs.nvidia.com/openshell/latest/security, 2026-11-02). Issue #896 (closed 2026-09-03, filed 2026-04) describes injection as endpoint-blind, placeholders resolved for any destination, and proposes (credential, endpoint, binary) scoping; OpenShell's inference docs now describe endpoint binding (`credential_endpoint_mismatch`)
  (https://github.com/NVIDIA/OpenShell/issues/896). Apache-2.0 (https://github.com/nvidia/openshell).
- Anthropic `srt` (sandbox-runtime): host HTTP proxy + SOCKS5; default no TLS interception; opt-in experimental `network.tlsTerminate` terminates TLS
  in-process so `filterRequest` and "credential hooks" apply, with MITM CA bundle given to the sandbox, `excludeDomains` for mTLS/pinning,
  `refuseOpaqueTunnels` (https://github.com/anthropics/sandbox-runtime, README fetched 2026-11-02, Apache-2.0, ~6.9k stars).
- Gondolin (earendil-works, same authors as pi): host generates `GONDOLIN_SECRET_<hex>` placeholders in guest env, substitutes on host during HTTP
  interception via local CA, each secret bound to a host allowlist, placeholder sent to other hosts is blocked
  (https://deepwiki.com/earendil-works/gondolin/2.2.1-secret-management, secondary; primary docs/secrets.md not fetched). Pi's doc notes the Gondolin
  pi extension runs pi on the host and only tools in the VM, and env vars leak into the VM (`ca/docs/containerization.md:153-157`).
- mitmproxy: a ~30 line addon (`request(flow)`: if `flow.request.host in ALLOW`, set header from a host-side secret store; else `flow.kill()`) is the
  cheapest DIY; supports SSE streaming with `stream_large_bodies`/`flow.response.stream = True` and WebSocket flows. MIT license.
- Envoy (forward proxy with `dynamic_forward_proxy` + TLS termination via SDS-generated certs, Lua or ext_authz to set headers): possible but heavy;
  ext_authz can return headers to add. Squid `ssl_bump` + `request_header_add` works for static keys only.
- Fly.io Tokenizer: proxy holding a Curve25519 private key; clients send *sealed* (encrypted) secrets in a header, proxy unseals and injects, can
  HMAC-sign; SSOkenizer runs OAuth and returns sealed tokens; requests without sealed secrets blocked by default
  (https://github.com/superfly/tokenizer, https://fly.io/blog/tokenized-tokens/, Apache-2.0). Sealed token inside sandbox is useless off-proxy: good
  for per-user attribution.
- Commercial "agent vault" variants: Infisical Agent Vault sidecar for Modal
  (https://infisical.com/docs/documentation/platform/agent-vault/guides/modal.md), Blaxel
  (https://blaxel.ai/blog/prompt-injection-defense-credential-separation), 1Password via sbx `--ref`.

Properties:
- OAuth refresh: proxy (host) holds refresh token and refreshes; sandbox placeholder never expires. Requires the proxy to know each provider's token
  endpoint (Docker does it per kit).
- SigV4 (Bedrock): placeholder substitution cannot work (signature covers headers/body). Proxy must strip and re-sign. Alternative: Bedrock API keys
  (`AWS_BEARER_TOKEN_BEDROCK`, bearer header) are substitutable.
- Vertex: GCP access token is a bearer; proxy mints from ADC/WIF on host and injects `Authorization: Bearer`. Google AI Studio: `x-goog-api-key`
  header (or `?key=` query, which header-only replacement misses).
- Streaming SSE: fine if proxy streams (no buffering). WebSocket (Codex/ChatGPT backend): injection must happen on the HTTP Upgrade request.
- Latency: one extra TLS handshake per connection, a few ms on loopback/vsock; negligible vs model TTFT.
- CA trust: sandbox must trust the MITM CA. Node: `NODE_EXTRA_CA_CERTS`; system store (`update-ca-certificates`); Python
  `REQUESTS_CA_BUNDLE`/`SSL_CERT_FILE`/`PIP_CERT`; git `http.sslCAInfo`; cargo uses system/curl store. Certificate-pinning clients break unless
  tunnelled.
- Exfiltration: sandbox can read only placeholders. It can still spend budget through the proxy (any request to an allowlisted model host gets the
  real key). It can send a placeholder to an attacker host only if the injector is endpoint-blind (OpenShell #896); binding secrets to hosts
  (Gondolin, sbx `--host`) prevents that. It cannot read the proxy's memory if the proxy runs outside the VM/namespace boundary (host or separate
  container). If the proxy is a process in the *same* container or same macOS user without a sandbox profile, the key is readable: the proxy must sit
  across the boundary.

### A2. LLM gateway / reverse proxy via baseUrl with a dummy key

Mechanism: pi's provider `baseUrl` points at a gateway (`https://llm-gw.corp/anthropic`); sandbox holds a gateway credential (virtual key) or nothing;
gateway holds provider keys and translates/forwards. No TLS interception needed: gateway has a real cert (or plain HTTP on a private hop).

Options:
- LiteLLM proxy (MIT core, enterprise features paid): virtual keys with per-key budgets/models, spend logs; native Anthropic `/v1/messages` for Claude
  Code with `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN=<virtual key>` (https://docs.litellm.ai/docs/proxy/client_setup/claude_code, 2026-11-02);
  provider pass-through routes for Anthropic, Vertex, Bedrock with cost tracking (https://docs.litellm.ai/docs/proxy/pass_through_cost_tracking).
  Response headers `x-litellm-response-cost`, `x-litellm-key-spend`, upstream headers re-emitted with `llm_provider-` prefix
  (https://docs.litellm.ai/docs/proxy/response_headers, 2026-11-02). Supply chain: PyPI 1.82.7/1.82.8 shipped credential-stealing malware on
  2026-03-24, official Docker image unaffected (https://www.netspi.com/blog/executive-blog/ai-ml-pentesting/litellm-supply-chain-compromise/). A
  gateway is the single place holding every key: pin images, isolate it.
- Envoy AI Gateway, now "Agent Router, formerly Envoy AI Gateway" (https://theagentrouter.ai/docs/capabilities/llm-integrations/connect-providers,
  2026-11-02): BackendSecurityPolicy types APIKey, AWSCredentials (IRSA/Pod Identity/credentials file), AzureCredentials, GCPCredentials (ADC, SA key,
  WIF). Native Anthropic, Anthropic-on-Vertex (native messages endpoint). Apache-2.0, Kubernetes-centric.
- Cloudflare AI Gateway: BYOK keys stored in dashboard, client must still send `cf-aig-authorization`, alias via `cf-aig-byok-alias`
  (https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/, 2026-11-02). Gateway token is account-scoped (secondary:
  https://daleseo.com/cloudflare-ai-gateway/). Pi has a built-in `cloudflare-ai-gateway` provider (`ca/docs/providers.md`, "Cloudflare AI Gateway"
  section) and pi-ai treats `cf-aig-authorization` as request auth (`ai/api/anthropic-messages.js:174-179`, `ai/api/openai-completions.js:38`).
- Bifrost (maximhq, Apache-2.0, Go): virtual keys with budgets/rate limits/model restrictions at customer/team/key level; vendor claims ~11-15
  microseconds overhead (https://github.com/soitun/bifrost fork, dev.to vendor posts; unverified).
- Portkey OSS gateway (MIT), Kong AI Gateway (Kong OSS Apache-2.0; AI plugins partly enterprise), TensorZero (Apache-2.0, not verified), OpenRouter
  and Vercel AI Gateway (hosted; per-key limits; pi has built-in providers for both, `ai/providers/openrouter.js`,
  `ai/providers/vercel-ai-gateway.js`). Earendil's own Radius gateway (`ca/docs/providers.md`, "Radius", alpha, OAuth login to gateway).
- OpenShell inference routing: sandbox calls `https://inference.local`; router strips caller `Authorization`, forwards a per-provider header allowlist
  (Anthropic: `anthropic-version`, `anthropic-beta`), injects backend creds, rewrites model; gateway-wide config; SDKs needing a non-empty key can
  pass `unused` (https://docs.nvidia.com/openshell/latest/inference/index.html, search 2026-11-02). Pi doc points here
  (`ca/docs/containerization.md:151`).

Properties:
- OAuth: gateways generally do not support consumer subscription OAuth (Claude Pro/Max, ChatGPT). LiteLLM has a "Claude Code Max subscription"
  tutorial forwarding the client's OAuth token (https://docs.litellm.ai/docs/tutorials/claude_code_max_subscription.md), which puts the token back in
  the client: violates requirement 1. Policy: Anthropic terms (Feb 2026) say subscription OAuth tokens are only for Claude Code and Claude.ai;
  third-party harness use is a ToS violation, technically enforced from Jan/Apr 2026
  (https://www.theregister.com/software/2026/02/20/anthropic-clarifies-ban-on-third-party-tool-access-to-claude/5014546, secondary sources for the
  April date). For an enterprise, assume API keys / cloud accounts only.
- Provider-specific auth: best coverage. Gateway signs SigV4, mints GCP/Azure AD tokens, refreshes them; sandbox speaks a simple bearer.
- Streaming: all listed gateways stream SSE. WebSocket support is uneven.
- Latency: hosted gateway adds one network hop (tens of ms, region dependent); self-hosted on the same host or LAN: ~1 ms.
- CA trust: none needed beyond the gateway's real cert.
- Exfiltration: the virtual key is *in* the sandbox and is a bearer. It can be exfiltrated if any egress path exists to the gateway from elsewhere
  (e.g. the gateway is internet-reachable). Mitigations: bind virtual keys to device identity (mTLS client cert held by host, or source network),
  short TTL keys minted per session by a host daemon, budgets. If the gateway is reachable only from the sandbox's network and the key is minted per
  session, exfiltration value is near zero. Can still spend budget (by design). Cannot reach non-allowlisted hosts via the gateway (it only talks to
  configured upstreams).

### A3. Host-side daemon over Unix socket / vsock (credential-helper style)

Mechanism: a host process holds credentials and exposes a local endpoint into the sandbox: Unix socket bind-mounted (Docker, bubblewrap; srt already
relays its proxy this way on Linux), vsock (Firecracker, Apple Virtualization.framework, krun), or a host-only network. Two shapes: (a) the daemon
*is* a mini reverse proxy (A2 run locally, pi `baseUrl=http://127.0.0.1:<port>` via a socat relay); (b) "signer" API: sandbox sends a request
description, daemon returns headers (like ssh-agent signing). Shape (b) leaks the bearer in returned headers for bearer schemes, so it only helps for
signature schemes (SigV4, HMAC); for bearer providers it degenerates into shape (a).

Pi already has a local-helper hook: `apiKey: "!command"` in models.json/auth.json runs a command and caches stdout for the process lifetime
(`ca/docs/providers.md:73-82`, `ca/docs/custom-provider.md:128-133`). That puts the real key in pi's memory: not acceptable for requirement 1;
acceptable only for a gateway virtual key.

Properties: OAuth refresh in the daemon (host); SigV4 and GCP minting in the daemon; SSE fine; latency ~0.1-1 ms; no CA if plain HTTP over the socket
(the socket is the trust boundary); exfiltration as in A2 local; the daemon can attribute by socket (one socket per sandbox per user). Per-user
attribution is natural: daemon runs as the logged-in user with SSO-derived identity.

## B. What pi can do today, per pattern

Pi HTTP stack:
- Pi installs an undici `EnvHttpProxyAgent` as the global dispatcher and replaces `globalThis.fetch` with undici's
  (`ca/dist/core/http-dispatcher.js:68-97`), called at startup (`ca/dist/main.js:479-480,717-718`). So all fetch-based provider SDKs (Anthropic,
  OpenAI, Google GenAI, Mistral) honor `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` without `NODE_USE_ENV_PROXY`. `proxyTunnel: true` keeps even http://
  origins on CONNECT (`:75-76`); `allowH2: false` (`:74`).
- `httpProxy` setting is copied to `HTTP(S)_PROXY` only if unset (`ca/dist/core/http-dispatcher.js:38-44`), and "can only be set in agent-directory
  settings" (`ca/docs/settings.md:125`). Env wins: the developer (or the sandboxed code before exec) can override. Enforcement must therefore be at
  the network layer, not in pi config.
- Bedrock uses AWS SDK with `NodeHttpHandler` + `HttpsProxyAgent` when a proxy is configured (`ai/api/bedrock-converse-stream.js:103-111`). Codex
  WebSocket uses `ws` with the proxy from env (`ai/api/openai-codex-responses.js:742-743`). pi-ai's resolver rejects SOCKS/PAC proxies
  (`ai/utils/node-http-proxy.js:115-131`).
- CA: pi does not reference `NODE_EXTRA_CA_CERTS` itself; Node applies it to every TLS context, including npm undici and `ws`. Node 26.10 here.
  `NODE_USE_ENV_PROXY` exists from Node 22.21/24.5 for Node's built-in fetch/http
  (https://humanwhocodes.com/blog/2026/03/proxying-fetch-requests-server-side-javascript, 2026-03) and matters for extensions or child Node processes
  that do not use pi's dispatcher.
- Custom fetch: `StreamOptions.fetch` exists (`ai/types.d.ts:53-58`), passed to the Anthropic client (`ai/api/anthropic-messages.js:770-836`), but
  Google GenAI and Vertex adapters reject a non-global fetch (`ai/api/google-generative-ai.js:36-37`, `ai/api/google-vertex.js:39-40`), and it "does
  not affect WebSocket transports". An extension wrapping fetch is not a credential boundary anyway (same process).

Pattern A2/A3 (baseUrl + dummy key):
- models.json: built-in provider ID changes that provider; `baseUrl` "also applies to the provider's built-in models"; `apiKey`
  literal/`$ENV`/`!command`; `headers`; `authHeader` (`ca/docs/models-configuration.md:11-22`). An extension can do the same with
  `pi.registerProvider("anthropic", { baseUrl, headers })`, keeping catalog and auth (`ca/docs/custom-provider.md:32-49`). Works for
  `anthropic-messages`, `openai-completions`, `openai-responses`, `google-generative-ai`, `mistral-conversations`, `azure-openai-responses`,
  `bedrock-converse-stream` (`ca/docs/custom-provider.md:168`).
- A literal dummy key is required: Anthropic path throws "No API key" unless an apiKey or an `authorization`/`x-api-key`/`cf-aig-authorization` header
  is present (`ai/api/anthropic-messages.js:174-183`, call at `:410-413`); OpenAI paths same check (`ai/api/openai-completions.js:38`,
  `ai/api/openai-responses.js:45`).
- Bedrock: `AWS_BEDROCK_SKIP_AUTH=1` makes pi send dummy SigV4 creds (`ai/api/bedrock-converse-stream.js:68,92-98`) "for proxies that don't need
  authentication": the gateway re-signs. Or the bearer path (`:69-73,124-126`) with a gateway token.
- Vertex: a `GOOGLE_CLOUD_API_KEY` or `<placeholder>`-shaped key selects paths (`ai/api/google-vertex.js:319-332`); gateway must accept API-key style
  or the client must use ADC (which needs real GCP creds in the sandbox). Prefer Vertex via a gateway exposing Anthropic/OpenAI-compatible endpoints,
  or MITM-inject a bearer.
- Cost/spending: pi computes cost from its catalog prices times returned usage tokens (`ai/models.js:672`, `calculateCost`), except OpenRouter where
  it uses billed cost from the response (`ai/utils/openrouter-cost.js:7-13`). So `spending` survives any gateway that passes provider `usage` through
  unchanged, but reflects list price, not the gateway's negotiated price. Model IDs must match pi's catalog or prices are whatever the models.json
  entry says.
- Gotcha: pi's background network: model catalog refresh, `pi.dev` version check, telemetry headers. Allowlist them or set `PI_OFFLINE`,
  `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY=0` (`ca/docs/environment-variables.md`, "Pi Process Configuration").

Pattern A1 (MITM injector, pi unchanged, talks to real hosts):
- Anthropic API key: pi sends `x-api-key: <placeholder>`; proxy replaces. Anthropic subscription OAuth: pi switches to OAuth mode only if the key
  contains `sk-ant-oat` (`ai/api/anthropic-messages.js:767-769`), then uses bearer auth, Claude Code identity headers and `anthropic-beta:
  claude-code-20250219,oauth-2025-04-20` (`:786-801,857-858`) and remaps tool names (`:542-544`). So the placeholder must look like `sk-ant-oat01-...`
  (matches Docker's `--placeholder 'sk-ant-oat01-{rand}'`, `ca/docs/containerization.md:98`). Env names: `ANTHROPIC_OAUTH_TOKEN`,
  `ANTHROPIC_AUTH_TOKEN` (bearer), `ANTHROPIC_API_KEY` (`ai/env-api-keys.js:30-32,75`; `ca/docs/providers.md:67`). Subject to the ToS issue in A2.
- OpenAI Codex / ChatGPT login: no env var; credential must be an `oauth` entry in `auth.json` (shape: `access`, `refresh`, `expires` number,
  `ca/dist/core/auth-storage.js:202-207`). Pi parses the access token as a JWT and reads `https://api.openai.com/auth`.`chatgpt_account_id`
  (`ai/api/openai-codex-responses.js:21,1268-1282`), then sends `Authorization: Bearer` + `chatgpt-account-id` (`:1297-1298`) to
  `https://chatgpt.com/backend-api` (`:20`), preferring WebSocket (`:187-200`). So the placeholder must be a syntactically valid unsigned JWT carrying
  the (non-secret) account ID, `expires` far in the future so pi never refreshes (refresh logic `ai/auth/resolve.js:62-81`), and the injector must
  handle the WS upgrade. Pi also has a newer "Sign in with ChatGPT" flow on the `openai` provider (`ai/auth/oauth/openai-chatgpt.js:16-24`, resource
  `https://api.openai.com/v1`).
- Other OAuth logins in 1.5.0: Anthropic (`claude.ai` authorize, `platform.claude.com/v1/oauth/token`, `ai/auth/oauth/anthropic.js:12-13`), GitHub
  Copilot, Kimi, Meta, OpenAI Codex, OpenAI ChatGPT, OpenRouter (key minting), Radius, xAI (`ai/auth/oauth/*.js`). All store refreshable tokens in
  `~/.pi/agent/auth.json` (mode 0600, proper-lockfile, `ca/dist/core/auth-storage.js:7,27,31`). Rule: logins run on the host only; the sandbox's
  `auth.json` holds placeholders; the injector owns refresh. Block the OAuth token endpoints from the sandbox so a stray in-sandbox refresh fails
  loudly.
- Copilot: bearer via Anthropic-shaped or OpenAI-shaped clients (`ai/api/anthropic-messages.js:771-784`); token exchange host-side.

What pi cannot do today: no notion of "credential lives elsewhere" (no remote signer hook); `httpProxy` setting is advisory (env overrides); no egress
enforcement; no per-request user identity header by default (add with models.json `headers`, e.g. `x-user: $PI_USER`, but anything in the sandbox is
spoofable, so attribute at the boundary instead).

## C. Egress allowlist enforcement

Principle: the sandbox gets no default route; its only reachable endpoint is a policy proxy outside the boundary. Proxy env vars are a convenience for
clients, never the enforcement.

Boundary options:
- Docker/Podman: `--network none` + bind-mount a Unix socket of the host proxy and run `socat TCP-LISTEN:3128,fork UNIX-CONNECT:/run/proxy.sock`
  inside (srt's Linux model). Or `docker network create --internal` with the proxy container dual-homed (internal + egress networks). Docker Desktop
  on macOS: the VM is the boundary; `--internal` networks have no NAT. Verify DNS: internal networks still resolve via embedded DNS (a DNS exfil
  channel); use `--dns 127.0.0.1` or no resolver and let the proxy resolve.
- Docker Sandboxes: microVM, all TCP proxied, UDP/ICMP blocked, deny-by-default; org policies from Docker admin console, "local `sbx policy` allow
  rules are no longer evaluated and can't expand what the organization permits", local denies still apply, sync within 5 min; HTTP rules by host,
  method, path; requires paid governance subscription (https://docs.docker.com/ai/sandboxes/governance/access-controls/organization/, 2026-11-02).
  `sbx policy log` shows decisions. This is the only off-the-shelf option meeting requirement 2 on a Mac today.
- OpenShell: OPA policies, network section hot-reloadable, filesystem/process locked at creation (https://docs.nvidia.com/openshell/latest/security).
  Policy is per gateway; central if the gateway is central.
- Apple `container` (macOS 26+): user-defined networks, host-only mode without NAT (`container network create ... --mode hostOnly` or `--internal`,
  flag name unverified) (https://instagit.com/apple/container/how-to-configure-network-isolation-and-custom-subnets-for-containers, generated summary,
  unverified). Per-container lightweight VMs; proxy on host reachable via host-only subnet; vsock possible.
- srt: macOS Seatbelt allows only the proxy's localhost port; Linux removes the netns and bind-mounts proxy Unix sockets; resolved-address check
  blocks loopback/link-local/metadata/own-interface IPs before dialing (https://github.com/anthropics/sandbox-runtime). Allowlist comes
  from a settings file: central only if that file is managed (MDM) and not writable by the user; macOS `allowLocalBinding` reopens localhost.
- Claude Code sandbox (built on srt): managed `allowManagedDomainsOnly` ignores user domains; `httpProxyPort`/`socksProxyPort` to bring an inspecting
  proxy; `enableWeakerNetworkIsolation` allows `trustd` for MITM CA on macOS and is flagged as an exfil vector
  (https://code.claude.com/docs/en/sandboxing via mirror; source mirror on Hugging Face, unverified).
- Codex CLI: experimental network proxy, `domains` allow/deny map, empty means nothing; managed `requirements.toml` prevents users expanding the
  allowlist; app/connector traffic not covered (https://developers.openai.com/codex/config-reference,
  https://developers.openai.com/codex/agent-approvals-security, 2026).
- Linux host firewall: nftables `meta skuid` owner match lets only the proxy's UID egress; works for an OS sandbox running pi as a dedicated user.
  Containers: rules on the bridge/veth (`iifname`), or inside a netns.
- macOS pf: no per-user owner match for outbound in modern pf (`user` keyword works only for sockets pf can attribute; unreliable); use per-interface
  rules on the VM's vmnet/bridge interface. Prefer the VM boundary over pf.

Allowlisting method:
- CONNECT-only allowlist by hostname (+ SNI check): keeps end-to-end TLS, so git/npm/pip/cargo work with no CA changes. Weaknesses: domain fronting
  (CONNECT allowed host, inner Host different; CDNs mostly block cross-tenant fronting now but not universally), and any allowed multi-tenant host
  (github.com gists, raw.githubusercontent.com, S3, npm publish) is an exfil channel. Match SNI to CONNECT target; refuse non-TLS opaque tunnels (srt
  `refuseOpaqueTunnels`); have the proxy resolve and dial (no client-supplied IPs) and pin the resolved IP (srt does this).
- DNS-only allowlist: weak. Clients can use IP literals, DoH to an allowed resolver, or cached/hardcoded IPs; DNS itself carries data (TXT/subdomain
  exfil). Only acceptable as a secondary layer.
- TLS interception: needed for header injection, path-level rules (e.g. allow `GET` on github.com but deny `POST /gists`) and body audit. Breaks
  pinning clients and anything not using the injected CA bundle; do it only for the model/credential hosts and a small set of "path-filtered" hosts,
  tunnel the rest.
Recommended: MITM for model hosts (credential injection) and OAuth/token hosts (blocked), CONNECT+SNI for package registries and git hosts, deny
everything else.

Tool behavior behind HTTP(S)_PROXY (well known, not individually re-fetched):
- curl: honors `https_proxy`/`HTTPS_PROXY`, `http_proxy` lowercase only, `NO_PROXY`; CA via `CURL_CA_BUNDLE` or system.
- git https: honors `https_proxy` and `http.proxy`; CA `http.sslCAInfo`/`GIT_SSL_CAINFO`. git ssh: ignores HTTP proxies; needs `ProxyCommand` (e.g.
  `nc -X connect -x proxy:3128 %h %p` or `ssh -W` via a jump) or use `ssh.github.com:443`. Simpler: force https remotes in the sandbox
  (`url."https://github.com/".insteadOf git@github.com:`).
- npm/pnpm/yarn: honor `HTTPS_PROXY` env and `proxy`/`https-proxy` config; CA via `cafile` or `NODE_EXTRA_CA_CERTS`. Only matters if MITMing the
  registry.
- pip: honors `HTTPS_PROXY`; CA via `PIP_CERT`/`REQUESTS_CA_BUNDLE` (recent pip can use system trust via truststore; unverified version detail). uv
  honors env proxy and `SSL_CERT_FILE`/`--native-tls`.
- cargo: honors `HTTPS_PROXY`/`http.proxy`, CA `http.cainfo`.
- Go: `net/http.DefaultTransport` uses `ProxyFromEnvironment`; custom transports without `Proxy` ignore it; Go reads system roots and `SSL_CERT_FILE`.
- Java: ignores `HTTPS_PROXY`; needs `-Dhttps.proxyHost/-Dhttps.proxyPort` (via `JAVA_TOOL_OPTIONS`) and CA in the JVM truststore. Gradle/Maven have
  their own proxy config.
- Node children not using pi's dispatcher: built-in fetch ignores env unless `NODE_USE_ENV_PROXY=1` (Node >= 22.21/24.5).
Consequence: with no default route, tools that ignore proxy env simply fail closed (good for security, bad for UX). A transparent redirect (iptables
REDIRECT/TPROXY of :443 to the proxy, SNI-peek) catches them; Docker Sandboxes and OpenShell do transparent capture.

## D. Audit and attribution

- Gateway logs: LiteLLM spend logs per virtual key/user/team, `x-litellm-response-cost` and key spend headers; Bifrost per virtual key budgets;
  Cloudflare AI Gateway dashboard logs per gateway with key aliases; Envoy/Agent Router emits token metrics via OpenTelemetry (metrics page not
  fetched). MITM injector: you write the log yourself (mitmproxy addon: user, sandbox ID, host, path, model from body, status, usage from the final
  SSE event).
- Attribution root: the host, not the sandbox. Options: (1) host daemon obtains a short-lived per-device credential through SSO (OIDC device flow, or
  MDM-issued device cert), and either injects it upstream (A1) or presents it to the gateway via mTLS on the host-to-gateway hop (A2 behind A1); (2)
  per-developer virtual key stored only in host keychain, injected by the host proxy into gateway requests (the sandbox sends a placeholder). Do not
  trust any `x-user` header set inside the sandbox.
- Usage pass-through: pass-through gateways forward provider usage objects in the body (SSE `message_delta` usage for Anthropic, final chunk `usage`
  for OpenAI with `stream_options.include_usage`); pi computes cost from usage (`ai/models.js:672`), so pi's `spending` stays accurate in tokens.
  Translating gateways (OpenAI-format in front of Anthropic) may drop cache-read/cache-write token fields, making pi under-report cache costs. LiteLLM
  cost component headers are non-streaming only.
- Egress audit: proxy access log (CONNECT host, SNI, bytes, decision) per sandbox ID; Docker `sbx policy log`; OpenShell logs per sandbox.

## E. Edge cases

- Git credentials: do not forward ssh-agent into the sandbox unless acceptable (the agent can sign with any loaded key while connected, though it
  cannot extract it). Prefer https remotes with the injector adding `Authorization: Basic` for github.com git paths (Docker's `github` service does
  this, not covering npm.pkg.github.com, per credentials page). `gh` reads `GH_TOKEN`: give it a placeholder, inject on api.github.com. Scope to
  fine-grained, repo-limited tokens: an injected token is still usable for anything the token allows (push, create gist = exfil). Consider path rules
  on api.github.com.
- npm/private registries: `.npmrc` `_authToken=${NPM_TOKEN}` with placeholder; injector replaces `Authorization: Bearer` for the registry host
  (requires MITM of that host only). Artifactory/Nexus same.
- MCP servers needing keys: they run inside the sandbox when pi does (pi's MCP config `.pi/mcp.json`); give them placeholder env and inject per host.
  Remote MCP over HTTP: inject on the MCP host. OAuth-based remote MCP: run OAuth on host, same as model OAuth.
- Subagents: pi subagents (in-process or child `pi`) inherit env and auth.json, so they use the same placeholder/gateway path; no extra work.
  Per-agent attribution needs a header the host proxy can map (session ID from `PI_SESSION_ID`), which is informational only.
- Prompt caching: content-level (`cache_control` in the Anthropic body, `prompt_cache_key` in OpenAI body) survives any proxy that forwards the body.
  Header-level: Anthropic `anthropic-beta` values (extended TTL, fine-grained tool streaming, OAuth betas `claude-code-20250219,oauth-2025-04-20` at
  `ai/api/anthropic-messages.js:857-858`) must pass; OpenShell explicitly allowlists `anthropic-beta` and `anthropic-version`; a gateway with a header
  allowlist that drops `anthropic-beta` silently degrades features. Pi's `x-session-affinity` header (`ai/api/anthropic-messages.js:805-809`) helps
  replica routing on some providers. Cache hits are per upstream org/key: a gateway pooling many users on one key shares cache namespace (good for hit
  rate; cross-user leakage is not possible because cache is exact-prefix, but timing side channels exist in theory).
- Anthropic OAuth beta headers: if the injector swaps an API key for an OAuth token (or vice versa) the beta headers and tool-name remapping chosen by
  pi will be wrong; the placeholder type must match the real credential type.
- WebSockets: Codex prefers WS (`ai/api/openai-codex-responses.js:187-200`), with SSE fallback; force SSE via `transport: "sse"` option if the
  injector cannot handle WS upgrades.
- HTTP/2: pi uses HTTP/1.1 to proxies (`allowH2: false`); Bedrock forced to HTTP/1 with a proxy. Fine for MITM.
- Cloud metadata: block 169.254.169.254 and link-local (srt does) or a sandbox on a cloud dev box steals instance credentials.
- Placeholder in bodies: Docker replaces headers only; a provider needing the key in a query string (Gemini `?key=`) or body will not work; pi's
  Google adapter uses the SDK header form (not re-verified).

## F. Reference implementations

| Project | What to reuse | License | Status (2026-11) |
|---|---|---|---|
| Docker Sandboxes (`sbx`) | Whole product: microVM, MITM injector, OAuth refresh, org policy | Proprietary, governance paid | Active, frequent releases (github.com/docker/sbx-releases) |
| Pi kit for sbx | Pi image + credential mapping | see repo | https://github.com/docker/sbx-kits-contrib/tree/main/pi |
| NVIDIA OpenShell | Netns + OPA CONNECT proxy, per-sandbox CA, inference.local router | Apache-2.0 | Active; docs version drift |
| anthropics/sandbox-runtime | Seatbelt/bubblewrap + host proxies, resolved-IP check, optional TLS terminate with credential hooks | Apache-2.0 | Active (v0.0.81, 2026-10-20) |
| Gondolin (earendil-works) | QEMU micro-VM, host-side secret placeholders bound to hosts | Apache-2.0 | Active; same org as pi |
| superfly/tokenizer + ssokenizer | Sealed-secret injecting proxy, OAuth to sealed tokens | Apache-2.0 | Maintained by Fly.io |
| mitmproxy | DIY injector addon | MIT | Active |
| LiteLLM | Gateway, virtual keys, budgets, pass-through | MIT (core) | Active; Mar 2026 supply-chain incident |
| Agent Router (ex Envoy AI Gateway) | K8s gateway, SigV4/GCP/Azure upstream auth | Apache-2.0 | Active, renamed |
| Bifrost | Fast Go gateway, virtual keys | Apache-2.0 | Active |
| Codex network proxy, Claude Code sandbox | Managed allowlist semantics to copy | Codex Apache-2.0; Claude Code proprietary | Active |
| Infisical Agent Vault, Blaxel | Sidecar injector designs | Commercial | Vendor |

Writeups: Docker architecture "follow an authenticated request" (above), Fly "Tokenized Tokens", Blaxel credential separation, StackOne "sandboxes
don't limit what an API key can do" (https://www.stackone.com/blog/ai-agent-sandbox-api-keys/), OpenAI "Running Codex safely"
(https://openai.com/index/running-codex-safely/). Riptides, Trail of Bits, Snyk, Wiz posts on this exact topic were not found in searches (see Not
verified).

## Comparison

| Pattern | Tokens outside? | OAuth support | Per-provider auth coverage | Allowlist | Audit | Latency | Pi changes needed | Ops burden |
|---|---|---|---|---|---|---|---|---|
| A1 MITM injector (forward proxy) | Yes (placeholders only; must be host-bound) | Yes, proxy refreshes; placeholder must mimic token shape (`sk-ant-oat`, fake JWT for Codex) | Bearer/x-api-key yes; SigV4 needs re-sign; WS needs upgrade support | Same proxy enforces it (MITM model hosts, SNI-tunnel rest) | Self-built logs, full L7 visibility | +1 TLS handshake, ~ms | None (env + placeholder auth.json + CA) | CA distribution, per-provider refresh logic, pinning breakage |
| A2 LLM gateway via baseUrl | Provider keys yes; virtual key inside unless injected by A1/A3 | Generally no for consumer subscriptions (and ToS forbids Anthropic's) | Best: SigV4, GCP, Azure handled by gateway | Not by itself; needs a network boundary | Best: per-key spend, budgets, dashboards | Local ~1 ms, hosted tens of ms | models.json `baseUrl` + dummy key per provider; `AWS_BEDROCK_SKIP_AUTH=1` | Run HA gateway, key lifecycle, supply-chain hardening |
| A3 Host daemon (socket/vsock) | Yes if it proxies; no if it returns bearer headers | Yes (host refresh) | As good as its implementation | Not by itself | Natural per-user (host identity) | ~0.1-1 ms | Same as A2, baseUrl to relay port | Ship and update a host daemon on every laptop |

## Recommended combination

1. Boundary: whole `pi` in a microVM/container with no default route (Docker Sandboxes on macOS where licensable; else Docker/Apple container with
   `--network none` + Unix-socket relay; Linux: same or srt-style netns removal).
2. One host-side egress proxy per laptop (sbx proxy, or a managed mitmproxy/Envoy build) is the only exit; transparent capture so proxy-ignoring tools
   fail closed.
3. Policy: allowlist fetched from a central service (MDM-signed), proxy refuses local allow edits; deny by default; block metadata and OAuth token
   endpoints.
4. Model traffic: pi's providers point (`models.json` `baseUrl`, shipped in the image) at a corporate gateway (LiteLLM/Bifrost/Agent Router) that
   holds all provider keys and does SigV4/GCP/Azure.
5. Sandbox holds a placeholder gateway key; the host proxy MITMs only the gateway host and injects a short-lived per-user token minted from SSO on the
   host (keychain), giving tokens-outside and unforgeable attribution.
6. No consumer OAuth subscriptions in the enterprise path; API/cloud accounts only. If needed for pilots, MITM injection with shape-correct
   placeholders and host-side refresh.
7. Package registries and git hosts: CONNECT+SNI tunnel (no MITM) except hosts needing injected tokens (private npm, GitHub), which get MITM with path
   rules.
8. CA: inject proxy CA into image trust store plus `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `GIT_SSL_CAINFO`; set `PI_TELEMETRY=0`,
   `PI_SKIP_VERSION_CHECK=1`, `PI_OFFLINE` as policy dictates.
9. Audit: gateway spend logs (per user, per model) + proxy egress logs (per sandbox, per host) shipped to SIEM; pi `spending` stays a local estimate.
10. Invisible UX: `pi` on the host is a shim that starts/attaches the sandbox, mounts the repo, and execs pi inside.

## Not verified

- Exact Docker Sandboxes CA lifecycle (per session vs reused), WS upgrade injection support, whether sbx proxy injects for arbitrary custom hosts with
  MITM on non-AI hosts.
- OpenShell inference-routing page URLs returned 404 on fetch; details come from search snippets and the security page. Whether the endpoint binding that closed #896 covers every injection path.
- Gondolin secret-binding details (DeepWiki secondary source only); license is Apache-2.0 (GitHub repo metadata).
- Apple `container` isolated-network flag name and behavior (generated summaries only).
- Claude Code `allowManagedDomainsOnly` and `enableWeakerNetworkIsolation` semantics (source mirror, not official docs).
- Agent Router / Envoy AI Gateway SigV4 signing and token-metrics specifics; TensorZero, Portkey, Kong licenses; Bifrost latency claims.
- Anthropic April 2026 subscription OAuth block date (secondary sources); current policy should be checked on Anthropic's legal page.
- Per-tool proxy/CA behavior list in C (from general knowledge, not re-fetched); pip truststore default version.
- Whether pi's Google adapter ever sends the key as a query parameter; whether pi-mcp HTTP transports use pi's global dispatcher.
- No Riptides, Trail of Bits, Snyk or Wiz writeups on credential-less agent sandboxes surfaced in searches on 2026-11-02.
- Pi behavior was read from compiled `dist/*.js`, not `src/` (the package ships no `src/`); line numbers refer to dist files of 1.5.0.
