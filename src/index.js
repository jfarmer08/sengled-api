const mqtt = require('mqtt');
const axios = require('axios');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const { URL } = require('url');
const getUuid = require("uuid-by-string");
const path = require("path");
const fs = require("fs").promises;

const device_id = uuidv4().slice(0, 16)

class SengledApi {
    constructor(options, log) {
        this.log = log || console;
        this.persistPath = options.persistPath;
        this.apiLogEnabled = true;

        this.authBaseUrl = 'https://ucenter.cloud.sengled.com/user/app/customer'
        this.apiBaseUrl = 'https://element.cloud.sengled.com/zigbee/device'
        this.username = options.username;
        this.password = options.password;
        this.countryCode = options.country || 'us';
        this.wifi = options.wifi || false;
        this.access_token = "";
        this.mqtt_server = { host: "us-mqtt.cloud.sengled.com", port: 443, path: "/mqtt" };
        this.mqttServerURL = ""
        this.mqtt_client = null;
        this.subscribe = {};
        this.devices = [];
        this.wifi_devices = []

        this.log.info("Sengled Api initializing.");
    }
    getRequestData(data = {}) {
        return {
            ...data,
        };
    }

    async request(url, data = {}) {
        await this.maybeLogin();

        const config = {
            headers: {
                "Content-Type": "application/json",
                "Host": "element.cloud.sengled.com:443",
                "Connection": "keep-alive",
                "Cookie": "JSESSIONID=" + this.access_token
            }
        };

        try {
            return await this._performRequest(url, this.getRequestData(data), config);
        } catch (e) {
            this.log.error(e);
            if (this.refresh_token) {
                this.log.error("Error, refreshing access token and trying again");

                try {
                    await this.refreshToken();
                    return await this._performRequest(url, this.getRequestData(data), config);
                } catch (e) {
                    //
                }
            }

            this.log.error("Error, logging in and trying again");

            await this.login();
            return this._performRequest(url, this.getRequestData(data));
        }
    }

    async _performRequest(url, data = {}, config = {}) {
        config = {
            method: "POST",
            url,
            data,
            baseURL: this.apiBaseUrl,
            ...config,
        };

        if (this.apiLogEnabled) this.log.debug(`Performing request: ${url}`);
        if (this.apiLogEnabled)
            this.log.debug(`Request config: ${JSON.stringify(config)}`);

        let result;

        try {
            result = await axios(config);
            if (this.apiLogEnabled)
                this.log.debug(
                    `API response PerformRequest: ${JSON.stringify(result.data)}`
                );
            if (this.dumpData) {
                if (this.apiLogEnabled)
                    this.log.debug(
                        `API response PerformRequest: ${JSON.stringify(result.data)}`
                    );
                this.dumpData = false; // Only want to do this once at start-up
            }
        } catch (e) {
            this.log.error(`Request failed: ${e}`);
            if (e.response) {
                this.log.error(
                    `Response PerformRequest (${e.response}): ${JSON.stringify(
                        e.response.data
                    )}`
                );
            }

            throw e;
        }
        this.log.debug(result.data.msg);
        return result;
    }

    _performLoginRequest(data = {}) {
        let url = "/v2/AuthenCross.json";

        const httpsAgent = new https.Agent({
            rejectUnauthorized: true, // Set to false if you want to ignore self-signed certs
        });

        data = {
            uuid: device_id,
            user: this.username,
            pwd: this.password,
            osType: 'android',
            productCode: 'life',
            appCode: 'life',
            ...data,
        };

        const config = {
            baseURL: this.authBaseUrl,
            headers: {
                "Content-Type": "application/json",
                "Host": "element.cloud.sengled.com:443",
                "Connection": "keep-alive",
            },
            httpsAgent: httpsAgent,
        };

        return this._performRequest(url, data, config);
    }

    async login() {
        let result;
        try {
            // Will need to add more to this to see if an issues 
            result = await this._performLoginRequest();
            if (this.apiLogEnabled)
                this.log.debug("Successfully logged into Sengled API");
            await this._updateTokens(result.data.jsessionId);
        } catch (error) {
            throw new Error(
                "Invalid credentials, please check username, password, keyid or apikey" + error
            );
        }
    }

    async maybeLogin() {
        if (!this.access_token) {
            await this._loadPersistedTokens();
        }

        if (!this.access_token) {
            let now = new Date().getTime();
            // check if the last login attempt occurred too recently
            if (this.apiLogEnabled)
                this.log.debug(
                    "Last login " +
                    this.lastLoginAttempt +
                    " debounce " +
                    this.loginAttemptDebounceMilliseconds +
                    " now " +
                    now
                );
            if (this.lastLoginAttempt + this.loginAttemptDebounceMilliseconds < now) {
                // reset loginAttemptDebounceMilliseconds if last attempted login occurred more than 12 hours ago
                if (this.lastLoginAttempt - now > 60 * 1000 * 60 * 12) {
                    this.loginAttemptDebounceMilliseconds = 1000;
                } else {
                    // max debounce of 5 minutes
                    this.loginAttemptDebounceMilliseconds = Math.min(
                        this.loginAttemptDebounceMilliseconds * 2,
                        1000 * 60 * 5
                    );
                }

                this.lastLoginAttempt = now;
                await this.login();
            } else {
                this.log.warning(
                    "Attempting to login before debounce has cleared, waiting " +
                    this.loginAttemptDebounceMilliseconds / 1000 +
                    " seconds"
                );

                var waitTime = 0;
                while (waitTime < this.loginAttemptDebounceMilliseconds) {
                    await this.sleep(2);
                    waitTime = waitTime + 2000;
                    if (this.access_token) {
                        break;
                    }
                }

                if (!this.access_token) {
                    this.lastLoginAttempt = now;
                    this.loginAttemptDebounceMilliseconds = Math.min(
                        this.loginAttemptDebounceMilliseconds * 2,
                        1000 * 60 * 5
                    );
                    await this.login();
                }
            }
        }
    }

    async refreshToken() {
        await this.login();
    }

    async _updateTokens(access_token) {
        this.access_token = access_token;
        await this._persistTokens();
    }

    _tokenPersistPath() {
        // const uuid = 'test'
        const uuid = getUuid(this.username);
        return path.join(this.persistPath, `sengled-${uuid}.json`);
    }

    async _persistTokens() {
        const data = {
            access_token: this.access_token,
        };
        this.log.debug(this._tokenPersistPath());
        await fs.writeFile(this._tokenPersistPath(), JSON.stringify(data));
    }

    async _loadPersistedTokens() {
        try {
            let data = await fs.readFile(this._tokenPersistPath());
            data = JSON.parse(data);
            this.access_token = data.access_token;
        } catch (e) {
            //
        }
    }

    async getObjectList() {
        const result = await this.request("getDeviceDetails.json");

        return result.data.deviceInfos;
    }


    async getDeviceList() {
        const devices = []
        const result = await this.getObjectList();
        for (const d of result) {
            for (const device of d.lampInfos) {
                devices.push(device)
            }
        }

        return devices;
    }

    async findDeviceByUuid(targetUuid) {
        const devices = await this.getDeviceList();
        const matchingDevice = devices.find(device => device.deviceUuid === targetUuid);
        return matchingDevice || null; // return null if no match is found
    }

    async findDeviceByName(targetName) {
        const devices = await this.getDeviceList();
        const matchingDevice = devices.find(device => device.attributes.name === targetName);
        return matchingDevice || null; // return null if no match is found
    }

    async findDevicesByProductCode(targetProductCode) {
        const devices = await this.getDeviceList();
        const matchingDevices = devices.filter(device => device.attributes.productCode === targetProductCode);
        return matchingDevices; // return all matching devices, can be an empty array if none found
    }

    async setBrightness(deviceUuid, friendlyName, brightness, wifiDevice) {
        const brightnessPercentage = Math.round((brightness / 255) * 100);
        const timestamp = Date.now();
        const data = {
            dn: deviceUuid,
            type: 'brightness',
            value: brightnessPercentage.toString(),
            time: timestamp,
        };
    
        const logMessage = `Bulb ${friendlyName} setting brightness to ${brightnessPercentage}%`;
    
        if (wifiDevice) {
            this.log.info(`SengledApi: Wi-Fi Bulb ${friendlyName} setting brightness to ${brightnessPercentage}%`);
            const topic = `wifielement/${deviceUuid}/update`;
            this.publish_mqtt(topic, JSON.stringify(data));
        } else {
            this.log.info(logMessage);
            const url = `https://${this.countryCode}-elements.cloud.sengled.com/zigbee/device/deviceSetBrightness.json`;
            const payload = { deviceUuid, brightness };
            try {
                await this.request(url, payload);
            } catch (error) {
                this.log.error(`Failed to set brightness for Zigbee Bulb ${friendlyName}: ${error.message}`);
            }
        }
    }

    async async_toggle(deviceUuid, friendlyName, onoff, wifiDevice) {
        // Set internal state based on on/off value
        this._state = onoff === '1';
        const isOn = this._state ? 'on' : 'off';
    
        const data = {
            dn: deviceUuid,
            type: 'switch',
            value: onoff === '1' ? '1' : '0',
            time: Date.now(),
        };
    
        const logMessage = `SengledApi: Bulb ${friendlyName} ${deviceUuid} turning ${isOn}.`;
    
        if (wifiDevice) {
            this.log.info(logMessage);
            const topic = `wifielement/${deviceUuid}/update`;
            this.publish_mqtt(topic, JSON.stringify(data));
        } else {
            this.log.info(`SengledApi: Zigbee Bulb ${friendlyName} toggling.`);
            const url = `https://${this.countryCode}-elements.cloud.sengled.com/zigbee/device/deviceSetOnOff.json`;
            const payload = { deviceUuid, onoff };
    
            try {
                await this.request(url, payload);
            } catch (error) {
                this.log.error(`Failed to toggle Zigbee Bulb ${friendlyName}: ${error.message}`);
            }
        }
    } 
}

module.exports = SengledApi;
