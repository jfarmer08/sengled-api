const path = require('path');

let PTKDevLogger;
try {
    PTKDevLogger = require("@ptkdev/logger");
    console.log("PTKDevLogger loaded successfully.");
} catch (error) {
    console.warn("PTKDevLogger not found, falling back to console.");
}

const levels = {
    fatal: 0,
    error: 1,
    warn: 2,
    info: 3,
    success: 4,
    debug: 5,
    trace: 6,
};

class Logger {
    constructor(log, verbosity = "trace") {
        this.log = log || (PTKDevLogger ? new PTKDevLogger({}) : console);
        this.verbosity = levels[verbosity] !== undefined ? levels[verbosity] : levels.info;
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

    formatMessage(message, tag) {
        return tag ? `${tag}: ${message}` : message;
    }

    warn(message, tag) {
        if (this.isLevelEnabled("warn")) {
            const logMessage = this.formatMessage(message, tag);
            this.log.warn ? this.log.warn(logMessage) : this.handleUnsupportedMethod('warn', logMessage);
        }
    }

    info(message, tag) {
        if (this.isLevelEnabled("info")) {
            const logMessage = this.formatMessage(message, tag);
            this.log.info ? this.log.info(logMessage) : this.handleUnsupportedMethod('info', logMessage);
        }
    }

    debug(message, tag, stringify = false) {
        if (this.isLevelEnabled("debug")) {
            let logMessage = stringify && typeof message === 'object' 
                ? this.stringifyMessage(message) 
                : this.formatMessage(message, tag);
            this.log.debug ? this.log.debug(logMessage) : this.handleUnsupportedMethod('debug', logMessage);
        }
    }

    error(message, tag, stringify = false) {
        if (this.isLevelEnabled("error")) {
            const logMessage = this.formatMessage(message, tag);
            const formattedMessage = stringify && typeof message === 'object'
                ? this.stringifyMessage(message) 
                : logMessage;

            this.log.error ? this.log.error(formattedMessage) : this.handleUnsupportedMethod('error', formattedMessage);
        }
    }

    success(message, tag) {
        if (this.isLevelEnabled("success")) {
            const logMessage = this.formatMessage(message, tag);
            this.log.success ? this.log.success(logMessage) : this.handleUnsupportedMethod('success', logMessage);
        }
    }

    stringifyMessage(message) {
        try {
            return JSON.stringify(message, null, 2);
        } catch (error) {
            return `Could not stringify message: ${error.message}`;
        }
    }

    handleUnsupportedMethod(method, logMessage) {
        this.logUnsupportedMethod(method);
        console[method === 'error' ? 'error' : method](logMessage);
    }
}

module.exports = Logger;