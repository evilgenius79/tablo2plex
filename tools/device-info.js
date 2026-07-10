// @ts-check
/**
 * @file Standalone recon helper — dumps everything the Tablo device exposes
 * about itself over the local API, to help with firmware/OTA investigation.
 *
 * It reuses the app's own credentials and device-auth signing, so run it from
 * the project root after the app has created a creds file:
 *
 *     node tools/device-info.js
 *
 * Nothing here modifies the device — it only issues GET requests. The full
 * /server/info response usually contains the firmware version; the extra
 * endpoints are best-effort probes (many will 404, which is fine — a 200 tells
 * you the device exposes that surface).
 */

const path = require('path');

const { CONST } = require('../src/Constants');
const Encryption = require('../src/Encryption');
const FS = require('../src/FS');
const JSDate = require('../src/JSDate');

CONST.init();

const KEY_FILE = path.join(CONST.DIR_NAME, "creds.key");

/**
 * Loads and decrypts the stored creds, mirroring the app's readCreds flow.
 *
 * @returns {any}
 */
function loadCreds() {
    if (!FS.fileExists(CONST.CREDS_FILE)) {
        console.error(`No creds file at ${CONST.CREDS_FILE}. Run the app once to log in first.`);

        process.exit(1);
    }

    const encrypted = FS.readFile(CONST.CREDS_FILE);

    const key = FS.fileExists(KEY_FILE) ? FS.readFile(KEY_FILE) : undefined;

    const decrypted = Encryption.decrypt(encrypted, key);

    if (decrypted[0] != 0x7B) {
        console.error("Could not decrypt creds (wrong key or corrupt file).");

        process.exit(1);
    }

    return JSON.parse(decrypted.toString());
};

/**
 * Signed GET against the device, returning { status, body }.
 *
 * @param {string} host
 * @param {string} reqPath
 * @param {string} uuid
 * @returns {Promise<{status:number, body:string}>}
 */
async function deviceGet(host, reqPath, uuid) {
    const date = JSDate.deviceDate();

    const headers = {
        "Connection": "keep-alive",
        "Date": date,
        "Accept": "*/*",
        "User-Agent": "Tablo-FAST/1.7.0 (Mobile; iPhone; iOS 18.4)",
        "Authorization": Encryption.makeDeviceAuth("GET", reqPath, "", date)
    };

    try {
        const response = await fetch(host + reqPath, { method: "GET", headers: headers, signal: AbortSignal.timeout(5000) });

        return { status: response.status, body: await response.text() };
    } catch (error) {
        return { status: 0, body: String(error && error.message || error) };
    }
};

(async function () {
    const creds = loadCreds();

    const host = creds.device && creds.device.url;

    if (!host) {
        console.error("No device URL in creds.");

        process.exit(1);
    }

    console.log(`Device: ${creds.device.name} (${creds.device.serverId})`);
    console.log(`URL:    ${host}`);
    console.log(`UUID:   ${creds.UUID}\n`);

    // The primary target — firmware version lives in here.
    const info = await deviceGet(host, "/server/info", creds.UUID);

    console.log(`=== GET /server/info  [${info.status}] ===`);

    try {
        console.log(JSON.stringify(JSON.parse(info.body), null, 2));
    } catch {
        console.log(info.body);
    }

    console.log("");

    // Best-effort probes. These are guesses at what the firmware might expose;
    // a 200 is a lead worth following, a 404 just means "not there".
    const probes = [
        "/server/capabilities",
        "/server/update",
        "/server/updateinfo",
        "/settings/info",
        "/version",
        "/status",
    ];

    for (const probe of probes) {
        const result = await deviceGet(host, probe, creds.UUID);

        const preview = result.body.replace(/\s+/g, " ").slice(0, 200);

        console.log(`GET ${probe}  [${result.status}]  ${preview}`);
    }

    console.log("\nTip: to grab the actual OTA image, watch the device's outbound");
    console.log("traffic during an update check (Wireshark / `tcpdump host <device-ip>`),");
    console.log("then run the downloaded image through `binwalk -e firmware.bin`.");
})();
