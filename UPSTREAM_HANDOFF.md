# Tablo2Plex — Handoff Notes

This document summarizes the work done in this fork and the root-cause
analysis of the current device-authentication break, so it can be folded into
the upstream project. Companion docs:

- [`PERFORMANCE_AND_SECURITY_REVIEW.md`](./PERFORMANCE_AND_SECURITY_REVIEW.md)
  — full performance + security review with reasoning.
- [`README.md`](./README.md) — user-facing summary of the fork changes (top
  section).

---

## 1. Root cause: device "Authentication failure" (current outage)

### Symptom

Streaming a channel fails. The Tablo device's `/guide/channels/<id>/watch`
endpoint returns, instead of a `playlist_url`:

```json
{ "error": { "code": "unauthorized", "details": null, "description": "Authentication failure" } }
```

so `handleStreams` has no playlist and the stream never starts.

### Evidence gathered

| Test | Result | Rules out |
|------|--------|-----------|
| Fresh credentials (new login, new UUID) | still fails | token expiry |
| Cloud calls (login, account, guide/lineup) | **work** | account/cloud credentials |
| Only the device `/watch` HMAC is rejected | fails | anything above the device layer |
| Original **upstream** files (unmodified) | **same failure** | any change made in this fork |
| Tablo device power-cycle | no change | stuck device/session state |
| PC clock verified / re-synced | no change | signature timestamp skew |

### Conclusion

The rejection is at the **device-level HMAC signature**, it reproduces on
unmodified upstream code, and every environmental cause has been eliminated.
That points to a **Tablo-side change to the device signing** — most likely a
rotation of the shared keys or a change to the signing scheme, pushed via a
device firmware update. If so, it breaks **all** tablo2plex users
simultaneously, not just this one.

### Where the signing lives

`src/Encryption.js` → `makeDeviceAuth(method, url, msg, date)` builds:

```
full_str = method + "\n" + url + "\n" + md5(msg) + "\n" + date
signature = HMAC-MD5(full_str, HashKey)
Authorization = "tablo:" + DeviceKey + ":" + hex(signature)
```

with the built-in constants (overridable via env):

- `HashKey` default `6l8jU5N43cEilqItmT3U2M2PFM3qPziilXqau9ys`
- `DeviceKey` default `ljpg6ZkwShVv8aI12E2LP55Ep8vq1uYDPvX0DdTB`

If Tablo rotated these (or changed `full_str`/hash), the fix is to recover the
new values.

### Recovering the new keys

1. `node tools/device-info.js` — dumps the device's full `/server/info`
   (firmware version) and probes endpoints. Confirms the running firmware.
2. Capture the device's OTA update image (watch its update-check traffic:
   `tcpdump host <device-ip>` / Wireshark), then `binwalk -e firmware.bin`.
3. Locate the signing constants / signing routine in the extracted firmware
   and compare against `makeDeviceAuth`. Update the keys (or the scheme) to
   match.

Until the new keys/scheme are recovered, no version of the proxy can stream —
this is not fixable in application code alone.

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
  fix the HMAC key rotation described above.
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
> Windows release (exe + bundled ffmpeg). Includes a device/firmware recon
> tool. See `PERFORMANCE_AND_SECURITY_REVIEW.md` and `UPSTREAM_HANDOFF.md`.
>
> Note: does not address the current device-`/watch` "Authentication failure"
> (Tablo-side signing change) — see the root-cause analysis in
> `UPSTREAM_HANDOFF.md` §1.
