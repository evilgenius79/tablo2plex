# Tablo2Plex — Performance & Security Review

A code review of the streaming path and supporting modules, focused on **channel
loading / channel switching performance**, plus a **security audit** of the
codebase. File and line references are against the current source.

---

## Implementation status

The following fixes from this review are implemented on this branch:

**Performance**
- §1.1 ffmpeg probe limits (`-fflags +nobuffer+genpts`, 1s/1MB probe,
  `-http_persistent 1`) — `src/Device.js`
- §1.2 Tuner slot reserved before the `/watch` await (race fixed), SIGKILL on
  disconnect, `res.flushHeaders()`, `ffmpeg.on('error')`/`on('close')`
  handlers — `src/Device.js`
- §1.3 `guide.xml` served via stream instead of a sync read; guide build uses
  async file I/O; Logger reuses one append stream instead of opening one per
  message — `src/Device.js`, `src/Logger.js`
- §1.4 Shared keep-alive `https.Agent` + guide downloads run 6-at-a-time
  instead of serially — `src/Device.js`
- §1.5 `parseLineup` clears stale channels before rebuilding — `src/Device.js`
- Watch-session caching: `/watch` responses are cached per channel until
  their `expires` time (~3 min). Retuning to a recently watched channel skips
  the Tablo's 5-6 second tuner spin-up (measured in field debug logs), and
  because the Tablo kept producing segments during the cached session, ffmpeg
  bursts several seconds of video immediately so the client's buffer fills at
  once. A cached session is probed (1.5 s timeout) before reuse and falls
  back to a fresh `/watch` if the Tablo tore it down early. Note: nothing
  proxy-side can remove the tuner spin-up on a *cold* tune — that delay is the
  Tablo hardware itself. (`-muxdelay 0 -muxpreload 0` were tried on the ffmpeg
  output but starved the player's PCR/PTS lead and caused endless buffering,
  so they were removed — the mpegts muxer keeps its default output timing.)
- Warm tuner (opt-in, `WARM_TUNER_SECONDS`, default off): keeps a tuner
  session alive for N seconds after the client disconnects by periodically
  re-fetching its playlist, so switching back is instant. A warm session
  holds a real tuner slot (`CURRENT_STREAMS`) and is evicted when the grace
  expires, a keepalive fetch fails, or the slot is reclaimed for a new
  stream (oldest warm session evicted first). — `src/Device.js`

### Reliability

- Guide downloads retry on Tablo's intermittent cloud 502s with exponential
  backoff + jitter, and no longer overwrite an existing good guide file with
  `[]` on failure (stale data beats no data). Concurrency eased to 4.
  — `src/Device.js`
- Automatic session re-login: Tablo session tokens expire, after which the
  device rejects `/watch` with `unauthorized` / "Authentication failure" and
  streams stop starting. When `USER_NAME`/`USER_PASS` are configured, the
  proxy detects that, silently re-logs in (reusing the stored profile/device
  selection), refreshes and persists the tokens, and retries the stream once.
  Concurrent failures collapse onto a single refresh. — `src/Device.js`

### Device / firmware recon

- `tools/device-info.js` — standalone helper that reuses the app's creds and
  device-auth signing to dump the full `/server/info` (which carries the
  firmware version) and probe a handful of candidate device endpoints.
  Read-only; a starting point for OTA/firmware investigation. Actually
  pulling the OTA image is done off-box (capture the device's update-check
  traffic, then `binwalk -e` the downloaded image).

**Security**
- §2.1 New installs generate a random 32-byte key (`creds.key`, mode `0600`)
  for `creds.bin` (also `0600`). Installs still on the legacy built-in key are
  **automatically migrated** to a per-install key the first time `creds.bin`
  is read. **If you move an install to another machine, copy `creds.key`
  along with `creds.bin`.** Bonus fix found while
  testing: a wrong-key/corrupted `creds.bin` used to crash the process with an
  unhandled cipher stream error; it is now handled as a bad creds file.
- §2.2 `.dockerignore` now excludes `.env`, `creds.bin`, `creds.key`, `logs`,
  and all runtime state; `creds.key` added to `.gitignore`
- §2.3 `Authorization`/`Lighthouse`/token fields are redacted in debug logs;
  log files are created with mode `0600`
- §2.4 Wildcard CORS headers removed
- §2.5 `trust proxy` set to `false`
- §2.6 Crypto seed and UUID now come from `crypto.randomBytes` /
  `crypto.randomUUID` instead of a clock-seeded Mersenne Twister
- §2.7 `keypress` git dependency pinned to a commit hash

Since implemented in a follow-up audit pass: `package-lock.json` is committed
(§2.7) and Docker installs with `npm ci`; the image runs as the non-root
`node` user (§2.2); `.env` is untracked/gitignored with a documented
`.env.example`; credentials are no longer passed on the container argv;
`--creds` actually forces a fresh login; the scheduler picks up interval
changes from `.env`; `WARM_TUNER_SECONDS` is CLI-wired; `BIND_ADDRESS` and
`MAX_OTT_STREAMS` were added; new `creds.bin` files use a random 16-byte IV
(§2.6, legacy files still decrypt and are migrated on read); debug-log
redaction is recursive; the guide build yields to the event loop
periodically; and the PseudoTV fragment is checked for well-formedness
before being spliced into `guide.xml`.

Not implemented (needs a maintainer decision or hardware testing): the Tablo
`keepalive` POST (§1.5 — active streams continuously re-fetch the HLS
playlist, which acts as an implicit keepalive; adding an explicit `/watch`
keepalive needs on-device testing) and running the guide build in a
dedicated worker thread (§1.3 — the cooperative yielding above captures most
of the benefit without risking the `pkg` single-binary builds).

---

## Part 1: Performance

The architecture is sound — the channel lineup is held in memory
(`LINEUP_DATA`), so channel *lookup* is instant. The real latency in loading
and switching channels lives in how ffmpeg is spawned and killed, plus a few
synchronous operations that block Node's event loop while streams are active.

Findings are ranked by impact.

### 1.1 ffmpeg input probing — the biggest channel-load win

**Where:** `src/Device.js` (`handleStreams`, the `spawn('ffmpeg', ...)` call)

ffmpeg is spawned with just `-i <playlist_url> -c copy`. With no probe limits,
ffmpeg uses its defaults (~5 MB `probesize` / ~5 s `analyzeduration`), meaning
it downloads and analyzes several seconds of HLS video before emitting the
first byte to Plex. Since the stream is copied (not transcoded), deep probing
is unnecessary. Adding probe limits typically cuts time-to-first-byte by
several seconds:

```js
const ffmpeg = spawn('ffmpeg', [
    '-fflags', '+nobuffer+genpts',
    '-analyzeduration', '1000000',   // 1s instead of ~5s
    '-probesize', '1000000',         // 1MB instead of ~5MB
    '-http_persistent', '1',         // reuse the TLS connection across .ts segment fetches
    '-i', channelJSON.playlist_url,
    '-c', 'copy',
    '-f', 'mpegts',
    '-v', `repeat+level+${CONST.FFMPEG_LOG_LEVEL}`,
    'pipe:1'
]);
```

`-http_persistent 1` matters because every HLS segment fetch otherwise re-does
a TLS handshake to the Tablo. If streams start reliably with these values, the
probesize can be experimented with lower, but 1 MB / 1 s is a safe floor for
ATSC mpegts.

### 1.2 Channel switching: SIGINT teardown + a tuner-slot race

**Where:** `src/Device.js` (`handleStreams`)

Two related issues:

- **`ffmpeg.kill('SIGINT')` on client disconnect** asks ffmpeg to shut down
  gracefully — it finishes the current segment download and flushes output.
  But the output pipe is already dead (the client disconnected), so grace buys
  nothing. Meanwhile the old process keeps holding the HLS session against the
  Tablo tuner for a second or more. On a channel switch, Plex often opens the
  new stream *before* the old one closes, so with a 2-tuner Tablo the proxy
  can transiently be "full". Using `ffmpeg.kill('SIGKILL')` on client
  disconnect frees the resources instantly.

- **Tuner-count race:** the code checks `CURRENT_STREAMS < TUNER_COUNT`, then
  `await`s the Tablo `/watch` request, and only increments `CURRENT_STREAMS`
  afterwards. Two near-simultaneous requests (exactly what a fast channel
  switch or a multi-client start produces) both pass the check and both
  proceed, oversubscribing the tuners and getting errors from the device
  itself. The counter should be incremented *before* the `await` (and
  decremented on every failure path).

Also cheap and worthwhile: call `res.flushHeaders()` right after
`res.setHeader('Content-Type', 'video/mp2t')` so Plex sees a live response
immediately instead of waiting for ffmpeg's first output chunk.

### 1.3 Event-loop blocking while streams are running

Node pipes ffmpeg output to Plex on the event loop, so anything synchronous
stalls **all active streams** (stutter, and slow channel loads when they
coincide):

- **`_guide_serve`** (`src/Device.js`) reads the entire `guide.xml` with
  `fs.readFileSync`. Guide files for a full lineup over multiple days can be
  many MB. When Plex refreshes the guide during playback, the event loop
  stalls for the whole read. Use
  `fs.createReadStream(GUIDE_FILE).pipe(res)` instead.

- **`cacheGuideData` / `parseGuideData`** do hundreds of
  `readFileSync`/`writeFileSync` calls and build the entire XML document as
  one in-memory string. This runs on the scheduler *in the same process as
  live streams* — if a guide update fires while someone is watching, playback
  degrades. Switching to the `fs.promises` variants fixes the stalls; running
  the guide build in a `worker_thread` is the thorough fix.

- **`Logger`** (`src/Logger.js`, `_CustomLog.log`): when `SAVE_LOG` is on,
  every single log call creates a brand-new `fs.createWriteStream` (an
  open/write/close of the log file). The ffmpeg stderr handler logs *every
  stderr chunk*, so during streaming this is a constant churn of file-handle
  syscalls. Open one append stream at startup and reuse it. Also cheap: skip
  attaching the ffmpeg stderr handler entirely unless the configured log level
  actually needs it, instead of formatting every chunk.

### 1.4 Guide/lineup refresh is needlessly slow (indirect impact)

**Where:** `src/Device.js` (`cacheGuideData`, `makeHTTPSRequest`)

`cacheGuideData` downloads `channels × GUIDE_DAYS` files **strictly
sequentially**, and `makeHTTPSRequest` builds a fresh `https.request` (new
TCP + TLS handshake) for every call. For 60 channels × 3 days that's ~180
serial handshakes and requests. Two fixes:

- Share one `https.Agent({ keepAlive: true })` across `makeHTTPSRequest`
  calls.
- Fetch with a small concurrency pool (5–8 in flight). Order doesn't matter
  since each result goes to its own file.

This can take the guide update from many minutes to well under one, which also
shrinks the window where §1.3 hurts playback.

### 1.5 Smaller observations

- `_lineup` re-serializes `LINEUP_DATA` on every request — harmless at this
  scale, but the JSON string could be cached and rebuilt only when the lineup
  updates.
- `parseLineup` never clears `LINEUP_DATA`, so channels removed from the Tablo
  lineup keep serving stale entries until restart.
- The Tablo `/watch` response includes a `keepalive` interval that is ignored.
  If the Tablo expires unrefreshed sessions, long viewing sessions may drop
  and force Plex to reconnect — which the user experiences as a slow "channel
  reload". Worth testing whether a periodic keepalive POST keeps streams alive
  longer.
- There is no `ffmpeg.on('error')` handler — if ffmpeg isn't on PATH the spawn
  error is unhandled, and if ffmpeg exits early the HTTP response hangs open.
  Robustness rather than speed, but it interacts with the tuner counter (a
  hung response holds a slot).

### Priority summary (performance)

| # | Change | Effort | Impact on channel load/switch |
|---|--------|--------|-------------------------------|
| 1.1 | ffmpeg probe flags + `-http_persistent` | Small | High — seconds off start time |
| 1.2 | SIGKILL on disconnect + fix counter race | Small | High — faster switches, no false "tuners full" |
| 1.3 | Stream guide.xml, reuse log stream, async guide I/O | Small–Medium | Medium — removes stutter/stall sources |
| 1.4 | Keep-alive agent + parallel guide downloads | Medium | Indirect — much faster updates |
| 1.5 | Keepalive POST, `ffmpeg.on('error')`, lineup cache | Small | Low–Medium |

---

## Part 2: Security

Overall the attack surface is small (a LAN service with a handful of GET
endpoints), and the fundamentals are right in several places: streams are
spawned via `spawn()` with an argument array (no shell, so no command
injection via the playlist URL), the `/channel/:channelId` parameter is
validated against the in-memory lineup before ever being used in a device
request (no path injection), outbound requests use HTTPS with default
certificate validation, and the XML guide is built with `xml-writer` (which
escapes text nodes). The findings below are ranked by severity.

### 2.1 HIGH — `creds.bin` is encrypted with a hard-coded key

**Where:** `src/Encryption.js` (`crypt` / `decrypt`)

The AES-256-CBC key is derived deterministically from a constant hex string
embedded in the (public) source, unless the user overrides it with the `RSA`
environment variable — which nothing prompts them to do. Anyone who obtains
`creds.bin` can decrypt it using the published code. The file contains the
Tablo account bearer token (`lighthousetvAuthorization`), the `Lighthouse`
token, and account/profile identifiers — enough to impersonate the account
against Tablo's cloud API.

This is effectively obfuscation, not encryption. Recommendations:

- Generate a random 32-byte key per install on first run
  (`crypto.randomBytes(32)`), store it in a separate file with `0600`
  permissions (or in the OS keychain where available), and use it for
  `creds.bin`.
- Write `creds.bin` itself with `{ mode: 0o600 }` — `fs.writeFileSync`
  defaults to `0644` (world-readable on multi-user systems).
- At minimum, document the `RSA` env override so users can supply their own
  key.

### 2.2 HIGH — Docker image can bake in secrets

**Where:** `Dockerfile` (`COPY . /app`) and `.dockerignore`

`.dockerignore` excludes `node_modules`, images, and build scripts — but **not
`.env`, `creds.bin`, `logs/`, `lineup.json`, or `tempGuide/`**. Anyone who
builds the image from a working directory that has been used to run the app
will bake their credentials file, any filled-in `.env` (which may contain
`USER_NAME`/`USER_PASS` in plain text), and logs into the image layers. If
that image is pushed to a registry, the secrets go with it.

Additionally, the `Dockerfile` sets `USER_NAME`/`USER_PASS` as `ENV`, so real
values passed at `docker run` are visible via `docker inspect` to anyone with
Docker socket access.

Recommendations:

- Add `.env`, `creds.bin`, `logs`, `lineup.json`, `guide.xml`,
  `schedule_*.json`, and `tempGuide` to `.dockerignore`.
- Prefer Docker secrets or a mounted volume for credentials over `ENV`.
- Consider a non-root `USER` in the image (it currently runs as root).

### 2.3 MEDIUM — Bearer tokens are written to logs in debug mode

**Where:** `src/Device.js` (`makeTabloRequest` logs full request headers
including `Authorization`; the login flow logs the full login response
including `access_token`) combined with `src/Logger.js` (`SAVE_LOG` writes to
plain-text files with default permissions).

With `LOG_LEVEL=debug` and `SAVE_LOG=true` (the Docker default is
`SAVE_LOG=true`), long-lived account tokens land on disk in world-readable
log files. The README does warn users to delete debug logs, but the code can
protect them instead:

- Redact `Authorization` / `Lighthouse` header values and token fields before
  logging (e.g. show the first 6 characters only).
- Create log files with `{ mode: 0o600 }`.

### 2.4 MEDIUM — No authentication + `Access-Control-Allow-Origin: *` on the HTTP server

**Where:** `src/Transmissions.js`

Every endpoint (`/discover.json`, `/lineup.json`, `/channel/:id`,
`/guide.xml`) is unauthenticated and the server listens on all interfaces.
On a home LAN this is largely by design — Plex's HDHomeRun discovery expects
an unauthenticated device — but it means:

- Any device on the network (or the internet, if the port is ever forwarded
  or the host is otherwise exposed) can watch streams and exhaust the tuners.
- The wildcard CORS header additionally lets any website a LAN user visits
  probe the server from their browser (`http://<lan-ip>:8181/lineup.json`),
  leaking channel lineup and enabling tuner exhaustion from a drive-by page.

Recommendations: drop the CORS header (Plex does not need it), document that
the port must not be exposed beyond the LAN, and optionally support binding
to a specific interface (the `IP_ADDRESS` setting is currently only used to
build `SERVER_URL`, not to bind the listener).

### 2.5 LOW — `trust proxy: true` lets clients spoof their logged IP

**Where:** `src/Transmissions.js` (`app.set('trust proxy', true)`)

With no actual reverse proxy in front, any client can send an
`X-Forwarded-For` header and control what `req.ip` reports — polluting the
connection logs that identify who is streaming. Set it to `false` (or to the
specific proxy address if one is used).

### 2.6 LOW — Mersenne Twister (seeded with the clock) used for crypto material

**Where:** `src/Encryption.js`

The IV for `creds.bin` encryption and the device UUID are generated with a
Mersenne Twister PRNG seeded from the current time. MT is not a
cryptographically secure RNG and a time seed is guessable. The practical
impact is limited (the IV's seed is stored in the file anyway, and the UUID is
just a device identifier), but the fix is one line each: `crypto.randomBytes(16)`
for the IV and `crypto.randomUUID()` for the UUID.

### 2.7 LOW — Supply-chain notes

- The `keypress` dependency is pulled from a personal GitHub fork
  (`github:hearhellacopters/keypress`) with no pinned commit — the branch can
  change at any time and `npm install` will pick it up. Pin it to a commit
  hash (`github:user/repo#<sha>`).
- `package-lock.json` is listed in `.gitignore`, so builds are not
  reproducible and dependency updates arrive silently. Committing the
  lockfile is the standard mitigation.
- Run `npm audit` periodically; the direct dependency set (express 5, dotenv,
  inquirer, xml-writer) is small and current as of this review.

### Non-issues verified during the audit

- **Command injection:** `spawn('ffmpeg', [args])` uses an argument array and
  no shell; the playlist URL from the Tablo response cannot break out.
- **Path traversal:** `channelId` is only used after a successful lookup in
  `LINEUP_DATA`; `guide.xml` is served from a fixed path.
- **TLS:** outbound requests to Tablo's cloud use `https` with default
  certificate validation. The old startup text claiming credentials are
  "transmitted in plain text" was inaccurate — the login POST is TLS — and has
  been corrected. Plain HTTP is only used on the LAN between Plex and the proxy
  (and device requests, which carry HMAC-signed tokens, not the password).
- **HMAC-MD5 device signing:** weak by modern standards, but it is Tablo's
  own protocol and cannot be changed client-side.

### Priority summary (security)

| # | Finding | Severity | Effort to fix |
|---|---------|----------|---------------|
| 2.1 | Hard-coded `creds.bin` key + world-readable file | High | Medium |
| 2.2 | `.dockerignore` gaps can bake secrets into images | High | Trivial |
| 2.3 | Tokens written to debug logs | Medium | Small |
| 2.4 | No auth + wildcard CORS | Medium | Small |
| 2.5 | `trust proxy` IP spoofing | Low | Trivial |
| 2.6 | Non-CSPRNG for IV/UUID | Low | Trivial |
| 2.7 | Unpinned git dependency, no lockfile | Low | Trivial |
