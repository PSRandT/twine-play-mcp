# ChatGPT Remote MCP

This is the private single-user edition of twine-play-mcp 0.2.1, based on
`05cee6f68a4ef3ecadbb07f5d7aaa27c500a87a1`. It drives the original browser bridge,
renderers and Twine adapters. It does not generate or rewrite game content.

## Profiles and tools

`npx twine-play-mcp` (the upstream published package) remains local stdio. This
fork's equivalent after `npm ci && npm run build` is `node dist/index.js`.
`TWMCP_MODE=local` is optional for stdio. The HTTP entry requires
`TWMCP_MODE=remote-chatgpt` and is started with `npm run start:http`.
Both entries use the same tool handlers and SessionManager implementation.

Remote tools: `open_game`, `observe`, `session`, `choose`, `click_ui`, `interact`,
`navigate`, `find_ui`, `get_variables`, `screenshot`, `snapshot`.

Remote does not register `upload_file`, `download_file`, `live_view`, `get_logs`.
Local retains all four. Remote schemas reject unknown parameters: screenshot has
no `path`, choose has no `allow_external`, open_game has no headless/seed controls.
Remote navigation supports back/restart, not QA-only passage jumps. find_ui
supports visible controls, not arbitrary subtree/source inspection. Local QA
capabilities are unchanged. Do not enumerate hidden passages or use variable
inspection to spoil a blind playthrough.

Annotations:

| Tools | readOnlyHint | destructiveHint | openWorldHint |
| --- | --- | --- | --- |
| observe, find_ui, get_variables, screenshot | true | false | false |
| open_game | false | false | true |
| choose, click_ui, interact | false | false | false |
| navigate, snapshot, session | false | true | false |

The last group can reset/replace/close temporary game state. These tools are not
misrepresented as read-only. No additional LLM, database, login or cloud saves.

## Private endpoint and deployment

The canonical endpoint is the deployed HTTPS origin, followed by one path segment
derived from `TWMCP_SECRET`, followed by `/mcp`. **Do not publish the assembled URL**
in the repository, issue trackers, screenshots, logs or shared conversations.
That URL is a bearer credential. Generate at least 128 bits of randomness; the
service accepts 32–128 URL-safe characters unchanged, or Render's padded Base64
encoding of 32 random bytes. Render's `generateValue: true` supplies the latter;
the server converts it to Base64url without reducing its randomness. For the URL
only, replace `+` with `-`, replace `/` with `_`, and remove the final `=` from
the generated value. Leave the environment variable unchanged. Do this locally,
not with a public online converter. Rotating it invalidates the old URL; redeploy also
closes all browser games. Keep the value in the host's secret environment settings.

Deploy `render.yaml` from your own fork as a Blueprint. It builds the Dockerfile,
uses a non-root user, installs Chromium and its sandbox, and generates the secret.
No secret is stored in Git. The Free plan is selected to avoid silently starting
a paid service. Browser memory usage and hosting restrictions still require
acceptance testing; free-instance sleep or restart loses active games.

If an older deployment reports `TWMCP_SECRET must be ... URL-safe characters`,
then exits before listening, deploy the Base64 secret compatibility fix. Render's
subsequent port-scan timeout is a consequence of that startup error, not a reason
to change `PORT` or pay for a larger instance. No secret rotation is required.

**Sandbox prerequisite:** default Docker seccomp can reject Chromium's namespace
creation. This is a tested failure, not a missing browser binary. A Docker host
under your control can use the included `deploy/chromium-seccomp.json` (Playwright
upstream's recommended profile) with `--security-opt seccomp=deploy/chromium-seccomp.json`.
Do not use privileged mode or disable Chrome sandbox. Render Blueprint cannot
set a Docker seccomp profile; if Render blocks the sandbox, this deployment is
not accepted and needs a host that supports those namespaces. No insecure
fallback is implemented.

Local HTTP development:

```bash
npm ci
npm run build
export TWMCP_MODE=remote-chatgpt
export TWMCP_CHROME_PATH=/usr/bin/chromium
export TWMCP_SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
npm run start:http
```

`PORT` defaults to 3000; `HOST` defaults to 0.0.0.0. Put HTTPS at the ingress and
avoid logging credential-bearing request paths there. Preserve `Mcp-Session-Id`,
`MCP-Protocol-Version`, Accept and Content-Type headers. POST is MCP; GET/HEAD on
the private MCP path return 405, Allow POST/DELETE. DELETE ends an MCP session.
Unauthenticated paths return 404. Browser-origin MCP requests are rejected.
`GET /health` returns non-sensitive JSON and does not start a browser.

## Public acceptance without sharing the credential

The Blueprint enables `TWMCP_SERVE_FIXTURES=1` and `TWMCP_PUBLIC_CHECK=1` for initial
acceptance. Only the four **unchanged** committed format fixtures are served,
through exact allowlisted routes `/fixtures/sugarcube.html`, `/fixtures/harlowe.html`,
`/fixtures/snowman.html`, `/fixtures/chapbook.html`. There is no arbitrary file route.

After startup, the official MCP SDK client in `src/public-check.ts` connects to
`RENDER_EXTERNAL_URL` (or `TWMCP_PUBLIC_ORIGIN` on another host) over public HTTPS.
It uses the secret internally, checks initialize/tools/list/annotations, opens all
four fixture URLs in sandboxed Chromium through the production egress policy,
chooses branches, checks native PNG images, restores variables and snapshots,
performs ten successive choices, and checks two MCP clients' isolation.
It closes its games/sessions afterward. This is a real public protocol/browser
check, not a health-check substitution or mocked browser.

Read the credential-free result at `/acceptance.json` and the `[public acceptance]`
log lines. `PENDING`, `RUNNING`, `FAIL` and `PASS` are distinct. A failure names
only the stage; raw SDK exceptions are deliberately excluded because they may
contain the private URL. A passed report does not establish ChatGPT acceptance.
The check runs once per process startup; it never retries or opens games on
ordinary report reads. Disable `TWMCP_PUBLIC_CHECK` after acceptance; optionally
disable the fixture routes as well.

For MCP Inspector, supply the private endpoint directly in your private local
Inspector UI, select Streamable HTTP, and connect/list/call tools. Never copy its
credential-bearing request logs into a public issue.

## ChatGPT verification

Only after the public report is PASS, create a custom MCP named **Twine Play**.
Paste the assembled private URL directly into ChatGPT's server URL field. Select
no additional authentication: the unguessable path provides bearer access.
Do not share the plugin or its URL with other users.

Open the deployed public SugarCube fixture with natural language. Confirm a real
`open_game` call, then `observe`, `choose` and a visible screenshot. Continue at
least ten meaningful interactions in the same ChatGPT conversation; confirm
actual tool invocations and state continuity. Two simultaneous conversations must
have different MCP sessions. If ChatGPT reinitializes transport sessions on every
turn, play continuity has NOT passed; do not pretend the server retained the game.

Instructions ask the assistant to make one meaningful choice per turn, present
the resulting scene, then stop at the next meaningful choice/revelation/emotional
beat. Personal shorthand belongs in the user's conversation, not the public MCP
protocol. Actual pacing and ChatGPT image rendering require user acceptance.

## Network and session security

Remote URLs must be public HTTPS on port 443; local paths, credentials in URLs,
HTTP, loopback/private/link-local/metadata/multicast/reserved addresses are blocked.
Every browser connection goes through a CONNECT-only loopback egress proxy. It
resolves all DNS records, rejects any non-public address, then dials the validated
literal IP without a second DNS lookup. TLS remains end-to-end and verifies the
original host. New connections revalidate DNS. Browser proxy bypass for localhost
is disabled. Redirects, iframe requests and subresources use the same policy.
Top-level and frame navigation may not leave the game's initial origin.
CDP pauses document responses and checks each redirect Location before following
it, because Playwright request routing alone does not intercept every redirect hop. Public
HTTPS JS/CSS/images/fonts/audio can load from other origins as subresources.
Service workers, WebSockets, QUIC, WebTransport, non-proxied WebRTC UDP, downloads
and popups are disabled. No local-file serving or persistent download capture in
remote mode. No TLS-verification bypass or network allowlist override is available
through production environment variables or tools. Test harnesses inject their
own resolver/dialer and trust only a generated local fixture certificate.

Each cryptographically random MCP transport session owns a separate manager,
browser and game/snapshot namespace. The upstream short game_id is not an access
credential. A foreign game_id cannot resolve outside its owner's map. Normal
HTTP request completion keeps the game alive; explicit MCP DELETE, aborted
in-flight requests, shutdown or expiry closes owned contexts and snapshots.
An idle HTTP TCP connection closing is not an MCP DELETE; abandoned clients are
cleaned by TTL. Games are stateful in browser memory and cannot survive redeploy.

Limits:

- Two MCP sessions per process; two games per session; four active contexts total.
- Game and MCP idle timeout 30 minutes; MCP absolute lifetime four hours; sweep each minute.
- One in-flight MCP request per owner; 120 requests/minute/owner; 10 initializes/minute.
- Request body 32 KiB; tool argument JSON 20,000 characters; response text about 48,000 characters.
- Observations cap passage text at 16,000 characters; explicit truncation markers. JSON remains valid.
- Tool deadline 45 seconds closes its owner; browser launch 20 seconds; screenshots 10 seconds.
- 1280×800 PNG viewport, maximum 5 MiB; eight snapshots per game, 1 MiB each; journal retains 200 entries.
- Proxy maximum 64 tunnels, 32 MiB/tunnel, 20-second idle/45-second absolute tunnel timeout.

These bounds intentionally exclude streaming/large downloads and some games with
cross-origin navigation, WebSockets, service workers, login or desktop file saves.
They do not make arbitrary hostile renderer code harmless: keep Chromium patched
and enforce host memory/CPU quotas. Render Free's small memory allowance may be
insufficient for large games or simultaneous contexts. No silent downgrade of
sandbox or SSRF protection is permitted for compatibility.

## Tests and rollback

```bash
TWMCP_CHROME_PATH=/usr/bin/chromium npm test
TWMCP_CHROME_PATH=/usr/bin/chromium npm run test:remote
TWMCP_CHROME_PATH=/usr/bin/chromium npm run formats
TWMCP_GAME="$(npx tsx scripts/prepare-smoke.ts)" TWMCP_CHROME_PATH=/usr/bin/chromium npm run smoke
npm run clarity
```

The smoke preparation creates a separate temporary SugarCube input matching the
upstream smoke script's required controls; it does not modify existing fixtures
or user games. `clarity` is an upstream regression specifically for a local
Degrees of Lewdity game; without that input it reports SKIPPED, not PASS.
Supply the appropriate local game through `TWMCP_GAME` to run it fully.

Local tests cover official SDK transport, four actual engines, binary PNG,
branch snapshots, ten choices, cross-client rejection, private IP/DNS/rebinding,
redirect/iframe/subresource blocking, missing file tools/parameters, quotas,
termination, expiry and aborted requests. Game bridge/renderers and original
fixtures are unchanged. See `test/remote/` for evidence.

Rollback: redeploy a previously verified remote commit while preserving the
secret. This closes all in-memory games. To remove remote mode entirely, disable
the public service and check out the baseline for local stdio; the upstream
baseline has no HTTP endpoint and is not a drop-in remote rollback.
