const path = require('path');

let PTKDevLogger;
try {
    PTKDevLogger = require("@ptkdev/logger");
    console.log("PTKDevLogger loaded successfully.");
} catch (error) {
    console.warn("PTKDevLogger not found, falling back to console.");
}

const levels = {
    "fatal": 0,
    "error": 1,
    "warn": 2,
    "info": 3,
    "success": 4,
    "debug": 5,
    "trace": 6,
};

class Logger {
    constructor(log, verbosity = "trace") {
        this.log = log || (PTKDevLogger ? new PTKDevLogger({}) : console);
        this.verbosity = levels[verbosity] !== undefined ? levels[verbosity] : levels["info"];
    }

    getTimestamp() {
        return new Date().toISOString();
    }

    isLevelEnabled(level) {
        return levels[level] <= this.verbosity;
    }

    logUnsupportedMethod(method) {
        console.warn(`${this.getTimestamp()} WARN: Unsupported log method '${method}'. Falling back to console.log.`);
    }

    getCallerInfo() {
        const stack = new Error().stack.split('\n');
        const callerLine = stack[3] || '';
        const match = callerLine.match(/\((.*):(\d+):\d+\)/);
        if (match) {
            const [_, fullPath, line] = match;
            const fileName = path.basename(fullPath);
            // Only return fileName if it's 'index.js'
            if (fileName === 'index.js') {
                return `${fileName}:${line}`;
            }
        }
        return 'unknown location';
    }

    warn(message, tag) {
        if (this.isLevelEnabled("warn")) {
            const callerInfo = this.getCallerInfo();
            const logMessage = tag ? `${tag}: ${message} (called from ${callerInfo})` : `${message} (called from ${callerInfo})`;
            if (typeof this.log.warn === 'function') {
                this.log.warn(logMessage);
            } else {
                this.logUnsupportedMethod('warn');
                console.warn(`${this.getTimestamp()} WARN:`, logMessage);
            }
        }
    }

    info(message, tag) {
        if (this.isLevelEnabled("info")) {
            const callerInfo = this.getCallerInfo();
            const logMessage = tag ? `${tag}: ${message} (called from ${callerInfo})` : `${message} (called from ${callerInfo})`;
            if (typeof this.log.info === 'function') {
                this.log.info(logMessage);
            } else {
                this.logUnsupportedMethod('info');
                console.log(`${this.getTimestamp()} INFO:`, logMessage);
            }
        }
    }

    debug(message, tag, stringify = false) {
        if (this.isLevelEnabled("debug")) {
            const callerInfo = this.getCallerInfo();
            let logMessage;
            if (stringify && message !== null && typeof message === 'object') {
                try {
                    logMessage = JSON.stringify(message, null, 2);
                } catch (error) {
                    logMessage = `Could not stringify message: ${error.message}`;
                }
            } else {
                logMessage = tag ? `${tag}: ${message} (called from ${callerInfo})` : `${message} (called from ${callerInfo})`;
            }
            if (typeof this.log.debug === 'function') {
                this.log.debug(logMessage);
            } else {
                this.logUnsupportedMethod('debug');
                console.debug(`${this.getTimestamp()} DEBUG:`, logMessage);
            }
        }
    }

    error(message, tag, stringify = false) {
        if (this.isLevelEnabled("error")) {
            const callerInfo = this.getCallerInfo();
            const logMessage = tag ? `${tag}: ${message} (called from ${callerInfo})` : `${message} (called from ${callerInfo})`;
            const formattedMessage = stringify && typeof message === 'object'
                ? JSON.stringify(message, null, 2)
                : logMessage;

            if (typeof this.log.error === 'function') {
                this.log.error(formattedMessage);
            } else {
                this.logUnsupportedMethod('error');
                console.error(`${this.getTimestamp()} ERROR:`, formattedMessage);
            }
        }
    }

    success(message, tag) {
        if (this.isLevelEnabled("success")) {
            const callerInfo = this.getCallerInfo();
            const logMessage = tag ? `${tag}: ${message} (called from ${callerInfo})` : `${message} (called from ${callerInfo})`;
            if (typeof this.log.success === 'function') {
                this.log.success(logMessage);
            } else {
                this.logUnsupportedMethod('success');
                console.warn(`${this.getTimestamp()} SUCCESS:`, logMessage);
            }
        }
    }
}

module.exports = Logger;