# Security Notes

Tablo2Plex runs an **unauthenticated HTTP server** (default port `8181`). This
is by design — it emulates an HDHomeRun tuner, and Plex's HDHomeRun discovery
expects to reach it without credentials. That means anything able to reach the
port can read your channel lineup, pull the guide, and start streams (using up
your tuners).

## Do NOT expose the port to the internet

**Do not port-forward `8181` (or whatever `PORT` you set) on your router, and
do not place the host in a DMZ.** The server has no authentication, so an
exposed port lets anyone on the internet use — or abuse — your tuners, and
automated scanners *will* find it. (If you see connections in the console from
public IP addresses instead of your LAN's `10.x` / `192.168.x` / `172.16–31.x`
range, the port is exposed — close it at the router.)

You do **not** need to expose this server for remote viewing. **Plex handles
remote access itself**, through your Plex Media Server's own secure remote
connection; Plex talks to this bridge only over your local network. Forwarding
the port gains you nothing and exposes an unauthenticated service.

Keep the bridge reachable only on your trusted LAN.

## Credentials and logs

- Your Tablo email/password are sent to Tablo's login server over **HTTPS**
  and are **never stored on disk**. Only the returned tokens are kept, stored
  **encrypted** in `creds.bin`. On new installs the encryption key is random
  per-install (`creds.key`, owner-only permissions).
- If you move an install to another machine, copy **`creds.key`** along with
  `creds.bin`, or just re-run the login.
- Debug logs (`LOG_LEVEL=debug` with `SAVE_LOG=true`) redact auth tokens, but
  can still contain identifiers — delete them when you are done debugging.

## Reporting

Found a security issue? Please open an issue (without sensitive details) or
contact the maintainer privately to coordinate a fix.
