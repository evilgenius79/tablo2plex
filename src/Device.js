// @ts-check
/**
 * @typedef {import('express').Response} Response
 * @typedef {import('express').Request} Request
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const XMLWriter = require('xml-writer');
const { spawn } = require('child_process');

const {
    exit,
    choose,
    input
} = require('./CommandLine');
const {
    C_HEX,
    CONST
} = require('./Constants');
const Encryption = require('./Encryption');
const FS = require('./FS');
const JSDate = require('./JSDate');
const Logger = require('./Logger');

/**
 * @typedef masterCreds
 * @property {string} lighthousetvAuthorization - For lighthousetv transmissions
 * @property {string} lighthousetvIdentifier - For lighthousetv transmissions
 * @property {{identifier:string, name:string, date_joined:string, preferences:object}} profile
 * @property {{serverId:string, name:string, type:string, product:string, version:string, buildNumber:number, registrationStatus:string, lastSeen:string, reachability:string, url:string}} device
 * @property {string} Lighthouse
 * @property {string} UUID
 * @property {number} tuners
 */

/**
 * @type {masterCreds | any}
 */
const CREDS_DATA = {};

/**
 * Source path to lineup.json
 */
const LINEUP_FILE = path.join(CONST.DIR_NAME, "lineup.json");

/**
 * @type {{[key:string]:{GuideNumber:string, GuideName:string, ImageURL?:string, Affiliate?: string, VideoCodec?: string, AudioCodec?: string, HD?: number, URL:string, type:string, srcURL:string, streamUrl: string}}}
 */
const LINEUP_DATA = {};

/**
 * Source path to guide.xml
 */
const GUIDE_FILE = path.join(CONST.DIR_NAME, "guide.xml");

/**
 * Source path to the per-install creds encryption key.
 *
 * Created alongside creds.bin on new installs. Older installs without
 * this file fall back to the legacy built-in key.
 */
const KEY_FILE = path.join(CONST.DIR_NAME, "creds.key");

/**
 * Shared keep-alive agent so repeated cloud requests (guide caching)
 * reuse TCP/TLS connections instead of handshaking per request.
 */
const KEEP_ALIVE_AGENT = new https.Agent({ keepAlive: true, maxSockets: 8 });

/**
 * Copies an object with sensitive token fields masked, for safe debug logging.
 *
 * @param {any} obj
 * @returns {any}
 */
function redactForLog(obj) {
    if (obj == null || typeof obj != "object") {
        return obj;
    }

    const SENSITIVE = ["authorization", "lighthouse", "access_token", "refresh_token", "token"];

    /**
     * @type {any}
     */
    const copy = Array.isArray(obj) ? [] : {};

    for (const key in obj) {
        const value = obj[key];

        if (SENSITIVE.includes(key.toLowerCase()) && typeof value == "string") {
            copy[key] = value.slice(0, 6) + "...[redacted]";
        } else {
            copy[key] = value;
        }
    }

    return copy;
};

/**
 * Cache of recent Tablo watch sessions per channel.
 *
 * A /watch response stays valid for ~3 minutes, so flipping back to a
 * recently watched channel can skip the 5-6 second tuner spin-up — and since
 * the Tablo kept producing segments meanwhile, ffmpeg can burst a few
 * seconds of video immediately, which fills the client's buffer at once.
 *
 * @type {{[channelId:string]: {playlist_url:string, expires:number}}}
 */
const WATCH_CACHE = {};

/**
 * True when a device response is an expired-session / auth rejection.
 *
 * @param {any} json
 * @returns {boolean}
 */
function isUnauthorized(json) {
    return !!(json && json.error && (
        json.error.code == "unauthorized" ||
        /auth/i.test(json.error.description || "")
    ));
};

/**
 * In-flight token refresh, shared so many channels failing at once trigger
 * only a single re-login.
 *
 * @type {Promise<boolean>|null}
 */
var REFRESH_INFLIGHT = null;

/**
 * Silently re-logs in with the stored USER_NAME/USER_PASS to refresh the
 * expired Tablo session tokens, reusing the already-selected profile/device,
 * then persists the refreshed creds. Returns whether it succeeded.
 *
 * @returns {Promise<boolean>}
 */
async function refreshTokens() {
    if (CONST.USER_NAME == null || CONST.USER_PASS == null) {
        Logger.error("Session token expired but USER_NAME/USER_PASS are not set — cannot auto re-login. Re-run the app with --creds (or delete creds.bin) to log in again.");

        return false;
    }

    if (!CREDS_DATA.profile || !CREDS_DATA.device) {
        Logger.error("Cannot refresh tokens — stored profile/device missing. Re-run credentials.");

        return false;
    }

    const host = "lighthousetv.ewscloud.com";

    try {
        // 1. log in for a fresh access token
        const loginResp = JSON.parse(await makeHTTPSRequest("POST", host, "/api/v2/login/", {
            'User-Agent': 'Tablo-FAST/2.0.0 (Mobile; iPhone; iOS 16.6)',
            'Content-Type': 'application/json',
            'Accept': '*/*'
        }, JSON.stringify({ password: CONST.USER_PASS, email: CONST.USER_NAME })));

        if (!loginResp.access_token || !loginResp.token_type) {
            Logger.error("Auto re-login failed: no access token returned.");

            return false;
        }

        const authorization = `${loginResp.token_type} ${loginResp.access_token}`;

        // 2. re-select the stored profile/device for a fresh Lighthouse token
        const selectResp = JSON.parse(await makeHTTPSRequest("POST", host, "/api/v2/account/select/", {
            'User-Agent': 'Tablo-FAST/2.0.0 (Mobile; iPhone; iOS 16.6)',
            'Content-Type': 'application/json',
            'Accept': '*/*',
            'Authorization': authorization
        }, JSON.stringify({ pid: CREDS_DATA.profile.identifier, sid: CREDS_DATA.device.serverId })));

        if (!selectResp.token) {
            Logger.error("Auto re-login failed: no account token returned.");

            return false;
        }

        CREDS_DATA.lighthousetvAuthorization = authorization;

        CREDS_DATA.Lighthouse = selectResp.token;

        // persist the refreshed tokens so a restart keeps them
        try {
            const key = FS.fileExists(KEY_FILE) ? FS.readFile(KEY_FILE) : Encryption.newKey();

            if (!FS.fileExists(KEY_FILE)) {
                FS.writeFile(key, KEY_FILE, 0o600);
            }

            FS.writeFile(Encryption.crypt(JSON.stringify(CREDS_DATA), key), CONST.CREDS_FILE, 0o600);
        } catch (error) {
            Logger.error("Refreshed tokens but could not persist creds:", error);
        }

        Logger.info("Tablo session token refreshed via auto re-login.");

        return true;
    } catch (error) {
        Logger.error("Auto re-login failed:", error);

        return false;
    }
};

/**
 * Refreshes tokens, collapsing concurrent callers onto one attempt.
 *
 * @returns {Promise<boolean>}
 */
async function refreshTokensOnce() {
    if (!REFRESH_INFLIGHT) {
        REFRESH_INFLIGHT = refreshTokens().finally(() => { REFRESH_INFLIGHT = null; });
    }

    return REFRESH_INFLIGHT;
};

/**
 * Returns a playlist URL for the channel — from the session cache when the
 * previous session is still alive, otherwise via a fresh /watch request.
 *
 * @param {string} channelId
 * @returns {Promise<string|null>}
 */
async function getPlaylistUrl(channelId) {
    const cached = WATCH_CACHE[channelId];

    if (cached && cached.expires - Date.now() > 15000) {
        // quick probe that the Tablo hasn't torn the session down early
        try {
            const probe = await fetch(cached.playlist_url, { signal: AbortSignal.timeout(1500) });

            if (probe.ok) {
                await probe.arrayBuffer();

                Logger.debug(`Reusing cached watch session for ${channelId} — skipping tuner spin-up.`);

                return cached.playlist_url;
            }
        } catch (error) {
            // fall through to a fresh /watch
        }

        delete WATCH_CACHE[channelId];
    }

    const channelReq = await reqTabloDevice("POST", CREDS_DATA.device.url, `/guide/channels/${channelId}/watch`, CREDS_DATA.UUID, "lh");

    /**
     * @type {{token: string, expires: string, keepalive: number, playlist_url: string, video_details: {container_format: string, flags: any[]}, error?: {code:string, description:string}}}
     */
    var channelJSON = JSON.parse(channelReq.toString());

    // The device rejects the watch when the stored Tablo session token has
    // expired ("unauthorized" / "Authentication failure"). Try a silent
    // re-login (needs USER_NAME/USER_PASS) and one retry before giving up.
    if (channelJSON.playlist_url == undefined && isUnauthorized(channelJSON)) {
        Logger.warn("Tablo rejected the watch request as unauthorized — attempting token refresh...");

        if (await refreshTokensOnce()) {
            const retryReq = await reqTabloDevice("POST", CREDS_DATA.device.url, `/guide/channels/${channelId}/watch`, CREDS_DATA.UUID, "lh");

            channelJSON = JSON.parse(retryReq.toString());
        }
    }

    if (channelJSON.playlist_url == undefined) {
        Logger.error('playlist_url missing from requested channel:');

        Logger.error(redactForLog(channelJSON));

        return null;
    }

    Logger.debug("Tablo Response:");

    Logger.debug(redactForLog(channelJSON));

    const expires = new Date(channelJSON.expires).getTime();

    if (!isNaN(expires)) {
        WATCH_CACHE[channelId] = {
            playlist_url: channelJSON.playlist_url,
            expires: expires
        };
    }

    return channelJSON.playlist_url;
};

/**
 * Runs async tasks with a fixed concurrency limit.
 *
 * @param {(() => Promise<void>)[]} tasks
 * @param {number} limit
 */
async function runWithConcurrency(tasks, limit) {
    var index = 0;

    const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
        while (index < tasks.length) {
            const task = tasks[index++];

            await task();
        }
    });

    await Promise.all(workers);
};

/**
 * Amount of streams allowed
 */
var TUNER_COUNT = 2;

/**
 * Count for running streams (active streams AND warm-held tuners).
 */
var CURRENT_STREAMS = 0;

/**
 * How long (seconds) to keep a tuner session alive after the client
 * disconnects, so flipping back to a just-watched channel is instant instead
 * of paying the Tablo's 5-6s tuner spin-up again.
 *
 * Opt-in: a warm tuner still occupies a physical tuner, so this trades tuner
 * availability for switch speed. 0 disables it (default). Set e.g. 60 to make
 * quick channel surfing instant. Read from env directly to avoid the full
 * Constants plumbing while this is experimental.
 */
const WARM_TUNER_SECONDS = Math.max(0, parseInt(process.env.WARM_TUNER_SECONDS || "0", 10) || 0);

/**
 * Channels currently held warm after a client left.
 *
 * Each entry holds exactly one slot in CURRENT_STREAMS, released when the
 * session is evicted (grace expired, keepalive failed, or the slot was
 * reclaimed for a different channel).
 *
 * @type {{[channelId:string]: {keepalive: NodeJS.Timeout, evict: NodeJS.Timeout, since: number}}}
 */
const WARM_SESSIONS = {};

/**
 * Fully releases a warm session and frees its tuner slot.
 *
 * @param {string} channelId
 */
function evictWarm(channelId) {
    const warm = WARM_SESSIONS[channelId];

    if (!warm) {
        return;
    }

    clearInterval(warm.keepalive);

    clearTimeout(warm.evict);

    delete WARM_SESSIONS[channelId];

    CURRENT_STREAMS = Math.max(0, CURRENT_STREAMS - 1);

    Logger.info(`Released warm tuner for ${channelId}.`);
};

/**
 * Evicts the oldest warm session to free a slot for a new stream.
 *
 * @returns {boolean} true if a slot was freed
 */
function evictOldestWarm() {
    var oldestId = null;

    var oldestSince = Infinity;

    for (const id in WARM_SESSIONS) {
        if (WARM_SESSIONS[id].since < oldestSince) {
            oldestSince = WARM_SESSIONS[id].since;

            oldestId = id;
        }
    }

    if (oldestId != null) {
        evictWarm(oldestId);

        return true;
    }

    return false;
};

/**
 * Keeps a channel's tuner session alive after the client disconnects by
 * periodically re-fetching its playlist. The held slot is handed off from the
 * request that started it — this function does not change CURRENT_STREAMS.
 *
 * @param {string} channelId
 */
function startWarm(channelId) {
    // reset any existing warm timers for this channel
    const existing = WARM_SESSIONS[channelId];

    if (existing) {
        clearInterval(existing.keepalive);

        clearTimeout(existing.evict);
    }

    const keepalive = setInterval(async () => {
        const cached = WATCH_CACHE[channelId];

        if (!cached) {
            evictWarm(channelId);

            return;
        }

        try {
            const probe = await fetch(cached.playlist_url, { signal: AbortSignal.timeout(2500) });

            if (probe.ok) {
                await probe.arrayBuffer();
            } else {
                evictWarm(channelId);
            }
        } catch (error) {
            evictWarm(channelId);
        }
    }, 10000);

    const evict = setTimeout(() => evictWarm(channelId), WARM_TUNER_SECONDS * 1000);

    WARM_SESSIONS[channelId] = { keepalive, evict, since: Date.now() };

    Logger.info(`Keeping ${channelId} tuner warm for ${WARM_TUNER_SECONDS}s.`);
};

/**
 * @typedef {OtaType | OttType} channelLineup
 * 
 * @typedef {Object} OtaType
 * @property {string} identifier
 * @property {string} name
 * @property {"ota"} kind - The kind property must be "ota".
 * @property {Logos[]} logos
 * @property {Kind} ota - The ota property with data.
 * 
 * @typedef {Object} OttType
 * @property {string} identifier
 * @property {string} name
 * @property {"ott"} kind - The kind property must be "ota".
 * @property {Logos[]} logos
 * @property {Kind} ott - The ott property with data.
 * 
 * @typedef Logos
 * @property {string} kind
 * @property {string} url
 * 
 * @typedef Kind
 * @property {number} major
 * @property {number} minor
 * @property {string} callSign
 * @property {string} network
 * @property {string} streamUrl
 * @property {string} provider
 * @property {boolean} canRecord
 */

/**
 * @typedef {episodeType | sportEventType | movieAiringType} guideInfo
 * 
 * @typedef episodeType
 * @property {string} identifier
 * @property {string} title
 * @property {{identifier:string}} channel
 * @property {string} datetime
 * @property {string} onnow
 * @property {string|null} description
 * @property {"episode"} kind
 * @property {number} qualifiers
 * @property {string[]} genres
 * @property {Images[]} images
 * @property {number} duration
 * @property {{identifier:string, title:string, sortTitle:string, sectionTitle:string}} show
 * @property {{season: {kind:string, number?:number, string?:string}, episodeNumber:number|null, originalAirDate:string|null, rating:string|null}} episode
 * 
 * @typedef movieAiringType
 * @property {string} identifier
 * @property {string} title
 * @property {{identifier:string}} channel
 * @property {string} datetime
 * @property {string} onnow
 * @property {string|null} description
 * @property {"movieAiring"} kind
 * @property {number} qualifiers
 * @property {string[]} genres
 * @property {Images[]} images
 * @property {number} duration
 * @property {{identifier:string, title:string, sortTitle:string, sectionTitle:string}} show
 * @property {{releaseYear:number, filmRating:string|null, qualityRating:number|null }} movieAiring
 * 
 * @typedef sportEventType
 * @property {string} identifier
 * @property {string} title
 * @property {{identifier:string}} channel
 * @property {string} datetime
 * @property {string} onnow
 * @property {string|null} description
 * @property {"sportEvent"} kind
 * @property {number} qualifiers
 * @property {string[]} genres
 * @property {Images[]} images
 * @property {number} duration
 * @property {{identifier:string, title:string, sortTitle:string, sectionTitle:string}} show
 * @property {{season:string|null}} sportEvent
 * 
 * @typedef Images
 * @property {string} kind
 * @property {string} url
 */

/**
 * Function to handle Tablo streams
 * 
 * @param {Request} req
 * @param {Response} res
 * @param {string} ip
 * @param {string} channelId 
 * @param {{GuideNumber:string, GuideName:string, URL:string, type:string, srcURL:string, streamUrl: string}}  selectedChannel
 */
async function handleStreams(req, res, ip, channelId, selectedChannel){
    // Only OTA channels consume a physical tuner.
    const usesTuner = selectedChannel.type == "ota";

    // Adopt the slot from a warm session for this same channel (instant
    // switch back), otherwise reserve a new slot before any awaits so
    // concurrent requests can't both pass the check and oversubscribe.
    const adoptedWarm = usesTuner && WARM_SESSIONS[channelId] != null;

    if (adoptedWarm) {
        const warm = WARM_SESSIONS[channelId];

        clearInterval(warm.keepalive);

        clearTimeout(warm.evict);

        delete WARM_SESSIONS[channelId];
        // slot stays counted — this request now owns it
    } else if (usesTuner) {
        if (CURRENT_STREAMS >= TUNER_COUNT) {
            // all slots busy — reclaim one from a warm (idle) session if any
            evictOldestWarm();
        }

        if (CURRENT_STREAMS >= TUNER_COUNT) {
            Logger.error(`Client ${ip && ip.replace(/::ffff:/, "")} connected to ${channelId}, but max streams are running.`);

            res.status(500).send('Failed to start stream');

            return;
        }

        CURRENT_STREAMS += 1;
    }

    var released = false;

    // Set when the slot is handed to a warm session on disconnect so
    // releaseSlot() does not also decrement it.
    var handedToWarm = false;

    const releaseSlot = () => {
        if (!released) {
            released = true;

            if (usesTuner && !handedToWarm) {
                CURRENT_STREAMS -= 1;
            }
        }
    };

    try {
        const playlistUrl = await getPlaylistUrl(channelId);

        if (playlistUrl == null) {
            Logger.error(selectedChannel);

            releaseSlot();

            res.status(500).send('Failed to find playlist url.');

            return;
        }

        // The stream is copied, not transcoded, so keep ffmpeg's input probing
        // small — the defaults buffer ~5s/5MB of HLS before the first output
        // byte reaches the client. muxdelay/muxpreload drop the mpegts muxer's
        // default 0.7s of output buffering.
        const ffmpeg = spawn('ffmpeg', [
            '-fflags', '+nobuffer+genpts',
            '-analyzeduration', '1000000',
            '-probesize', '1000000',
            '-http_persistent', '1',
            '-i', playlistUrl,
            '-c', 'copy',
            '-f', 'mpegts',
            '-muxdelay', '0',
            '-muxpreload', '0',
            '-v', `repeat+level+${CONST.FFMPEG_LOG_LEVEL}`,
            'pipe:1'
        ]);

        // ffmpeg failed/exited — free the slot immediately, no warm-keeping.
        const cleanup = () => {
            releaseSlot();

            ffmpeg.kill('SIGKILL');
        };

        var clientGone = false;

        // The client left. Stop pulling into ffmpeg (SIGKILL — a graceful
        // shutdown buys nothing once the pipe is dead). If warm-keeping is
        // enabled and the session is still valid, hand this slot to a warm
        // session so switching back is instant; otherwise release it.
        const onClientGone = () => {
            if (clientGone) {
                return;
            }

            clientGone = true;

            ffmpeg.kill('SIGKILL');

            const cached = WATCH_CACHE[channelId];

            const canWarm = usesTuner &&
                WARM_TUNER_SECONDS > 0 &&
                cached != null &&
                cached.expires - Date.now() > 5000;

            if (canWarm && !released) {
                handedToWarm = true;

                released = true; // this request no longer owns the slot

                startWarm(channelId);
            } else {
                releaseSlot();
            }

            if (usesTuner) {
                Logger.info(`${C_HEX.red_yellow}[${CURRENT_STREAMS}/${TUNER_COUNT}]${C_HEX.reset} Client ${ip && ip.replace(/::ffff:/, "")} disconnected from ${channelId}, killing ffmpeg`);
            } else {
                Logger.info(`${C_HEX.red_yellow}[${CURRENT_STREAMS}/${TUNER_COUNT}]${C_HEX.reset} Client ${ip && ip.replace(/::ffff:/, "")} disconnected from ${channelId} (IPTV), killing ffmpeg`);
            }
        };

        if (usesTuner) {
            Logger.info(`${C_HEX.red_yellow}[${CURRENT_STREAMS}/${TUNER_COUNT}]${C_HEX.reset} Client ${ip.replace(/::ffff:/, "")} connected to ${channelId}, spawning ffmpeg stream.`);
        } else {
            Logger.info(`${C_HEX.red_yellow}[${CURRENT_STREAMS}/${TUNER_COUNT}]${C_HEX.reset} Client ${ip.replace(/::ffff:/, "")} connected to ${channelId} (IPTV), spawning ffmpeg stream.`);
        }

        res.setHeader('Content-Type', 'video/mp2t');

        res.flushHeaders();

        ffmpeg.stdout.pipe(res);

        ffmpeg.stderr.on('data', (data) => {
            switch (CONST.FFMPEG_LOG_LEVEL) {
                case "info":
                    Logger.info(`[ffmpeg] ${data}`);
                    break;
                case "debug":
                    Logger.debug(`[ffmpeg] ${data}`);
                    break;
                case "warning":
                    Logger.warn(`[ffmpeg] ${data}`);
                    break;
                default:
                    Logger.error(`[ffmpeg] ${data}`);
                    break;
            }
        });

        ffmpeg.on('error', (error) => {
            Logger.error('ffmpeg failed to start:', error.message);

            clientGone = true; // don't warm-keep a broken session

            cleanup();

            if (!res.headersSent) {
                res.status(500).send('Failed to start stream');
            } else {
                res.end();
            }
        });

        ffmpeg.on('close', () => {
            if (!res.writableEnded) {
                res.end();
            }
        });

        // req 'close' does not always fire when the response side ends first,
        // so listen on both; onClientGone is guarded against double-running.
        req.on('close', onClientGone);

        res.on('close', onClientGone);

        return;
    } catch (error) {
        // @ts-ignore
        Logger.error('Error starting stream:', error.message);

        releaseSlot();

        res.status(500).send('Failed to start stream');

        return;
    }
};

/**
 * Start up message
 */
function startUpMessage(){
    Logger.info(`Server v${CONST.VERSION} is running on ${C_HEX.blue}${CONST.SERVER_URL}${C_HEX.reset} with ${TUNER_COUNT} tuners`);
    if (CONST.CREATE_XML) {
        Logger.info(`Guide data can be found at ${C_HEX.blue}${CONST.SERVER_URL}/guide.xml${C_HEX.reset}`);

        const guideLoc = path.join(CONST.DIR_NAME, "guide.xml");

        Logger.info(`or ${C_HEX.blue}${guideLoc}${C_HEX.reset}`);
    }
    if (CONST.LOG_TYPE == "debug") {
        Logger.debug("Debug mode is active!");

        Logger.debug(`It is recommended that you have ${C_HEX.blue}SAVE_LOG${C_HEX.reset} = ${C_HEX.green}true${C_HEX.reset} while debugging.`);

        Logger.debug("When finished, please delete all logs as they will contain sensitive private info.");
    }
};

/**
 * Makes discover object end point data
 */
function makeDiscover(){
    return {
        FriendlyName: CONST.NAME, // "Tablo 4th Gen Proxy",
        Manufacturer: "tablo2plex",
        ModelNumber: "HDHR3-US",
        FirmwareName: "hdhomerun3_atsc",
        FirmwareVersion: "20240101",
        DeviceID: CONST.DEVICE_ID, // "12345678",
        DeviceAuth: "tabloauth123",
        BaseURL: CONST.SERVER_URL,// SERVER_URL,
        LocalIP: CONST.SERVER_URL,// SERVER_URL,
        LineupURL: `${CONST.SERVER_URL}/lineup.json`, // `${SERVER_URL}/lineup.json`
        TunerCount: TUNER_COUNT // TUNER_COUNT
    }
};

/**
 * lineup endpint
 * 
 * @param {Request} req 
 * @param {Response} res 
 */
async function _lineup(req, res) {
    const lineup = Object.values(LINEUP_DATA);

    const headers = {
        'Content-Type': 'application/json'
    };

    res.writeHead(200, headers);

    res.end(JSON.stringify(lineup));

    return;
};

/**
 * Makes Tablo device request
 * 
 * @param {string} method 
 * @param {string} host 
 * @param {string} path 
 * @param {string} msg 
 * @param {{"Content-Type"?:string,Connection?:string,Date?:string,Accept?:string,"User-Agent"?:string,"Content-Length"?:string,Authorization?:string}} headers 
 * @param {string} params 
 * @returns {Promise<Buffer>}
 */
async function makeTabloRequest(method, host, path, msg = "", headers = {}, params = "") {
    const url = host + path;

    const baseUrl = new URL(path, host);

    baseUrl.search = params;

    const date = JSDate.deviceDate();

    headers["Connection"] = "keep-alive";

    headers["Date"] = date;

    headers["Accept"] = "*/*";

    headers["User-Agent"] = "Tablo-FAST/1.7.0 (Mobile; iPhone; iOS 18.4)";

    const auth = Encryption.makeDeviceAuth(method, path, msg, date);

    var body;

    if (method == "POST" && msg != "") {
        body = Buffer.from(msg);

        headers["Content-Length"] = `${body.length}`;
    }

    headers["Authorization"] = auth;

    Logger.debug("Tablo Request:");

    Logger.debug(redactForLog(headers));

    Logger.debug(msg);

    try {
        return await fetch(
            baseUrl.toString(),
            {
                method: method,
                headers: headers,
                body: method == "POST" ? body : undefined
            }
        ).then(async response => {
            if (response) {
                return Buffer.from(await response.arrayBuffer());
            } else {
                Logger.error(`Fetch response from device ${url}`);

                return Buffer.alloc(0);
            }
        });
    } catch (error) {
        Logger.error(`Fetching device ${url}`);

        Logger.error(error);

        return Buffer.alloc(0);
    }
};

/**
 * Handles all Tablo device requests
 * 
 * @param {string} method 
 * @param {string} host 
 * @param {string} path 
 * @param {string} UUID
 * @param {string} params
 */
async function reqTabloDevice(method, host, path, UUID, params) {
    const headers = {};
    /**
     * @type {any}
     */
    const dataIn = {};
    if (method == "POST") {
        headers["Content-Type"] = "application/x-www-form-urlencoded";

        dataIn["bandwidth"] = null;

        dataIn["extra"] = {
            "limitedAdTracking": 1,
            "deviceOSVersion": "16.6",
            "lang": "en_US",
            "height": 1080,
            "deviceId": "00000000-0000-0000-0000-000000000000",
            "width": 1920,
            "deviceModel": "iPhone10,1",
            "deviceMake": "Apple",
            "deviceOS": "iOS",
        };

        dataIn["device_id"] = UUID;

        dataIn["platform"] = "ios";
    }
    return await makeTabloRequest(method, host, path, method == "POST" ? JSON.stringify(dataIn) : "", headers, params);
};

/**
 * channel end point 
 * 
 * @param {Request} req 
 * @param {Response} res 
 */
async function _channel(req, res) {
    const ip = req.ip || "";

    const channelId = Array.isArray(req.params.channelId) ? req.params.channelId.join("") : req.params.channelId;

    const selectedChannel = LINEUP_DATA[channelId];

    if (selectedChannel) {
        // check if there is a srcURL
        if (selectedChannel.srcURL == undefined) {
            Logger.error('srcURL missing from requested channel:');

            Logger.error(selectedChannel);

            res.status(500).send('Failed to find stream url.');

            return;
        }

        await handleStreams(req, res, ip, channelId, selectedChannel);

    } else {
        res.status(404).send('Channel not found');

        Logger.error(`Channel not found: ${channelId}`);

        return;
    }
};

/**
 * guide.xml end point
 * 
 * @param {Request} req 
 * @param {Response} res 
 */
async function _guide_serve(req, res) {
    // Stream the file — guide.xml can be several MB and a sync read here
    // stalls every active ffmpeg pipe on the event loop.
    const stream = fs.createReadStream(GUIDE_FILE);

    stream.on('error', () => {
        if (!res.headersSent) {
            res.status(404).send('Guide not found');
        } else {
            res.end();
        }
    });

    stream.once('open', () => {
        res.setHeader("content-type", "application/xml");
    });

    stream.pipe(res);

    return;
};

/**
 * basic https request
 * 
 * @param {string} method 
 * @param {string} hostname 
 * @param {string} path 
 * @param {any} headers 
 * @param {string|Buffer} data 
 * @param {boolean} justHeaders
 * @returns {Promise<any>}
 */
async function makeHTTPSRequest(method, hostname, path, headers, data = "", justHeaders = false) {
    return new Promise((resolve, reject) => {
        // Convert the data
        if (typeof data == "string") {
            data = Buffer.from(data);
        } else if (!(data instanceof Buffer)) {
            data = Buffer.from(JSON.stringify(data));
        }

        headers['Content-Length'] = Buffer.byteLength(data);
        // Define the options for the HTTPS request
        const options = {
            hostname: hostname,
            port: 443,
            path: path,
            method: method,
            headers: headers,
            agent: KEEP_ALIVE_AGENT
        };
        // Create the request
        const req = https.request(options, (res) => {
            let dataIn = '';
            // A chunk of data has been received.
            res.on('data', (chunk) => {
                dataIn += chunk;
            });
            // The whole response has been received. Parse and resolve the result.
            res.on('end', () => {
                if (justHeaders) {
                    resolve(res.headers);
                }

                if (res.statusCode == undefined || (res.statusCode < 200 || res.statusCode > 299)){
                    Logger.error(`https://${hostname}${path} request failed with status code:`, res.statusCode);

                    Logger.error('Error details:', dataIn);

                    reject("");
                } else {
                    try {
                        resolve(dataIn);
                    } catch (parseError) {
                        // @ts-ignore
                        reject(new Error(`Failed to parse response: ${parseError.message}`));
                    }
                }
            });
        });
        // Handle request errors
        req.on('error', (error) => {
            reject(error);
        });

        if (method == "POST") {
            // Write data to request body
            req.write(data);
        }
        // End the request
        req.end();
    });
};

/**
 * Request for new creds
 */
async function reqCreds() {
    /**
     * @type {masterCreds}
     */
    const masterCreds = {};

    var loggedIn = false;

    var max_attempts = 10;

    var attempts = 0;

    var loginCreds;

    const headers = {};

    var host;

    var path;

    do {
        attempts++;

        const user = CONST.USER_NAME != null ? CONST.USER_NAME : await input("What is your email?");

        const pass = CONST.USER_PASS != null ? CONST.USER_PASS : await input("What is your password?", true);

        const credsData = {
            password: pass,
            email: user,
        };

        host = `lighthousetv.ewscloud.com`;

        path = "/api/v2/login/";

        headers['User-Agent'] = 'Tablo-FAST/2.0.0 (Mobile; iPhone; iOS 16.6)';

        headers['Content-Type'] = 'application/json';

        headers['Accept'] = '*/*';
        
        try {
            const retData = await makeHTTPSRequest("POST", host, path, headers, JSON.stringify(credsData));
        
            loginCreds = JSON.parse(retData);

            if (loginCreds.code == undefined) {
                Logger.debug("lighthousetv login");

                Logger.debug(redactForLog(loginCreds));

                if (loginCreds.is_verified != true) {
                    Logger.info(`${C_HEX.blue}NOTE:${C_HEX.reset} While password was accepted, account is not verified.\nPlease check email to make sure your account is fully set up. There may be issues later.`);
                }

                if (loginCreds.token_type != undefined && loginCreds.access_token != undefined) {
                    Logger.info(`Login was accepted!`);

                    loginCreds.Authorization = `${loginCreds.token_type} ${loginCreds.access_token}`;

                    loggedIn = true;

                    attempts = max_attempts;
                }
            } else {
                if (loginCreds.code) {
                    Logger.error(`Login was not accepted: ${loginCreds.message}`);
                } else {
                    Logger.error(`Login was not successful, try again later!`);

                    return await exit();
                }
            }
        } catch (error) {
            Logger.error(`Login was not accepted or had issues, try again!`);

            if(error != ""){
                Logger.error(error);
            }
        }
    } while (attempts != max_attempts);

    if(!loggedIn && attempts == max_attempts){
        Logger.error(`Reached max login attempts, try again later!`);

        return await exit();
    }
    // we should have access_token and token_type by now
    const lighthousetvAuthorization = loginCreds.Authorization;

    masterCreds.lighthousetvAuthorization = lighthousetvAuthorization;

    path = '/api/v2/account/';

    headers["Authorization"] = lighthousetvAuthorization;

    var selectedDevice = false;

    var deviceData;

    do {
        try {
            const retData = await makeHTTPSRequest("GET", host, path, headers);
        
            deviceData = JSON.parse(retData);

            if (deviceData.identifier == undefined) {
                Logger.error(`User identifier missing from return. Please check your account and try again.`);

                return await exit();
            } else {
                masterCreds.lighthousetvIdentifier = deviceData.identifier;
            }

            if (deviceData.code == undefined) {
                Logger.debug("lighthousetv account");

                Logger.debug(deviceData);

                // lets get the profile
                if (deviceData.profiles == undefined) {
                    Logger.error(`User profile data missing from return. Please check your account and try again.`);

                    return await exit();
                } else if (deviceData.profiles.length == 1) {
                    const profile = deviceData.profiles[0];

                    masterCreds.profile = profile;

                    Logger.info(`Using profile ${profile.name}`);
                } else {
                    // lets select which profile we want to use
                    const list = [];

                    for (let i = 0; i < deviceData.profiles.length; i++) {
                        const el = deviceData.profiles[i];

                        list.push(
                            { value: el.name }
                        );
                    }

                    if (CONST.AUTO_PROFILE) {
                        const profile = deviceData.profiles[0];

                        masterCreds.profile = profile;

                        Logger.info(`Using profile ${profile.name}`);
                    } else {
                        const answer = await choose("Select which profile to use.", list);

                        const profile = deviceData.profiles.find((/**@type {{name:string}}*/el) => el.name == answer);

                        masterCreds.profile = profile;

                        Logger.info(`Using profile ${profile.name}`);
                    }
                }

                // lets get the device
                if (deviceData.devices == undefined) {
                    Logger.error(`User device data missing from return. Please check your account and try again.`);

                    return await exit();
                } else if (deviceData.devices.length == 1) {
                    const device = deviceData.devices[0];

                    masterCreds.device = device;

                    Logger.info(`Using device ${device.name} ${device.serverId} @ ${device.url}`);

                    selectedDevice = true;
                } else {
                    // lets select which device we want to use
                    if (CONST.TABLO_DEVICE) {
                        const device = deviceData.devices.find((/**@type {{serverId:string}}*/el) => el.serverId == CONST.TABLO_DEVICE);

                        if (device) {
                            masterCreds.device = device;

                            Logger.info(`Using device ${device.name} ${device.serverId} @ ${device.url}`);

                            selectedDevice = true;
                        } else {
                            Logger.error(`Device with serverId ${CONST.TABLO_DEVICE} not found.`);

                            Logger.warn("Falling back to manual selection.");
                        }
                    }

                    if (!selectedDevice) {
                        const list = [];

                        for (let i = 0; i < deviceData.devices.length; i++) {
                            const el = deviceData.devices[i];

                            list.push(
                                { value: el.serverId }
                            );
                        }

                        const answer = await choose("Select which device to use with Plex.", list);

                        const device = deviceData.devices.find((/**@type {{serverId:string}}*/el) => el.serverId == answer);

                        masterCreds.device = device;

                        Logger.info(`Using device ${device.name} ${device.serverId} @ ${device.url}`);

                        selectedDevice = true;
                    }
                }
            } else {
                if (deviceData.code) {
                    Logger.error(`Account login was not accepted: ${deviceData.message}`);
                } else {
                    Logger.error(`Account login was not successful, try again!`);

                    return await exit();
                }
            }
        } catch (error) {
            Logger.error(`Account login was not accepted or had issues, try again!`);

            Logger.error(error);

            return await exit();
        }
    } while (!selectedDevice);

    Logger.info(`Getting account token.`);

    var gotLighthouse = false;

    var lighthouseData;

    path = "/api/v2/account/select/";

    do {
        const req = {
            pid: masterCreds.profile.identifier,
            sid: masterCreds.device.serverId
        };

        try {
            const retData = await makeHTTPSRequest("POST", host, path, headers, JSON.stringify(req));

            lighthouseData = JSON.parse(retData);

            if (lighthouseData.token != undefined) {
                Logger.info(`Account token found!`);

                masterCreds.Lighthouse = lighthouseData.token;

                gotLighthouse = true;
            } else {
                Logger.error(`Account token was not found, try again!`);

                return await exit();
            }
        } catch (error) {
            Logger.error(`Account token was not accepted or had issues, try again!`);

            Logger.error(error);

            return await exit();
        }
    } while (!gotLighthouse);

    headers["Lighthouse"] = masterCreds.Lighthouse;

    const uuid = Encryption.UUID();

    masterCreds.UUID = typeof uuid == "string" ? uuid : "";

    Logger.info(`Connecting to device.`);

    const firstReq = await reqTabloDevice("GET", masterCreds.device.url, `/server/info`, masterCreds.UUID, "lh");

    try {
        const reqPars = JSON.parse(firstReq.toString());

        if (reqPars && reqPars.model && reqPars.model.tuners) {
            masterCreds.tuners = reqPars.model.tuners;

            TUNER_COUNT = reqPars.model.tuners;

            Logger.info(`Found ${reqPars.model.name} with ${TUNER_COUNT} max tuners found!`);

            Logger.debug("server info");

            Logger.debug(reqPars);
        }
    } catch (error) {
        Logger.error(`Could not reach device. Make sure it's on the same network and try again!`);

        return await exit();
    }

    Logger.info(`Credentials successfully created!`);

    Object.assign(CREDS_DATA, masterCreds);

    // New installs get a random per-install key (stored owner-only next to
    // creds.bin) instead of the key baked into the public source.
    const credsKey = Encryption.newKey();

    FS.writeFile(credsKey, KEY_FILE, 0o600);

    const encryCreds = Encryption.crypt(JSON.stringify(masterCreds), credsKey);

    FS.writeFile(encryCreds, CONST.CREDS_FILE, 0o600);

    Logger.info(`Credentials successfully encrypted! Ready to use the server!`);

    return 1;
};

/**
 * Requests new creds file
 */
async function readCreds() {
    if (CREDS_DATA.UUID == undefined) {
        const masterCreds = FS.readFile(CONST.CREDS_FILE);

        // Installs made before per-install keys existed have no key file and
        // fall back to the legacy built-in key inside Encryption.
        var credsKey = undefined;

        if (FS.fileExists(KEY_FILE)) {
            credsKey = FS.readFile(KEY_FILE);
        }

        const encryCreds = Encryption.decrypt(masterCreds, credsKey);

        if (encryCreds[0] != 0x7B) {
            try {
                Logger.error("Issue decrypting creds file. Removing creds file. Please start app again or use --creds command line to create a new file.");

                fs.unlinkSync(CONST.CREDS_FILE);

                if (FS.fileExists(KEY_FILE)) {
                    fs.unlinkSync(KEY_FILE);
                }

                return await exit();
            } catch (error) {
                Logger.error("Issue decrypting creds file, could not delete bad file. Your app may have read write issues. Please check your folder settings and start the app again or use --creds command line to create a new file.");

                return await exit();
            }
        }
        try {
            Object.assign(CREDS_DATA, JSON.parse(encryCreds.toString()));

            TUNER_COUNT = CREDS_DATA.tuners;
        } catch (error) {
            try {
                Logger.error("Issue reading decrypted creds file, Removing creds file. Please start app again or use --creds command line to create a new file.");

                fs.unlinkSync(CONST.CREDS_FILE);

                if (FS.fileExists(KEY_FILE)) {
                    fs.unlinkSync(KEY_FILE);
                }

                return await exit();
            } catch (error) {
                Logger.error("Issue reading creds file, could not delete bad file. Your app may have read write issues. Please check your folder settings and start the app again or use --creds command line to create a new file.");

                return await exit();
            }
        }
    } else {
        return;
    }
};

/**
 * Creates XML guide data from downloaded guide files
 * 
 * @param {channelLineup[]} lineUp 
 */
async function parseGuideData(lineUp) {
    try {
        const guideDays = JSDate.getDaysFromToday(CONST.GUIDE_DAYS);

        const xw = new XMLWriter(true);

        xw.startDocument("1.0","UTF-8");

        xw.startElement('tv');

        xw.writeAttribute('generator-info-name', CONST.NAME);

        for (let i = 0; i < lineUp.length; i++) {
            const el = lineUp[i];

            if(CONST.INCLUDE_OTT == false && el.kind == "ott"){
                continue;
            }

            // write channel
            xw.startElement('channel');

            var channelNum = "";

            if (el.kind == "ota") {
                channelNum = `${el.ota.major}${el.ota.minor}1`;

                xw.writeAttribute('id', channelNum);

                xw.startElement('display-name');

                xw.writeAttribute('lang', 'en');

                xw.text(el.ota.network);

                xw.endElement(); // display-name
            } else {
                channelNum = `${el.ott.major}${el.ott.minor}1`;

                xw.writeAttribute('id', channelNum);

                xw.startElement('display-name');

                xw.writeAttribute('lang', 'en');

                xw.text(el.ott.network);

                xw.endElement(); // display-name
            }

            if (el.logos.length != 0) {
                xw.startElement('icon');

                const lightLarge = el.logos.find(self => self.kind == "lightLarge");

                if (lightLarge) {
                    xw.writeAttribute('src', lightLarge.url);
                } else {
                    xw.writeAttribute('src', el.logos[0].url);
                }

                xw.endElement(); // icon
            }

            xw.endElement(); // channel

            /**
             * @type {guideInfo[][]}
             */
            const filesData = [];

            var totalForChannel = 0;

            var curCount = 0;

            for (let z = 0; z < guideDays.length; z++) {
                const guideDay = guideDays[z];

                const fileNameTD = el.identifier + "_" + guideDay + ".json";

                const fileTD = path.join(CONST.DIR_NAME, "tempGuide", fileNameTD);

                /**
                 * @type {guideInfo[]}
                 */
                var tdData = [];

                try {
                    // async read so live streams keep flowing while the
                    // guide is being rebuilt
                    tdData = JSON.parse(await fs.promises.readFile(fileTD, 'utf8'));
                } catch (error) {
                    Logger.error("Could not read guide data file: " + fileTD);
                }

                filesData.push(tdData);

                totalForChannel += tdData.length;
            }

            Logger.info(`Creating ${el.name} - ${channelNum} guide data.`);

            //write programme
            for (let q = 0; q < filesData.length; q++) {
                const tdData = filesData[q];

                for (let z = 0; z < tdData.length; z++) {
                    const tdEL = tdData[z];

                    const end = new Date(tdEL.datetime).getTime() + (tdEL.duration * 1000);

                    if (end > Date.now()) {
                        const startDate = JSDate.getXMLDateString(tdEL.datetime);

                        const endDate = JSDate.getXMLDateString(end);

                        // parse data
                        xw.startElement('programme');

                        xw.writeAttribute('start', startDate);

                        xw.writeAttribute('stop', endDate);

                        xw.writeAttribute('channel', channelNum);

                        xw.startElement('title');

                        xw.writeAttribute('lang', 'en');

                        if (tdEL.kind == "episode" &&
                            tdEL.episode.episodeNumber != null
                        ) {

                            xw.text(tdEL.show.title.replace(/[\n\r]+/g, " "));

                            xw.endElement(); // title

                            //xw.writeRaw('\n        <previously-shown/>');

                            xw.startElement('previously-shown'); xw.endElement(); // spreviously-shown

                            xw.startElement('sub-title');

                            xw.writeAttribute('lang', 'en');

                            xw.text(tdEL.title.replace(/[\n\r]+/g, " "));

                            xw.endElement(); // sub-title

                            xw.startElement('episode-num');

                            xw.writeAttribute('system', 'xmltv_ns');

                            var season = 1;

                            if (tdEL.episode.season.kind != "none" &&
                                tdEL.episode.season.kind != "number"
                            ) {
                                season = Number(tdEL.episode.season.number);
                            }

                            xw.text((season - 1) + ' . ' + (tdEL.episode.episodeNumber - 1) + ' . 0/1');

                            xw.endElement(); // episode-num
                        } else {
                            xw.text(tdEL.title.replace(/[\n\r]+/g, " "));

                            xw.endElement(); // title
                        }

                        xw.startElement('date');

                        var date = JSDate.xmlNow();

                        switch (tdEL.kind) {
                            case "episode":
                                if(tdEL.episode.originalAirDate != null){
                                    date = tdEL.episode.originalAirDate.replace(/-/g,"");
                                }
                                break;
                            case "movieAiring":
                                date = `${tdEL.movieAiring.releaseYear}0000`
                                break;
                            default:
                                break;
                        }

                        xw.text(date);

                        xw.endElement(); // date

                        if (tdEL.images.length != 0) {
                            xw.startElement('icon');

                            xw.writeAttribute('src', tdEL.images[0].url);

                            xw.endElement(); // icon
                        }

                        if (tdEL.description != null) {
                            xw.startElement('desc');

                            xw.writeAttribute('lang', 'en');

                            xw.text(tdEL.description.replace(/[\n\r]+/g, " "));

                            xw.endElement(); // desc
                        }

                        if (tdEL.kind == "episode" &&
                            tdEL.episode.rating != null
                        ) {
                            xw.startElement('rating');

                            xw.writeAttribute('system', 'MPAA');

                            xw.writeElement('value', tdEL.episode.rating);

                            xw.endElement();// rating
                        } else if (tdEL.kind == "movieAiring" &&
                            tdEL.movieAiring.filmRating != null
                        ) {
                            xw.startElement('rating');

                            xw.writeAttribute('system', 'MPAA');

                            xw.writeElement('value', tdEL.movieAiring.filmRating);

                            xw.endElement();// rating
                        }

                        xw.endElement(); // programme

                        FS.loadingBar(totalForChannel, ++curCount);
                    } else {
                        FS.loadingBar(totalForChannel, ++curCount);
                    }
                }
            }
            process.stdout.write('\n');
            // clear spam
            if (process.stdout.isTTY) {
                process.stdout.moveCursor(0, -1);

                process.stdout.clearLine(1);

                process.stdout.moveCursor(0, -1);
                
                process.stdout.clearLine(1);

                process.stdout.cursorTo(0);
            } else {
                Logger.info('Guide data update completed.');
            }
        }

        if (CONST.INCLUDE_PSEUDOTV_GUIDE) {
            if (FS.fileExists(path.join(CONST.DIR_NAME, "/.pseudotv/xmltv.xml"))) {
                const personal = FS.readFile(path.join(CONST.DIR_NAME, "/.pseudotv/xmltv.xml"));

                const lines = personal.toString().split('\n');

                // Remove the 2nd and last line
                const cleanedLines = lines.slice(2, -1);

                const cleanedData = cleanedLines.join('\n');

                xw.writeRaw(cleanedData);
            }
        }

        xw.endElement(); // tv

        xw.endDocument();

        return xw.toString() || "";
    } catch (error) {
        Logger.error(`Issue creating guide data.`, error);

        return "";
    }
};

/**
 * Downloads guide files 
 */
async function cacheGuideData() {
    const tempFolder = path.join(CONST.DIR_NAME, "tempGuide");

    if (!FS.directoryExists(tempFolder)) {
        FS.createDirectory(tempFolder);
    }

    const guideDays = JSDate.getDaysFromToday(CONST.GUIDE_DAYS);

    const host = `lighthousetv.ewscloud.com`;

    const path1 = "/api/v2/account/guide/channels/"; // /api/v2/account/guide/channels/S122912_503_01/airings/2025-04-20/

    /**
     * @type {channelLineup[]}
     */
    const lineup = FS.readJSON(LINEUP_FILE);

    const neededFiles = [];

    const totalFiles = lineup.length * CONST.GUIDE_DAYS;

    var currentFile = 0;

    Logger.info(`Prepping ${totalFiles} needed guide files.`);

    /**
     * @type {(() => Promise<void>)[]}
     */
    const tasks = [];

    for (let i = 0; i < lineup.length; i++) {
        const el = lineup[i];

        for (let z = 0; z < guideDays.length; z++) {
            const guideDay = guideDays[z];

            const fileName = el.identifier + "_" + guideDay + ".json";

            neededFiles.push(fileName);

            const file = path.join(tempFolder, fileName);

            const reqPathTD = path1 + el.identifier + "/airings/" + guideDay + "/";

            tasks.push(async () => {
                // Tablo's cloud API intermittently returns 502s (more so under
                // concurrency), so retry with exponential backoff + jitter.
                // fresh headers per attempt — makeHTTPSRequest mutates them.
                const MAX_ATTEMPTS = 4;

                /**
                 * @param {string} method
                 * @param {boolean} justHeaders
                 * @returns {Promise<any>}
                 */
                const fetchWithRetry = async (method, justHeaders = false) => {
                    var lastError;

                    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                        try {
                            return await makeHTTPSRequest(method, host, reqPathTD, {
                                'User-Agent': 'Tablo-FAST/2.0.0 (Mobile; iPhone; iOS 16.6)',
                                'Accept': '*/*',
                                "Authorization": CREDS_DATA.lighthousetvAuthorization,
                                'Lighthouse': CREDS_DATA.Lighthouse
                            }, "", justHeaders);
                        } catch (error) {
                            lastError = error;

                            if (attempt < MAX_ATTEMPTS) {
                                const backoff = Math.min(5000, 400 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 400);

                                await new Promise(resolve => setTimeout(resolve, backoff));
                            }
                        }
                    }

                    throw lastError;
                };

                try {
                    var needsGet = true;

                    if (FS.fileExists(file)) {
                        // only re-download when the size changed
                        try {
                            const head = await fetchWithRetry("HEAD", true);

                            const sizeIn = parseInt(head['content-length']);

                            const stats = await fs.promises.stat(file);

                            needsGet = isNaN(sizeIn) ? false : stats.size != sizeIn;
                        } catch (error) {
                            // HEAD failed — keep the existing file rather than
                            // risk clobbering good data with a failed GET
                            needsGet = false;
                        }
                    }

                    if (needsGet) {
                        const dataIn1 = await fetchWithRetry("GET");

                        if (dataIn1) {
                            await fs.promises.writeFile(file, dataIn1);
                        } else {
                            Logger.error(`Could not write ${fileName}`);
                        }
                    }
                } catch (error) {
                    // Only seed an empty file when none exists yet — never
                    // overwrite previously-good guide data with [] on a failure.
                    if (!FS.fileExists(file)) {
                        try {
                            await fs.promises.writeFile(file, "[]");
                        } catch { /* leave missing to be retried next run */ }
                    }

                    Logger.error(`Guide fetch failed for ${fileName} after ${MAX_ATTEMPTS} attempts:`);

                    Logger.error(error);
                } finally {
                    FS.loadingBar(totalFiles, ++currentFile);
                }
            });
        }
    }

    // A few requests in flight at a time — with the keep-alive agent this
    // turns hundreds of serial TLS handshakes into a handful of reused
    // connections. Kept modest (4) since Tablo's cloud returns 502s under
    // heavier concurrency; the per-request retry handles the rest.
    await runWithConcurrency(tasks, 4);

    process.stdout.write('\n');
    // clear spam
    if (process.stdout.isTTY) {
        process.stdout.moveCursor(0, -1);

        process.stdout.clearLine(1);

        process.stdout.moveCursor(0, -1);

        process.stdout.clearLine(1);

        process.stdout.cursorTo(0);
    } else {
        Logger.info('Guide data caching completed.');
    }

    FS.deleteUnlistedFiles(tempFolder, neededFiles);

    const xmlData = await parseGuideData(lineup);

    await fs.promises.writeFile(GUIDE_FILE, xmlData);

    return;
};

/**
 * Creates channel lineup data
 * 
 * @param {channelLineup[]|undefined} lineup 
 */
async function parseLineup(lineup = undefined) {
    /**
     * @type {channelLineup[]}
     */
    var lineupParse = lineup ?? FS.readJSON(LINEUP_FILE);

    try {
        // rebuild from scratch so channels removed from the Tablo lineup
        // don't keep serving stale entries until restart
        for (const key of Object.keys(LINEUP_DATA)) {
            delete LINEUP_DATA[key];
        }

        for (let i = 0; i < lineupParse.length; i++) {
            const el = lineupParse[i];

            var ImageURL;

            if (el.logos.length != 0) {

                const lightLarge = el.logos.find(self => self.kind == "lightLarge");

                if (lightLarge) {
                    ImageURL = lightLarge.url;
                } else {
                    ImageURL = el.logos[0].url;
                }
            }

            if (el.kind == "ota") {
                var GuideNumber = `${el.ota.major}.${el.ota.minor}`;

                if(CONST.CREATE_XML){
                    GuideNumber = `${el.ota.major}${el.ota.minor}1`;
                }

                LINEUP_DATA[el.identifier] = {
                    GuideNumber: GuideNumber,
                    GuideName: el.ota.network,
                    ImageURL: ImageURL,
                    Affiliate: el.ota.callSign,
                    URL: `${CONST.SERVER_URL}/channel/${el.identifier}`,
                    type: "ota",
                    streamUrl: `${CREDS_DATA.device.url}/guide/channels/${el.identifier}/watch`,
                    srcURL: `${CREDS_DATA.device.url}/guide/channels/${el.identifier}/watch`
                }
            } else if (el.kind == "ott") {
                var GuideNumber = `${el.ott.major}.${el.ott.minor}`;

                if(CONST.CREATE_XML){
                    GuideNumber = `${el.ott.major}${el.ott.minor}1`;
                }

                if(CONST.INCLUDE_OTT){
                    LINEUP_DATA[el.identifier] = {
                        GuideNumber: GuideNumber,
                        GuideName: el.ott.network,
                        ImageURL: ImageURL,
                        Affiliate: el.ott.callSign,
                        URL: `${CONST.SERVER_URL}/channel/${el.identifier}`,
                        type: "ott",
                        streamUrl: el.ott.streamUrl,
                        srcURL: `${CREDS_DATA.device.url}/guide/channels/${el.identifier}/watch`,
                    }
                }
            } else {
                Logger.error("Unknown lineup type:");

                Logger.error(el);
            }
        }

        return 1;
    } catch (error) {
        Logger.error("Issue with creating new lineup file.", error);

        return await exit();
    }
};

/**
 * Requests new channel line up data
 */
async function makeLineup() {
    await readCreds();

    var host = `lighthousetv.ewscloud.com`;

    var path = `/api/v2/account/${CREDS_DATA.Lighthouse}/guide/channels/`;

    const headers = {};

    headers['Lighthouse'] = CREDS_DATA.Lighthouse;

    headers['Accept'] = '*/*';

    headers['User-Agent'] = 'Tablo-FAST/2.0.0 (Mobile; iPhone; iOS 16.6)';

    headers["Authorization"] = CREDS_DATA.lighthousetvAuthorization;

    headers['Content-Type'] = 'application/json';

    try {
        const retData = await makeHTTPSRequest("GET", host, path, headers);

        /**
         * @type {channelLineup[]}
         */
        var lineupParse = JSON.parse(retData);

        if(CONST.INCLUDE_OTT == false){
            var newlineupParse = [];
            for (let i = 0; i < lineupParse.length; i++) {
                const el = lineupParse[i];
                if(el.kind != "ott"){
                    newlineupParse.push(el);
                }
            }
            lineupParse = newlineupParse;
        }

        FS.writeJSON(JSON.stringify(lineupParse, null, 4), LINEUP_FILE);

        await parseLineup(lineupParse);
    } catch (error) {
        Logger.error("Issue with creating new lineup file.", error);
    }
};

module.exports = {
    startUpMessage,
    makeDiscover,
    _lineup,
    _channel,
    _guide_serve,
    readCreds,
    reqCreds,
    makeLineup,
    cacheGuideData,
    parseLineup
};
