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


        // User login parameters
        this.username = options.username;
        this.password = options.password;
        this.countryCode = options.country || 'us';
        this.wifi = options.wifi || false;

        // URLs
        this.authBaseUrl = 'https://ucenter.cloud.sengled.com/user/app/customer'
        this.apiBaseUrl = 'https://element.cloud.sengled.com/zigbee/device'
         
 
        this.mqtt_server = { host: "us-mqtt.cloud.sengled.com", port: 443, path: "/mqtt" };
        this.mqttServerURL = ""

        this.subscribe = {};
        this.mqtt_client = null;


        this.access_token = "";

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
                this.log.error(
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

    async isSessionTimout() {
        this.maybeLogin()

        const result = await this.request('https://ucenter.cloud.sengled.com/user/app/customer/isSessionTimeout.json');

        return result.data;
    }

    async getServerInfo() {
        try {
            // Ensure the user is logged in
            await this.maybeLogin();
    
            // Send request to get server info
            const result = await this.request('https://life2.cloud.sengled.com/life2/server/getServerInfo.json');
    
            // Log server info response data
            this.log.debug("SengledApi: Get MQTT Server Info - " + JSON.stringify(result.data));
    
            // Check if inceptionAddr is available
            if (!result.data.inceptionAddr) {
                this.log.debug("SengledApi: No inceptionAddr found in the response.");
                return;
            }
    
            // Parse the URL and extract host and port
            const parsedUrl = new URL(result.data.inceptionAddr);
            const [host, port] = parsedUrl.host.split(":");
    
            // Assign values to the mqtt_server object
            this.mqtt_server.host = host;
            this.mqtt_server.port = port ? parseInt(port, 10) : 443;
            this.mqtt_server.path = parsedUrl.pathname;
    
            // Log the parsed MQTT server information
            this.log.debug("SengledApi: Parse MQTT Server Info - " + parsedUrl.toString());
    
        } catch (error) {
            // Catch and log any errors
            this.log.error("SengledApi: Failed to get or parse MQTT Server Info - " + error.message);
        }
    }
    
    async getAllObjectsList() {
        if(this.wifi) {
            this.getWifiObjectList()
            this.getObjectList()
        } else this.getObjectList()
    }

    async getWifiObjectList() {
        this.maybeLogin()

        const result = await this.request('https://life2.cloud.sengled.com/life2/device/list.json');

        return result.data.deviceList;
    }

    async getObjectList() {
        this.maybeLogin()

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

    async setBrightness(deviceUuid, friendlyName, brightness, wifiDevice = false) {
        if (wifiDevice) {
            this.log.info(`SengledApi: Wi-Fi Bulb ${friendlyName} setting brightness to ${brightnessPercentage}%`);

            const data = {
                dn: deviceUuid,
                type: 'brightness',
                value: calculateBrightnessPercentage(brightness).toString(),
                time: Date.now(),
            };
            const topic = `wifielement/${deviceUuid}/update`;
            this.publishMqtt(topic, JSON.stringify(data));
        } else {
            this.log.info(`Bulb ${friendlyName} setting brightness to ${brightnessPercentage}%`);

            const url = `https://${this.countryCode}-elements.cloud.sengled.com/zigbee/device/deviceSetBrightness.json`;
            const payload = { deviceUuid, brightness };
            try {
                await this.request(url, payload);
            } catch (error) {
                this.log.error(`Failed to set brightness for Zigbee Bulb ${friendlyName}: ${error.message}`);
            }
        }
    }

    async setColorTemperature(deviceUuid, friendlyName, colorTemperature, wifiDevice = false) {

        const colorTemperaturePercentage = Math.round(
          this.translate(parseInt(colorTemperature), 200, 6500, 1, 100)
        );
    
        if (wifiDevice) {
          this.log.info(
            `SengledApi: Wifi Color Bulb ${friendlyName} ${deviceUuid} Set Color Temperature ${colorTemperaturePercentage}, This is what we are setting Sengled API`
          );
    
          const dataColorTemperature = {
            dn: deviceUuid,
            type: 'colorTemperature',
            value: String(colorTemperaturePercentage),
            time: Date.now(),
          };
    
          this.publishMqtt(`wifielement/${deviceUuid}/update`, JSON.stringify(dataColorTemperature));
        } else {
          this.log.info(`Bulb ${friendlyName} ${deviceUuid} Set Color Temperature ${colorTemperaturePercentage}`);
    
          const url = `https://${this.countryCode}-elements.cloud.sengled.com/zigbee/device/deviceSetColorTemperature.json`;
          const payload = {
            deviceUuid: deviceUuid,
            colorTemperature: colorTemperaturePercentage,
          };
    
          try {
            await this.request(url, payload);
            } catch (error) {
                this.log.error(`Failed to set color Temperature for Zigbee Bulb ${friendlyName}: ${error.message}`);
            }
        }
      }

    async setColor(deviceUuid, friendlyName, color, wifiDevice = false) {

    if (wifiDevice) {
        const dataColor = {
        dn: deviceUuid,
        type: 'color',
        value: this.convertColorHA(color),
        time: Date.now(),
        };

        this.publishMqtt(`wifielement/${deviceUuid}/update`, JSON.stringify(dataColor));
    } else {
        this.log.info(`SengledApi: Color Bulb ${friendlyName} ${deviceUuid} Setting Color`);

        const colorStr = color
        .toString()
        .replace(/\s|\(|\)/g, '')
        .split(',');
        const [r, g, b] = colorStr.map(Number);

        this.log.info(`SengledApi: Set Color R ${r} G ${g} B ${b}`);

        const url = `https://${this.countryCode}-elements.cloud.sengled.com/zigbee/device/deviceSetGroup.json`;
        const payload = {
        cmdId: 129,
        deviceUuidList: [{ deviceUuid: deviceUuid }],
        rgbColorR: r,
        rgbColorG: g,
        rgbColorB: b,
        };

        try {
        await this.request(url, payload);
        } catch (error) {
            this.log.error(`Failed to set color for Zigbee Bulb ${friendlyName}: ${error.message}`);
        }
        }
    }

    async setPower(deviceUuid, friendlyName, onoff, wifiDevice = false) {
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
            this.publishMqtt(topic, JSON.stringify(data));
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

    initializeMqtt() {
        this.log.info("SengledApi: Initialize the MQTT connection");

        this.maybeLogin()

        const onMessage = (topic, message) => {
            if (this.subscribe[topic]) {
                this.subscribe[topic](message)
            }
        };

        this.mqtt_client = mqtt.connect(`wss://${this.mqtt_server.host}:${this.mqtt_server.port}`, {
            clientId: `${this.access_token}@lifeApp`,
            protocol: 'wss',
            wsOptions: {
                path: this.mqtt_server.path,
                headers: {
                    'Cookie': `JSESSIONID=${this.access_token}`,
                    'X-Requested-With': 'com.sengled.life2',
                }
            }
        });

        this.mqtt_client.on('message', onMessage);
        this.mqtt_client.on('connect', () => {
            this.log.info("SengledApi: Connected to MQTT broker");
        });

        this.mqtt_client.on('error', (err) => {
            this.log.error("SengledApi: MQTT error", err);
        });

        this.mqtt_client.subscribe(Object.keys(this.subscribe));
        this.log.info("SengledApi: Start mqtt loop");
        return true;
    }

    reinitializeMqtt() {
        this.log.info("SengledApi: Re-initialize the MQTT connection");

        if (!this.mqtt_client || !this.access_token) {
            return false;
        }

        this.mqtt_client.end(true, () => {
            this.mqtt_client = mqtt.connect(`wss://${this.mqtt_server.host}:${this.mqtt_server.port}`, {
                clientId: `${this.access_token}@lifeApp`,
                protocol: 'wss',
                wsOptions: {
                    path: this.mqtt_server.path,
                    headers: {
                        'Cookie': `JSESSIONID=${this.access_token}`
                    }
                }
            });

            this.mqtt_client.on('message', (topic, message) => {
                if (this.subscribe[topic]) {
                    this.subscribe[topic](message);
                }
            });

            for (const topic in this.subscribe) {
                this.subscribeMqtt(topic, this.subscribe[topic]);
            }

            this.log.info("SengledApi: MQTT reinitialized");
        });

        return true;
    }

    publishMqtt(topic, payload = null) {
        this.log.info("SengledApi: Publish MQTT message");

        if (!this.mqtt_client) {
            return false;
        }

        const result = this.mqtt_client.publish(topic, payload);

        result.on('error', (err) => {
            this.log.error("SengledApi: Error publishing MQTT message", err);
        });

        result.on('publish', () => {
            this.log.info("SengledApi: Message published successfully");
        });

        return true;
    }

    subscribeMqtt(topic, callback) {
        this.log.info(`SengledApi: Subscribe to MQTT Topic ${topic}`);

        if (!this.mqtt_client) {
            return false;
        }

        this.mqtt_client.subscribe(topic, (err) => {
            if (err) {
                this.log.error("SengledApi: Error subscribing to topic", err);
                return false;
            }
            this.subscribe[topic] = callback;
            this.log.info(`SengledApi: Subscribed to ${topic}`);
        });

        return true;
    }

    unsubscribeMqtt(topic) {
        this.log.info(`SengledApi: Unsubscribe from MQTT Topic ${topic}`);

        if (this.subscribe[topic]) {
            this.mqtt_client.unsubscribe(topic, (err) => {
                if (err) {
                    this.log.error(`SengledApi: Error unsubscribing from ${topic}`, err);
                    return false;
                }
                delete this.subscribe[topic];
                this.log.info(`SengledApi: Unsubscribed from ${topic}`);
            });
        }
        return true;
    }

    //Turn Light Bulb 0 = off or 1 = on
    async lightPower(deviceUuid, friendlyName, value) {
        await this.setPower(deviceUuid, friendlyName, value);
    }
    async lightTurnOn(deviceUuid, friendlyName) {
        await this.setProperty(deviceUuid, friendlyName, "0");
    }
    async lightTurnOff(deviceUuid, friendlyName) {
        await this.setProperty(deviceUuid, friendlyName, "1");
    }
    
    // Turn Light Bulb 0 = off or 1 = on
    async wifiLightPower(deviceUuid, friendlyName, value) {
        await this.setPower(deviceUuid, friendlyName, value, true);
    }
    async wifiLightTurnOn(deviceUuid, friendlyName) {
        await this.setProperty(deviceUuid, friendlyName, "0", true);
    }
    async wifiLightTurnOff(deviceUuid, friendlyName) {
        await this.setProperty(deviceUuid, friendlyName, "1", true);
    }

    //This function takes a brightness value (between 0 and 255) as input and returns the brightness percentage (between 0% and 100%). 
    //You can use it for different brightness values depending on your needs.
    calculateBrightnessPercentage(brightness) {
        return Math.round((brightness / 255) * 100);
    }

    // Function to translate a value from one range to another
    translate(value, fromLow, fromHigh, toLow, toHigh) {
        return (value - fromLow) * (toHigh - toLow) / (fromHigh - fromLow) + toLow;
    }

    convertColorHA(HACOLOR) {
        let sengledColor = HACOLOR.toString();
        const replacements = [[" ", ""], [",", ":"], ["(", ""], [")", ""]];
      
        replacements.forEach(([from, to]) => {
          sengledColor = sengledColor.replace(new RegExp(from, 'g'), to);
        });
      
        return sengledColor;
      }
}

module.exports = SengledApi;
