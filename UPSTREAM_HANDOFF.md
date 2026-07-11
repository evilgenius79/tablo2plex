# Tablo2Plex — Handoff Notes

This document summarizes the work done in this fork, plus a resolved
device-authentication issue that turned out to be a local misconfiguration
(not a Tablo-side change), so it can be folded into the upstream project.
Companion docs:

- [`PERFORMANCE_AND_SECURITY_REVIEW.md`](./PERFORMANCE_AND_SECURITY_REVIEW.md)
  — full performance + security review with reasoning.
- [`README.md`](./README.md) — user-facing summary of the fork changes (top
  section).

---

## 1. Resolved: device "Authentication failure" was a bad `.env`

### Symptom

Streaming a channel failed. The Tablo device's `/guide/channels/<id>/watch`
endpoint returned, instead of a `playlist_url`:

```json
{ "error": { "code": "unauthorized", "details": null, "description": "Authentication failure" } }
```

so `handleStreams` had no playlist and the stream never started.

### Actual cause (confirmed)

A **misconfigured local `.env`** — the device-signing keys were present but
**empty** (`HashKey=""` / `DeviceKey=""`). `makeDeviceAuth` reads
`process.env.HashKey == undefined ? <default> : process.env.HashKey`, and an
empty string is **not** `undefined`, so it signed every device request with an
empty key → the device rejected it as "Authentication failure." Correcting the
`.env` restored streaming (the device then returned a valid `playlist_url` and
the tuner connected).

This fingerprint is worth remembering because it looks alarming: cloud calls
(login, account, guide/lineup) keep working because those use the account
**bearer token**, not the HMAC — so only the device `/watch` fails, and it
survives fresh credentials and a device reboot. It is easy to misread as a
Tablo-side key rotation. It is not.

### Hardening applied

To make this failure self-explanatory instead of a silent bad signature:

- Startup now prints an effective-settings summary (see §"Build/UX"), so a
  wrong/empty setting is visible at boot.
- Empty `HashKey`/`DeviceKey`/`RSA` env values should be treated as "unset."
  Recommended upstream tweak in `makeDeviceAuth` / `crypt`: use
  `process.env.HashKey || <default>` (falsy check) instead of `== undefined`,
  so an empty string falls back to the built-in key rather than signing with
  "".

### Where the signing lives (reference)

`src/Encryption.js` → `makeDeviceAuth(method, url, msg, date)`:

```
full_str = method + "\n" + url + "\n" + md5(msg) + "\n" + date
signature = HMAC-MD5(full_str, HashKey)
Authorization = "tablo:" + DeviceKey + ":" + hex(signature)
```

Built-in constants (overridable via env): `HashKey`, `DeviceKey`.

### If a real Tablo-side signing change ever does happen

The same symptom would appear, but with a **correct** `.env`. In that case the
new keys/scheme must be recovered from firmware:

1. `node tools/device-info.js` — dumps the device's full `/server/info`
   (firmware version) and probes endpoints.
2. Capture the device's OTA image (`tcpdump host <device-ip>` / Wireshark
   during an update check), then `binwalk -e firmware.bin`.
3. Locate the signing constants/routine in the firmware and update
   `makeDeviceAuth` to match.

---

## 2. Improvements in this fork (all independent of the auth break)

Every change below applies cleanly regardless of the auth situation and is
ready to fold upstream. File references point to where the change lives.

### Streaming / channel performance
- ffmpeg input-probe limits + `-http_persistent` + `-muxdelay/-muxpreload 0`
  for faster time-to-first-frame. `src/Device.js` (`handleStreams`)
- Watch-session cache: reuse a live `/watch` session on quick channel
  switch-back, skipping the device tuner spin-up. `src/Device.js`
  (`getPlaylistUrl`, `WATCH_CACHE`)
- Opt-in warm tuner (`WARM_TUNER_SECONDS`) that holds a session briefly after
  disconnect, with slot accounting + eviction so it never oversubscribes
  tuners. `src/Device.js`
- Tuner-slot race fixed (reserve before the async `/watch`); SIGKILL on
  disconnect; `res.flushHeaders()`; `ffmpeg` error/close handling.
  `src/Device.js`

### Reliability
- Guide downloads retry on Tablo cloud 502s (exp. backoff + jitter) and never
  overwrite good guide data with `[]` on failure. `src/Device.js`
  (`cacheGuideData`)
- Automatic session re-login on device "unauthorized" when
  `USER_NAME`/`USER_PASS` are set — refreshes + persists tokens, retries once,
  dedupes concurrent refreshes. `src/Device.js` (`refreshTokens`,
  `refreshTokensOnce`). NOTE: this recovers from *token expiry*; it does **not**
  fix a bad signing key (empty `HashKey`/`DeviceKey`, §1) or a real Tablo-side
  signing change.
- Guide served as a stream; single reused log write-stream; async guide I/O —
  removes event-loop stalls during playback. `src/Device.js`, `src/Logger.js`

### Security
- Per-install random key for `creds.bin` (`creds.key`, mode `0600`); legacy
  key fallback; graceful handling of a bad/wrong-key creds file.
  `src/Encryption.js`, `src/Device.js`
- `.dockerignore` excludes secrets/runtime state; tokens redacted in debug
  logs; log files `0600`; wildcard CORS removed; `trust proxy` off;
  `crypto.randomBytes`/`randomUUID` for IV/UUID; pinned `keypress` dep.
  Multiple files — see the security review doc.

### Build / release
- `.github/workflows/build-windows.yml`: builds the Windows exe in CI,
  downloads a static ffmpeg, and publishes a self-contained release zip
  (exe + ffmpeg) plus the bare exe. Manual "Run workflow" (optionally with a
  `release_tag`) or a `v*` tag triggers a release.

### Tooling
- `tools/device-info.js` — read-only device/firmware recon helper (see §1).

---

## 3. Testing status

- Encryption round-trips (legacy + per-install key, wrong-key handling, UUID
  format), retry control flow, and unauthorized-detection: unit-verified.
- Server boot + all HTTP endpoints (discover/lineup/status/guide/404):
  verified locally.
- Windows CI build incl. ffmpeg bundling: verified green.
- **Not** verifiable here (no Tablo hardware): live streaming, the auto
  re-login flow against Tablo's cloud, and — of course — the device-auth fix,
  which is blocked on recovering the new signing keys.

---

## 4. Suggested PR description (ready to use)

> **Title:** Performance, reliability, security, and CI improvements
>
> **Summary:** Faster channel load/switch (ffmpeg probe tuning, watch-session
> caching, optional warm tuner), reliability fixes (guide 502 retries, auto
> re-login on token expiry, no event-loop stalls during playback), security
> hardening (per-install creds key, log redaction, CORS/proxy, CSPRNG,
> Docker secret exclusion), and a CI workflow that publishes a self-contained
> Windows release (exe + bundled ffmpeg). Also treats empty
> `HashKey`/`DeviceKey`/`RSA` env values as unset (a common footgun — see
> `UPSTREAM_HANDOFF.md` §1), adds a startup settings summary, a clear message
> when `/guide.xml` is requested with `CREATE_XML` off, and auto-generates a
> valid device ID. Includes a device/firmware recon tool. See
> `PERFORMANCE_AND_SECURITY_REVIEW.md` and `UPSTREAM_HANDOFF.md`.
