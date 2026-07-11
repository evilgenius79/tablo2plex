// @ts-check
const express = require('express');

const {
    exit
} = require('./CommandLine');
const {
    C_HEX,
    CONST
} = require('./Constants');
const {
    startUpMessage,
    makeDiscover,
    _lineup,
    _channel,
    _guide_serve,
} = require("./Device");
const Logger = require('./Logger');

/**
 * basic middleware
 *  
 * @param {express.Request} req 
 * @param {express.Response} res 
 * @param {express.NextFunction} next 
 * @param {string} port
 */
async function _middleware(req, res, next, port) {
    const ip = req.ip || "";

    const path = req.path;

    // No CORS headers on purpose — Plex talks to this server directly (not
    // from a browser), and a wildcard origin would let any website a LAN
    // user visits probe the server and tie up tuners.

    if (!(path == "/discover.json" || path == "/lineup_status.json")) {
        Logger.debug(`Req ${ip.replace(/::ffff:/, "")}:${port}${path}`);
    }

    if (req.method === 'OPTIONS') {
        res.status(204).send('');
    } else {
        next(); // Move to the next middleware or route handler
    }

    return;
};

/**
 * discover end point
 * 
 * @param {express.Request} req 
 * @param {express.Response} res 
 */
async function _discover(req, res) {
    const discover = makeDiscover();

    const headers = {
        'Content-Type': 'application/json'
    };

    res.writeHead(200, headers);

    res.end(JSON.stringify(discover));

    return;
};

/**
 * lineup_status end point
 * 
 * @param {express.Request} req 
 * @param {express.Response} res 
 */
async function _lineup_status(req, res) {
    const lineup_status = {
        ScanInProgress: 0,
        ScanPossible: 1,
        Source: "Antenna",
        SourceList: ["Antenna"]
    };

    const headers = {
        'Content-Type': 'application/json'
    };

    res.writeHead(200, headers);

    res.end(JSON.stringify(lineup_status));

    return;
};

/**
 * Main Server Function
 * 
 * @async
 */
async function runServer() {
    //check env file
    if (process.env == undefined) {
        Logger.error(`${C_HEX.red}[Error]${C_HEX.reset}: .env file read error.`);

        await exit();
    } else {
        const app = express();

        // no reverse proxy sits in front of this server, so trusting
        // X-Forwarded-For would let any client spoof its logged IP
        app.set('trust proxy', false);
        // Middleware to log requests by IP and path
        app.use(async (req, res, next) => {
            return await _middleware(req, res, next, CONST.PORT);
        });
        // everything gets routed here to route.
        app.get("/discover.json", async (req, res) => {
            return await _discover(req, res);
        })

        app.get("/lineup.json", async (req, res) => {
            return await _lineup(req, res);
        })

        app.get("/lineup_status.json", async (req, res) => {
            return await _lineup_status(req, res);
        })

        app.get("/channel/:channelId", async (req, res) => {
            return await _channel(req, res);
        })

        // Always registered so a request when CREATE_XML is off returns a
        // helpful explanation instead of a bare 404.
        app.get("/guide.xml", async (req, res) => {
            return await _guide_serve(req, res);
        })

        app.get("/favicon.ico", async (req, res) => {
            res.end("");
        })

        // Start the server
        app.listen(CONST.PORT, () => {
            startUpMessage();
        });
    }
};

module.exports = {
    runServer
};