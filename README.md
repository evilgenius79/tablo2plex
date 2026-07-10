# Tablo2Plex: HDHomeRun Proxy for Tablo TV (4th Gen)

<img src="./imgs/logo.png" width="200" alt="logo">

---

## What's changed in this fork

This fork carries a set of performance and security improvements on top of the
original project. The full review with details and reasoning is in
[PERFORMANCE_AND_SECURITY_REVIEW.md](./PERFORMANCE_AND_SECURITY_REVIEW.md).

### Channel loading & switching performance

- **Watch-session caching** — the Tablo's `/watch` response stays valid for
  ~3 minutes, so it's now cached per channel. The first tune of a channel
  still waits on the Tablo's own tuner spin-up (5–6 seconds of device
  hardware time that no proxy can remove), but **switching back to a channel
  watched in the last few minutes skips that wait entirely** and bursts
  several seconds of already-produced video so the player's buffer fills at
  once. Cached sessions are health-probed before reuse and fall back to a
  fresh `/watch` automatically.
- **Faster ffmpeg startup** — input probing limits (`-fflags
  +nobuffer+genpts`, 1 s / 1 MB probe) cut several seconds off stream start
  since the stream is copied, not transcoded. `-http_persistent 1` reuses one
  connection for segment fetches, and `-muxdelay 0 -muxpreload 0` removes the
  mpegts muxer's default 0.7 s of output buffering.
- **Cleaner channel switches** — the tuner slot is reserved *before* the
  async `/watch` call (fixes a race that could oversubscribe tuners during
  fast switching), ffmpeg is killed with SIGKILL on disconnect so the tuner
  frees instantly, response headers are flushed immediately, and ffmpeg spawn
  errors/early exits are handled instead of hanging the response.
- **No more event-loop stalls during playback** — `guide.xml` is served as a
  stream instead of one big blocking read, the guide build uses async file
  I/O, and the logger reuses a single write stream instead of opening the log
  file for every message.
- **Much faster guide/lineup updates** — guide files download 6 at a time
  over a shared keep-alive connection instead of one serial TLS handshake per
  file. Removed channels are also cleared from the lineup on update instead
  of persisting until restart.

### Security

- **Per-install credentials key** — new installs encrypt `creds.bin` with a
  random 32-byte key stored in `creds.key` (owner-only permissions) instead
  of the key baked into the public source. Existing `creds.bin` files keep
  working; re-run with `--creds` to upgrade. *If you move an install to
  another machine, copy `creds.key` along with `creds.bin`.* A corrupted or
  wrong-key creds file is now handled gracefully instead of crashing the app.
- **Docker images can no longer bake in secrets** — `.env`, `creds.bin`,
  `creds.key`, logs, and runtime state are excluded from the build context.
- **Tokens are redacted in debug logs**, and log files are created with
  owner-only permissions.
- **Wildcard CORS removed** (Plex doesn't need it; it let any website a LAN
  user visited probe the server) and `X-Forwarded-For` spoofing of logged IPs
  disabled.
- **Proper crypto randomness** (`crypto.randomBytes`/`randomUUID` instead of
  a clock-seeded Mersenne Twister) and the `keypress` git dependency pinned
  to a commit hash.

### Build

- **GitHub Actions Windows build** — the Actions tab has a "Build Windows
  exe" workflow (manual "Run workflow" button on `main`; also auto-runs on
  pushes to `claude/**` branches). Each run uploads a `tablo2plex-win-x64`
  artifact.

---

__Tablo2Plex__ is a Node.js-based server app that emulates an HDHomeRun device to allow Plex to access live TV streams from a Tablo 4th Gen device. It dynamically proxies Tablo's M3U8 `.ts` segment streams and serves them in a format Plex understands, enabling live playback and DVR functionality within Plex.

## Features

- 🧠 Emulates HDHomeRun's API (`discover.json`, `lineup.json`, etc.)
- 🔁 Parses dynamic M3U playlists from Tablo on demand
- 🎥 Streams `.ts` segments using FFmpeg via a unified stream endpoint
- 📺 Compatible with Plex Live TV & DVR interface
- 🔒 Encrypts your personal credentials
- 📃 Can also include your PseudoTV EPG as well!

## Table of Contents

- [Preface](#preface)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
  - [Node process](#node-process)
  - [Built App](#built-app)
- [Proxy Setup](#proxy-setup)
  - [Proxy Configuration](#proxy-configuration)
  - [Plex Configuration](#plex-configuration)
- [Docker Configuration](#docker-configuration) (experimental)

## Preface

With the Tablo 4th Gen devices, they added an Auth layer to their communications so you can't independently interact with them on your network. You are now forced to use only the official Tablo 4th Gen apps that are either poorly supported or non existent (see Windows). I wanted to not only fix that but expand the devices it supports while allowing you to take your streams with you wherever you go. That's how __Tablo2Plex__ was born! You can now use your Tablo device on any device that supports Plex, anywhere you go with it!

How it works:

<img src="./imgs/chart.png" width="750" alt="chart">

## Getting Started

### Prerequisites

- Node.js (to build, or use the pre-built app in [releases](https://github.com/hearhellacopters/tablo2plex/releases))
- FFmpeg installed and in your system path (included in [releases](https://github.com/hearhellacopters/tablo2plex/releases))
- Tablo account in good standing with a Tablo TV 4th Gen device on your local network, completely set up and activated
- Plex account with Plex Pass

## Installation

### Node Process

It's recommended that __Tablo2Plex__ runs on the same device as your Plex server for best performance. But as long as it's on the same network as both the Plex server and the Tablo device, it will work.

If you want to run the proxy a Node package:

```bash
git clone https://github.com/hearhellacopters/tablo2plex.git
cd tablo2plex
npm install
node app.js # or
npm run start
```

Make sure you edit your `.env` file with your personal info. See the [Configuration](#proxy-configuration) section for available variables and command lines.

---

### Built App

If you want to run the proxy as a pre-built app, check out the [releases page](https://github.com/hearhellacopters/tablo2plex/releases) and simply download it there. Can you also build your own with:

```bash
npm run build:win # or
npm run build:linux # or
npm run build:mac:arm # or
npm run build:mac:x64
```

__Note: Don't build for a system you aren't currently running.__ Mac needs code signing and that is only possible on a Mac machine.

Make sure you edit your `.env` file with your personal info. See the [Configuration](#proxy-configuration) section for available variables and command lines.

## Proxy Setup

When you first run the proxy, you will be asked to log into your Tablo account by providing your email and password. __Note: Your email and password are never stored locally and all returned credentials are stored encrypted.__ But when you first log in, your password and email is transmitted in plain text (nice one Tablo). So please don't setup the proxy on an untrusted network.

It will ask you to select a profile or device if there is more than one on your account. Once done, it will download the channel lineup and start the proxy.

Besides the ``.env`` settings, you can run the proxy with a command line to force or overide some actions:

### Proxy Configuration

Use the ``.env`` file to set the options you would like to use with the Tablo device and proxy. You can also pass them as a command line at start.

| `.env` Variable          | Commandline        | Type      | Desc                                                                                                                                                                                                                                    |
| :---                     | :---               | :---:     | :---                                                                                                                                                                                                                                    |
| ``-none-``               | ``-c,--creds``     | `boolean` | Force the app to ask for a login again to create new credentials files (Checks every time the app runs)                                                                                                                                 |
| ``-none-``               | ``-l,--lineup``    | `boolean` | Force the app to pull a new channel line up from the Tablo servers. (Can be done at anytime while running.)                                                                                                                             |
|``NAME``                  | ``-n,--name``      | `string`  | Name of the device that shows up in Plex. Default `"Tablo 4th Gen Proxy"`                                                                                                                                                               |
|``DEVICE_ID``             | ``-f,--id``        | `string`  | Fake ID of the device for when you have more than one device on the network. Default `"12345679"`                                                                                                                                       |
|``PORT``                  | ``-p,--port``      | `string`  | Change the port the app runs on (default ``8181``)                                                                                                                                                                                      |
|``LINEUP_UPDATE_INTERVAL``| ``-i,--channels``  | `string`  | How often the app will repopulate the channel lineup. Default once every ``30`` days. Can be triggered any time the proxy is running.                                                                                                   |
|``CREATE_XML``            | ``-x,--xml``       | `boolean` | Creates an XML guide file from Tablo's data instead of letting Plex populate it with their data. Can take much longer to build and happens more often but is more accurate. Builds 2 days worth on content every day. Default ``false`` |
|``GUIDE_DAYS``            | ``-d,--days``      | `number`  | The amount of days the guide will populate. The more days, the longer it will take to populate on update. Default ``2``, max ``7``                                                                                                      |
|``INCLUDE_PSEUDOTV_GUIDE``| ``-s,--pseudo``    | `boolean` | Due to issues with Plex not loading more than one EPG, you can include the guide data with your guide as long as it's at /.pseudotv/xmltv.xml. Default ``false``                                                                        |
|``LOG_LEVEL``             | ``-g,--level``     | `string`  | The amount of data you would like to see in the console. `"debug", "warn", "error" or "info"`. Default ``error`` and lower<br>Note: It's recommended after using `"debug"` that you clear your log files if any were generated.         |
|``SAVE_LOG``              | ``-k,--log``       | `boolean` | Create a file of all console output to the /logs folder. Default ``false``                                                                                                                                                              |
|``OUT_DIR``               | ``-o,--outdir``    | `string`  | Overide the output directory. Default is excution directory. (Disabled in `.env` by default)                                                                                                                                            |
|``TABLO_DEVICE``          | ``-v,--device``    | `string`  | Server ID of the Tablo device to use if you have more than one on your account. (Disabled in `.env` by default)                                                                                                                         |
|``USER_NAME``             | ``-u,--user``      | `string`  | Username to use for when creds.bin isn't present. (Disabled in `.env` by default)                                                                                                                                                       |
|``USER_PASS``             | ``-w,--pass``      | `string`  | Password to use for when creds.bin isn't present. (Disabled in `.env` by default)                                                                                                                                                       |
|``IP_ADDRESS``            | ``-a,--ip_address``| `string`  | Set the IP Address of Tablo2Plex add statically. (Disabled in `.env` by default)                                                                                                                                                        |
|``GUIDE_UPDATE_INTERVAL`` | ``-e,--guide``     | `number`  | How often to update your XML guide data in hours. Default ``24``                                                                                                                                                                        |
|``INCLUDE_OTT``           | ``-t, --ott``      | `boolean` | Include OTT (Over-The-Top) channels in the line up. Default ``true``                                                                                                                                                                    |

### Plex Configuration

1. Open Plex and go to __Live TV & DVR > Setup__
2. Plex should detect the device proxy automatically, if not you can add the displaying http address and port from the proxy.
3. Follow the guide scan using a ZIP code or use the displaying XML endpoint instead
4. Start watching live TV via Tablo!

*The 4th Gen Tablo devices no longer populate the channel guide through the device. The Tablo apps connects to a 3rd party that populates it within the Tablo app so it can control the DRV and many other features. If you are interested in keeping things simple, use the Plex's guide data instead of creating an XML guide yourself.

## Docker Configuration

*Note: Support here is experimental.*

First, clone the repo locally to a machine where you have Docker and Node.js installed. The Dockerfile and .dockerignore files for building the image are included in the project. Inside the cloned directory, build the tablo2plex image:

```bash
docker build -t tablo2plex .
```

This process will create a Node.js-based image with the required additional modules and ffmpeg installed to support tablo2plex. Now build and run the container via the [Docker run](https://docs.docker.com/reference/cli/docker/container/run/) command-line:

```bash
docker run -d -v ./output:/output -e USER_NAME=<your Tablo username> -e USER_PASS=<your Tablo password> tablo2plex
```

If everything goes right and the container starts, you should see files in your ./output directory (or whatever directory you mounted to the /output volume for the container), including the logs subdirectory. The log should show something like this:

```cmd
[info] No creds file found. Lets log into your Tablo account.
[info] NOTE: Your password and email are never stored, but are transmitted in plain text.
Please make sure you are on a trusted network before you continue.
[info] Login was accepted!
[info] Using profile Profile 1
[info] Using device Tablo SID_<sid> @ http://192.168.1.134:8887
[info] Getting account token.
[info] Account token found!
[info] Connecting to device.
[info] Found Tablo 4G DUAL 128GB with 2 max tuners found!
[info] Credentials successfully created!
[info] Credentials successfully encrypted! Ready to use the server!
[info] Requesting a new channel lineup file!
[info] Successfully created new channel lineup file!
[info] Update channel lineup finished running. Next run scheduled for Mon, 17 Nov 2025 18:33:25 GMT
[info] Server v0.9.3 is running on http://172.17.0.2:8181 with 2 tuners
```

You can override additional environment variables by adding more `-e` parameters to the Docker command-line (ex. `-e GUIDE_DAYS=7 -e LOG_LEVEL=debug`). Once the creds.bin file is created with your encypted TabloTV credentials, you no longer need to specify the `USER_NAME` and `USER_PASS` parameters (this will also prevent your credentials from showing up on the command-line in a process list: the defaults of 'user' and 'pass' will appear but the program won't actually try to use them since the __creds.bin__ file is already present).

Instead of the Docker command-line, you can also use a [Docker compose](https://docs.docker.com/reference/cli/docker/compose/) file. An [example YAML file](docker-compose-example.yaml) is included in the repo. Modify it for your particular environment and then use it to build and run the container:

```bash
docker compose -f compose.yaml up -d
```

Like with the command-line approach, once your creds.bin file is present in the mounted /output volume, you can remove the `USER_NAME` and `USER_PASS` values from the file if you wish.

Running in Container Manager on a Synology NAS, it looks something like this:

### Creating the container

<img src="./imgs/docker1.png" width="750" alt="docker1"/>

### Mounted volume

<img src="./imgs/docker2.png" width="750" alt="docker2">

### Container logs

<img src="./imgs/docker3.png" width="750" alt="docker3">

You should now have __Tablo2Plex__ running in a Docker container! [Configure Plex](#plex-configuration) and point it to the URL/port of __Tablo2Plex__.

---

## License

MIT License

---

## Credits

Built with ❤️ by HearHellacopters
