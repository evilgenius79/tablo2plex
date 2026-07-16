// @ts-check
/**
 * @typedef {import('node:buffer').Buffer} Buffer
 */

require('dotenv').config();
const {
    createHmac,
    createHash,
    createCipheriv,
    createDecipheriv,
    randomBytes,
    randomUUID
} = require("crypto");

/**
 * new MersenneTwister().
 *
 * Can be seeded with a 4 byte Buffer or number.
 *
 * Use ``random_int()`` for random number on [0,0xffffffff]-interval.
 *
 * Only kept so creds files written in the legacy format (IV derived from a
 * 4-byte MT seed) still decrypt — new files store a random 16-byte IV.
 *
 * @class
 * @param {Buffer|number|undefined} seed - Can be seeded
 */
class MersenneTwister {
    /**
     * @constructor
     * @param {Buffer|number|undefined} seed - Seed data, can be undefined, number or Buffer with a length of 4
     * If undefined, seed is the current time
     * If number, it is used as the seed
     * If Buffer, the first 4 bytes are used as the seed
     */
    constructor(seed = undefined) {
        /* Period parameters */
        this.N = 624;

        this.M = 397;

        this.MATRIX_A = 0x9908b0df; /* constant vector a */

        this.UPPER_MASK = 0x80000000; /* most significant w-r bits */

        this.LOWER_MASK = 0x7fffffff; /* least significant r bits */

        this.mt = new Array(this.N); /* the array for the state vector */

        this.mti = this.N + 1; /* mti==N+1 means mt[N] is not initialized */

        if (typeof seed == "number") {
            this._init_seed(seed);
        } else if (seed instanceof Buffer) {
            const array = Array();

            for (let i = 0; i < 4; i++) {
                array.push(seed[i]);
            }

            this._init_by_array(array, 4);
        } else {
            this._init_seed(new Date().getTime());
        }
    }

    /**
     * initializes mt[N] with a seed
     * @param {number} s - seed value
     * @returns {void}
     */
    _init_seed(s) {
        this.mt[0] = s >>> 0;

        for (this.mti = 1; this.mti < this.N; this.mti++) {

            s = this.mt[this.mti - 1] ^ (this.mt[this.mti - 1] >>> 30);

            this.mt[this.mti] = (((((s & 0xffff0000) >>> 16) * 1812433253) << 16) + (s & 0x0000ffff) * 1812433253) + this.mti;
            /* See Knuth TAOCP Vol2. 3rd Ed. P.106 for multiplier. */
            /* In the previous versions, MSBs of the seed affect   */
            /* only MSBs of the array mt[].                        */
            /* 2002/01/09 modified by Makoto Matsumoto             */
            this.mt[this.mti] >>>= 0;
            /* for >32 bit machines */
        }
    }

    /**
     * initialize by an array with array-length
     * 
     * @param {Array<number>} init_key - array for initializing keys
     * @param {number} key_length - is its length
     */
    _init_by_array(init_key, key_length) {
        var i, j, k;

        this._init_seed(19650218);

        i = 1; j = 0;

        k = (this.N > key_length ? this.N : key_length);
        for (; k; k--) {
            var s = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);

            this.mt[i] = (this.mt[i] ^ (((((s & 0xffff0000) >>> 16) * 1664525) << 16) + ((s & 0x0000ffff) * 1664525)))  + init_key[j] + j; /* non linear */

            this.mt[i] >>>= 0; /* for WORDSIZE > 32 machines */

            i++; 

            j++;

            if (i >= this.N) { 
                this.mt[0] = this.mt[this.N - 1]; 
                i = 1; 
            }

            if (j >= key_length){ 
                j = 0;
            }
        }

        for (k = this.N - 1; k; k--) {
            s = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);

            this.mt[i] = (this.mt[i] ^ (((((s & 0xffff0000) >>> 16) * 1566083941) << 16) + (s & 0x0000ffff) * 1566083941)) - i; /* non linear */

            this.mt[i] >>>= 0; /* for WORDSIZE > 32 machines */

            i++;

            if (i >= this.N) { 
                this.mt[0] = this.mt[this.N - 1]; 
                i = 1; 
            }
        }

        this.mt[0] = 0x80000000; /* MSB is 1; assuring non-zero initial array */
    }

    /**
     * generates a random number on [0,0xffffffff]-interval 
     * 
     * @returns {number} number
     */
    random_int() {
        var y;

        var mag01 = new Array(0x0, this.MATRIX_A);
        /* mag01[x] = x * MATRIX_A  for x=0,1 */
        if (this.mti >= this.N) { /* generate N words at one time */
            var kk;

            if (this.mti == this.N + 1) /* if init_seed() has not been called, */
                this._init_seed(5489); /* a default initial seed is used */

            for (kk = 0; kk < this.N - this.M; kk++) {
                y = (this.mt[kk] & this.UPPER_MASK) | (this.mt[kk + 1] & this.LOWER_MASK);
                
                this.mt[kk] = this.mt[kk + this.M] ^ (y >>> 1) ^ mag01[y & 0x1];
            }

            for (; kk < this.N - 1; kk++) {
                y = (this.mt[kk] & this.UPPER_MASK) | (this.mt[kk + 1] & this.LOWER_MASK);

                this.mt[kk] = this.mt[kk + (this.M - this.N)] ^ (y >>> 1) ^ mag01[y & 0x1];
            }

            y = (this.mt[this.N - 1] & this.UPPER_MASK) | (this.mt[0] & this.LOWER_MASK);

            this.mt[this.N - 1] = this.mt[this.M - 1] ^ (y >>> 1) ^ mag01[y & 0x1];

            this.mti = 0;
        }

        y = this.mt[this.mti++];

        /* Tempering */
        y ^= (y >>> 11);

        y ^= (y << 7) & 0x9d2c5680;

        y ^= (y << 15) & 0xefc60000;

        y ^= (y >>> 18);

        return y >>> 0;
    }

    /**
     * generates a random number on [0,0x7fffffff]-interval 
     * 
     * @returns {number} number
     */
    random_int31() {
        return (this.random_int() >>> 1);
    }

    /**
     * generates a random number on [0,1]-real-interval
     * 
     * @returns {number} number
     */
    random_incl() {
        /* divided by 2^32-1 */
        return this.random_int() * (1.0 / 4294967295.0);
    }

    /**
     * generates a random number on [0,1)-real-interval
     * 
     * @returns {number} number
     */
    random() {
        /* divided by 2^32 */
        return this.random_int() * (1.0 / 4294967296.0);
    }

    /**
     * generates a random number on (0,1)-real-interva
     * 
     * @returns {number} number
     */
    random_excl() {
        /* divided by 2^32 */
        return (this.random_int() + 0.5) * (1.0 / 4294967296.0);
    }

    /**
     * generates a random number on [0,1) with 53-bit resolution
     * 
     * @returns {number} number
     */
    random_long() {
        var a = this.random_int() >>> 5, b = this.random_int() >>> 6;

        return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
    }
};

/**
 * Derives the legacy creds key from the built-in (or env supplied) constant.
 *
 * Only kept so creds files from older installs still decrypt — new installs
 * use a random per-install key instead.
 *
 * @returns {Buffer}
 */
function _legacyKey() {
    // `||` so an empty RSA="" env value falls back to the built-in key
    // rather than deriving a bad legacy key.
    const RSA = process.env.RSA || "30818902818100B507AAAC6B6B1BA5CE02B8512381159ECFD9CD32D6EEADCAFF459EA7E2210819C2D915F437E30871DDA190F19B8898038E1E7863A21699CDA5BC6C84C49D935AFAFFE1D2F16B0C662DC8941D8751FB7A36AC22F5980EDF92FCF7756FC6FCFD967A73303C7CD7030C681799C18E0A2F2D2B69C9F7BD8ADE05731BB179F354F0E90203010001";

    const buff = Buffer.from(RSA, "hex");

    const keyBuff = Buffer.alloc(32, 0);

    for (let i = 0; i < buff.length / 4; i++) {
        const el1 = buff.readUInt32LE(i * 4);

        const inner = i % (keyBuff.length / 4);

        const num = keyBuff.readInt32LE(inner * 4);

        keyBuff.writeInt32LE(num ^ el1, inner * 4);
    }

    return keyBuff;
};

/**
 * Magic prefix for the v2 creds format: [magic(4)][iv(16)][ciphertext].
 * Legacy files are [seed(4)][ciphertext] with the IV derived from the seed
 * via MersenneTwister.
 */
const V2_MAGIC = Buffer.from("T2C2");

/**
 * Encryption functions
 */
class Encryption {
    /**
     * Generates a random 32 byte key for creds encryption.
     *
     * @returns {Buffer}
     */
    static newKey() {
        return randomBytes(32);
    };

    /**
     *
     * @param {string} creds - stringified creds
     * @param {Buffer|undefined} key - 32 byte key (falls back to the legacy built-in key)
     * @returns {Buffer}
     */
    static crypt(creds, key = undefined) {
        const keyBuff = (key instanceof Buffer && key.length == 32) ? key : _legacyKey();

        // v2 format: a fully random IV stored in the file, instead of the
        // legacy IV expanded from a 4-byte MersenneTwister seed.
        const ivBuff = randomBytes(16);

        const cipher = createCipheriv("aes-256-cbc", keyBuff, ivBuff);

        cipher.setAutoPadding(true);

        return Buffer.concat([V2_MAGIC, ivBuff, cipher.update(creds), cipher.final()]);
    };

    /**
     * Decrypts a legacy-format creds buffer (IV derived from a 4-byte seed).
     *
     * @param {Buffer} creds - file buffer of creds
     * @param {Buffer} keyBuff - 32 byte key
     * @returns {Buffer}
     */
    static #decryptLegacy(creds, keyBuff) {
        const seed = creds.readUInt32LE();

        const mt = new MersenneTwister(seed ^ 0xffffffff);

        const pull = mt.random_int();

        const amount = (pull & 15) + 1;

        for (let i = 0; i < amount; i++) {
            mt.random_int()
        };

        const ivBuff = Buffer.alloc(16, 0);

        for (let i = 0; i < (16 / 4); i++) {
            ivBuff.writeUInt32LE(mt.random_int(), i * 4)
        };

        const cipher = createDecipheriv("aes-256-cbc", keyBuff, ivBuff);

        cipher.setAutoPadding(true);

        return Buffer.concat([cipher.update(creds.subarray(4, creds.length)), cipher.final()]);
    };

    /**
     * Check data with 0x7b
     * @param {Buffer} creds - file buffer of creds
     * @param {Buffer|undefined} key - 32 byte key (falls back to the legacy built-in key)
     * @returns {Buffer}
     */
    static decrypt(creds, key = undefined) {
        const keyBuff = (key instanceof Buffer && key.length == 32) ? key : _legacyKey();

        // v2 format first: [magic(4)][iv(16)][ciphertext]
        if (creds.length > 20 && creds.subarray(0, 4).equals(V2_MAGIC)) {
            try {
                const cipher = createDecipheriv("aes-256-cbc", keyBuff, creds.subarray(4, 20));

                cipher.setAutoPadding(true);

                const plain = Buffer.concat([cipher.update(creds.subarray(20)), cipher.final()]);

                if (plain[0] == 0x7B) {
                    return plain;
                }
                // a legacy file could theoretically start with the magic
                // bytes by chance — fall through and try the legacy path
            } catch (error) {
                // fall through and try the legacy path
            }
        }

        try {
            return this.#decryptLegacy(creds, keyBuff);
        } catch (error) {
            // wrong key or corrupted file — return a buffer that fails the
            // caller's 0x7B check so it's handled as a bad creds file
            // instead of crashing the process with a stream error event
            return Buffer.alloc(1);
        }
    };

     /**
     * For Tablo device signing
     * @param {string} method - POST, GET, PUT
     * @param {string} url - end directory url without params
     * @param {string} msg - content of message, use "" for none.
     * @param {string} date - Human readable string
     */
    static makeDeviceAuth(method, url, msg, date) {
        if (msg != "") {
            const MD5 = createHash("md5").update(msg);

            msg = MD5.digest('hex').toLowerCase();
        }
        const full_str = method + "\n" + url + "\n" + msg + "\n" + date;

        // Use `||` (falsy) rather than `== undefined` so an empty env value
        // (HashKey="") falls back to the built-in key instead of signing with
        // "" — an empty key produces a bad signature the device rejects as
        // "Authentication failure".
        const key = process.env.HashKey || "6l8jU5N43cEilqItmT3U2M2PFM3qPziilXqau9ys";

        const part2 = createHmac("md5", key).update(full_str);

        const device = process.env.DeviceKey || "ljpg6ZkwShVv8aI12E2LP55Ep8vq1uYDPvX0DdTB";

        return "tablo:" + device + ":" + part2.digest('hex').toLowerCase();
    };

    /**
     * Generates a UUID as Hex string.
     */
    static UUID(){
        return randomUUID();
    }
};

module.exports = Encryption;