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

        this.log.debug(`Performing request: ${url}`);

        this.log.debug(`Request config: ${JSON.stringify(config)}`);

        let result;

        try {
            result = await axios(config);
            this.log.debug(
                `API response PerformRequest: ${JSON.stringify(result.data)}`
            );
            if (this.dumpData) {
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
        const result = await this.request('https://ucenter.cloud.sengled.com/user/app/customer/isSessionTimeout.json');

        return result.data;
    }

    async getServerInfo() {
        try {
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

    async getWifiObjectList() {
        const result = await this.request('https://life2.cloud.sengled.com/life2/device/list.json');

        return result.data;
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

    async getWifiDeviceList() {
        const result = await this.getWifiObjectList();

        return result.deviceList
    }


    /**
     * Helper function to transform the original device data.
     * This function maps over the original device list and transforms
     * the attributeList into a more structured format.
     * 
     * @param {Array} original - The list of devices to transform.
     * @returns {Array} The transformed list of devices.
     */
    async getAllDeviceList() {
        // Helper function to transform the original device data
        const transformData = (original) => {
            return original.map(device => {
                // Log the device being transformed
                this.log.info(`SengledApi: Transforming device with UUID: ${device.deviceUuid}`);

                // Create a new attributes object from the attributeList
                const attributes = device.attributeList.reduce((acc, attr) => {
                    acc[attr.name] = attr.value;
                    return acc;
                }, {});

                // Log the transformed attributes
                this.log.debug(`SengledApi: Transformed attributes for ${device.deviceUuid}: ${JSON.stringify(attributes)}`);

                // Return the transformed device object
                return {
                    deviceUuid: device.deviceUuid,
                    deviceClass: 1, // Default class, adjust if necessary
                    supportAttributes: attributes.supportAttributes || "",
                    attributes: {
                        deviceRssi: attributes.deviceRssi,
                        productCode: attributes.productCode,
                        brightness: attributes.brightness,
                        colorTemperature: attributes.colorTemperature,
                        color: attributes.color,
                        activeTime: attributes.startTime,
                        name: attributes.name,
                        colorMode: attributes.colorMode,
                        isOnline: attributes.online,
                        version: attributes.version,
                        onCount: "0", // Placeholder; update if needed
                        typeCode: attributes.typeCode,
                        onoff: attributes.switch,
                        effectStatus: attributes.effectStatus,
                        neonStatus: attributes.neonStatus,
                        online: attributes.online,
                    }
                };
            });
        };

        try {
            this.log.info('SengledApi: Fetching device list...');
            const deviceList = await this.getDeviceList();  // Fetch the device list
            this.log.info(`SengledApi: Fetched ${deviceList.length} devices from main device list`);

            if (!this.wifi) {
                // If Wi-Fi is not enabled, return the device list early
                this.log.info('SengledApi: Wi-Fi is not enabled, returning device list.');
                return deviceList;
            }

            this.log.info('SengledApi: Fetching Wi-Fi device list...');
            const wifiDeviceList = await this.getWifiDeviceList();
            this.log.info(`SengledApi: Fetched ${wifiDeviceList.length} devices from Wi-Fi device list`);

            // Transform Wi-Fi devices
            const transformedWifiDevices = transformData(wifiDeviceList);
            this.log.info(`SengledApi: Transformed ${transformedWifiDevices.length} Wi-Fi devices`);

            // Combine the main device list with the transformed Wi-Fi devices
            return deviceList.concat(transformedWifiDevices);

        } catch (error) {
            this.log.error(`SengledApi: Error fetching device lists: ${error.message}`);
            throw error;  // Propagate error to the calling function
        }
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

    async setBrightness(deviceUuid, brightness, wifiDevice = false) {
        const brightnessPercentage = calculateBrightnessPercentage(brightness);

        if (wifiDevice) {
            this.log.info(`SengledApi: Wi-Fi Bulb ${deviceUuid} - Setting brightness to ${brightnessPercentage}%`);

            const data = {
                dn: deviceUuid,
                type: 'brightness',
                value: brightnessPercentage.toString(),
                time: Date.now(),
            };

            const topic = `wifielement/${deviceUuid}/update`;
            this.log.debug(`SengledApi: Wi-Fi brightness payload: ${JSON.stringify(data)}`);

            const publishResult = this.publishMqtt(topic, JSON.stringify(data));
            if (publishResult) {
                this.log.info(`SengledApi: Brightness update published for Wi-Fi Bulb ${deviceUuid}`);
            } else {
                this.log.error(`SengledApi: Failed to publish brightness update for Wi-Fi Bulb ${deviceUuid}`);
            }
        } else {
            this.log.info(`SengledApi: Zigbee Bulb ${deviceUuid} - Setting brightness to ${brightnessPercentage}%`);

            const url = `https://${this.countryCode}-elements.cloud.sengled.com/zigbee/device/deviceSetBrightness.json`;
            const payload = { deviceUuid, brightness: brightnessPercentage };

            this.log.debug(`SengledApi: Zigbee brightness payload: ${JSON.stringify(payload)}`);

            try {
                await this.request(url, payload);
                this.log.info(`SengledApi: Successfully set brightness for Zigbee Bulb ${deviceUuid}`);
            } catch (error) {
                this.log.error(`SengledApi: Failed to set brightness for Zigbee Bulb ${deviceUuid}: ${error.message}`);
            }
        }
    }

    async setColorTemperature(deviceUuid, colorTemperature, wifiDevice = false) {
        const colorTemperaturePercentage = Math.round(
            this.translate(parseInt(colorTemperature), 200, 6500, 1, 100)
        );

        if (wifiDevice) {
            this.log.info(
                `SengledApi: Wi-Fi Color Bulb ${deviceUuid} - Setting Color Temperature to ${colorTemperaturePercentage}%`
            );

            const dataColorTemperature = {
                dn: deviceUuid,
                type: 'colorTemperature',
                value: String(colorTemperaturePercentage),
                time: Date.now(),
            };

            this.log.debug(`SengledApi: Wi-Fi data payload for color temperature: ${JSON.stringify(dataColorTemperature)}`);
            const publishResult = this.publishMqtt(`wifielement/${deviceUuid}/update`, JSON.stringify(dataColorTemperature));

            if (publishResult) {
                this.log.info(`SengledApi: Color temperature update published for Wi-Fi device ${deviceUuid}`);
            } else {
                this.log.error(`SengledApi: Failed to publish color temperature update for Wi-Fi device ${deviceUuid}`);
            }
        } else {
            this.log.info(`SengledApi: Zigbee Bulb ${deviceUuid} - Setting Color Temperature to ${colorTemperaturePercentage}%`);

            const url = `https://${this.countryCode}-elements.cloud.sengled.com/zigbee/device/deviceSetColorTemperature.json`;
            const payload = {
                deviceUuid: deviceUuid,
                colorTemperature: colorTemperaturePercentage,
            };

            this.log.debug(`SengledApi: Zigbee payload for color temperature: ${JSON.stringify(payload)}`);

            try {
                await this.request(url, payload);
                this.log.info(`SengledApi: Successfully set color temperature for Zigbee Bulb ${deviceUuid}`);
            } catch (error) {
                this.log.error(`SengledApi: Failed to set color temperature for Zigbee Bulb ${deviceUuid}: ${error.message}`);
            }
        }
    }


    async setColor(deviceUuid, color, wifiDevice = false) {
        if (wifiDevice) {
            this.log.info(`SengledApi: Setting color for Wi-Fi device ${deviceUuid}`);

            const dataColor = {
                dn: deviceUuid,
                type: 'color',
                value: this.convertColorHA(color),
                time: Date.now(),
            };

            this.log.debug(`SengledApi: Wi-Fi color data: ${JSON.stringify(dataColor)}`);
            const publishResult = this.publishMqtt(`wifielement/${deviceUuid}/update`, JSON.stringify(dataColor));

            if (publishResult) {
                this.log.info(`SengledApi: Color update published for Wi-Fi device ${deviceUuid}`);
            } else {
                this.log.error(`SengledApi: Failed to publish color update for Wi-Fi device ${deviceUuid}`);
            }

        } else {
            this.log.info(`SengledApi: Setting color for Zigbee Bulb ${deviceUuid}`);

            const colorStr = color.toString().replace(/\s|\(|\)/g, '').split(',');
            const [r, g, b] = colorStr.map(Number);

            this.log.debug(`SengledApi: Parsed RGB values - R: ${r}, G: ${g}, B: ${b}`);

            const url = `https://${this.countryCode}-elements.cloud.sengled.com/zigbee/device/deviceSetGroup.json`;
            const payload = {
                cmdId: 129,
                deviceUuidList: [{ deviceUuid: deviceUuid }],
                rgbColorR: r,
                rgbColorG: g,
                rgbColorB: b,
            };

            this.log.debug(`SengledApi: Zigbee payload: ${JSON.stringify(payload)}`);

            try {
                await this.request(url, payload);
                this.log.info(`SengledApi: Successfully set color for Zigbee Bulb ${deviceUuid}`);
            } catch (error) {
                this.log.error(`SengledApi: Failed to set color for Zigbee Bulb ${deviceUuid}`, { error: error.message });
            }
        }
    }


    async setPower(deviceUuid, friendlyName, onoff, wifiDevice = true) {
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
        this.log.info('SengledApi: Initializing the MQTT connection');

        if (!this.access_token) {
            this.log.error('SengledApi: Access token is missing. Cannot initialize MQTT.');
            return false;
        }

        const onMessage = (topic, message) => {
            const payload = message.toString(); // Convert message to string
            this.log.debug(`SengledApi: Received message on topic '${topic}' with payload: ${payload}`);

            if (this.subscribe[topic]) {
                this.subscribe[topic](payload);
            } else {
                this.log.warn(`SengledApi: No handler subscribed for topic '${topic}'`);
            }
        };

        const clientOptions = {
            clientId: `${this.access_token}@lifeApp`,
            protocol: 'wss', // websockets
            wsOptions: {
                headers: {
                    'Cookie': `JSESSIONID=${this.access_token}`,
                    'X-Requested-With': 'com.sengled.life2',
                }
            }
        };

        this.log.debug('SengledApi: Attempting to connect to MQTT server', JSON.stringify(clientOptions));

        try {
            this.mqtt_client = mqtt.connect(`wss://${this.mqtt_server.host}:${this.mqtt_server.port}${this.mqtt_server.path}`, clientOptions);

            this.mqtt_client.on('message', onMessage);

            this.mqtt_client.on('connect', () => {
                this.log.info('SengledApi: Successfully connected to the MQTT server');

                const topicKeys = Object.keys(this.subscribe);

                if (topicKeys.length === 0) {
                    this.log.error('SengledApi: No topics to subscribe to, empty topic list.');
                    return;
                }

                this.log.debug(`SengledApi: Subscribing to topics: ${topicKeys.join(', ')}`);

                this.mqtt_client.subscribe(topicKeys, (err) => {
                    if (err) {
                        this.log.error('SengledApi: Failed to subscribe to topics', { error: err.message });
                    } else {
                        this.log.info('SengledApi: Subscribed to all topics successfully');
                    }
                });
            });

            this.mqtt_client.on('error', (err) => {
                this.log.error('SengledApi: MQTT connection error', { error: err.message });
            });

            this.mqtt_client.on('close', () => {
                this.log.warn('SengledApi: MQTT connection closed');
            });

            this.mqtt_client.on('reconnect', () => {
                this.log.info('SengledApi: Reconnecting to MQTT server...');
            });

            this.mqtt_client.on('offline', () => {
                this.log.warn('SengledApi: MQTT client is offline');
            });

            this.log.info('SengledApi: Starting MQTT loop');
            return true;
        } catch (err) {
            this.log.error('SengledApi: Exception thrown during MQTT initialization', { error: err.message });
            return false;
        }
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
        if (!this.mqtt_client) {
            this.log.error("SengledApi: MQTT client is not initialized, unable to publish message.");
            return false;
        }

        this.log.debug(`SengledApi: Preparing to publish message to topic "${topic}" with payload:`, payload);

        try {
            const result = this.mqtt_client.publish(topic, payload);

            result.on('error', (err) => {
                this.log.error("SengledApi: Error occurred during publishing", { topic, payload, error: err.message });
            });

            result.on('publish', () => {
                this.log.info(`SengledApi: Successfully published message to topic "${topic}".`);
            });

            this.log.debug("SengledApi: Publish initiated successfully.");
            return true;
        } catch (err) {
            this.log.error("SengledApi: Exception thrown during MQTT publish", { topic, payload, error: err.message });
            return false;
        }
    }


    subscribeMqtt(topic, callback) {
        if (!this.mqtt_client) {
            this.log.error("SengledApi: MQTT client is not initialized, unable to subscribe.");
            return false;
        }

        this.log.debug(`SengledApi: Attempting to subscribe to topic "${topic}".`);

        try {
            this.mqtt_client.subscribe(topic, (err) => {
                if (err) {
                    this.log.error(`SengledApi: Error subscribing to topic "${topic}"`, { error: err.message });
                    return;
                }
                this.subscribe[topic] = callback;
                this.log.info(`SengledApi: Successfully subscribed to topic "${topic}".`);
            });

            this.log.debug("SengledApi: Subscribe operation initiated successfully.");
            return true;
        } catch (err) {
            this.log.error("SengledApi: Exception thrown during MQTT subscription", { topic, error: err.message });
            return false;
        }
    }


    unsubscribeMqtt(topic) {
        if (!this.subscribe[topic]) {
            this.log.warn(`SengledApi: No active subscription found for topic "${topic}".`);
            return false;
        }

        this.log.debug(`SengledApi: Attempting to unsubscribe from topic "${topic}".`);

        try {
            this.mqtt_client.unsubscribe(topic, (err) => {
                if (err) {
                    this.log.error(`SengledApi: Error unsubscribing from topic "${topic}"`, { error: err.message });
                    return;
                }
                delete this.subscribe[topic];
                this.log.info(`SengledApi: Successfully unsubscribed from topic "${topic}".`);
            });

            this.log.debug(`SengledApi: Unsubscribe operation initiated successfully for topic "${topic}".`);
            return true;
        } catch (err) {
            this.log.error(`SengledApi: Exception thrown during MQTT unsubscription for topic "${topic}"`, { error: err.message });
            return false;
        }
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
