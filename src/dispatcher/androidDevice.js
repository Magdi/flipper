/**
 * Copyright 2018-present Facebook.
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * @format
 */

import AndroidDevice from '../devices/AndroidDevice';
import child_process from 'child_process';
import {promisify} from 'util';
import type {Store} from '../reducers/index.js';
import type BaseDevice from '../devices/BaseDevice';
import type Logger from '../fb-stubs/Logger.js';
const adb = require('adbkit-fb');

function createDevice(adbClient, device): Promise<AndroidDevice> {
  return new Promise((resolve, reject) => {
    const type =
      device.type !== 'device' || device.id.startsWith('emulator')
        ? 'emulator'
        : 'physical';

    adbClient.getProperties(device.id).then(async props => {
      let name = props['ro.product.model'];
      if (type === 'emulator') {
        name = (await getRunningEmulatorName(device.id)) || name;
      }
      const androidDevice = new AndroidDevice(device.id, type, name, adbClient);
      androidDevice.reverse();
      resolve(androidDevice);
    });
  });
}

function getRunningEmulatorName(id: string): Promise<?string> {
  return new Promise((resolve, reject) => {
    const port = id.replace('emulator-', '');
    // The GNU version of netcat doesn't terminate after 1s when
    // specifying `-w 1`, so we kill it after a timeout. Because
    // of that, even in case of an error, there may still be
    // relevant data for us to parse.
    child_process.exec(
      `echo "avd name" | nc -w 1 localhost ${port}`,
      {timeout: 1000, encoding: 'utf-8'},
      (error: ?Error, data) => {
        if (data != null && typeof data === 'string') {
          const match = data.trim().match(/(.*)\r\nOK$/);
          resolve(match != null && match.length > 0 ? match[1] : null);
        } else {
          reject(error);
        }
      },
    );
  });
}

export default (store: Store, logger: Logger) => {
  // Adbkit will attempt to start the adb server if it's not already running,
  // however, it sometimes fails with ENOENT errors. So instead, we start it
  // manually before requesting a client.

  function createClient() {
    return promisify(child_process.exec)('adb start-server')
      .then(result => {
        if (result.error) {
          throw new Error(
            `Failed to start adb server: ${result.stderr.toString()}`,
          );
        }
      })
      .then(adb.createClient);
  }

  const watchAndroidDevices = () => {
    // get emulators
    child_process.exec(
      'emulator -list-avds',
      (error: ?Error, data: ?string) => {
        if (error != null || data == null) {
          console.error(error || 'Failed to list AVDs');
          return;
        }
        const payload = data.split('\n').filter(Boolean);
        store.dispatch({
          type: 'REGISTER_ANDROID_EMULATORS',
          payload,
        });
      },
    );

    createClient()
      .then(client => {
        client
          .trackDevices()
          .then(tracker => {
            tracker.on('error', err => {
              if (err.message === 'Connection closed') {
                // adb server has shutdown, remove all android devices
                const {connections} = store.getState();
                const deviceIDsToRemove: Array<
                  string,
                > = connections.devices
                  .filter(
                    (device: BaseDevice) => device instanceof AndroidDevice,
                  )
                  .map((device: BaseDevice) => device.serial);

                unregisterDevices(deviceIDsToRemove);
                console.error('adb server was shutdown');
                setTimeout(watchAndroidDevices, 500);
              } else {
                throw err;
              }
            });

            tracker.on('add', async device => {
              if (device.type !== 'offline') {
                registerDevice(client, device);
              }
            });

            tracker.on('change', async device => {
              if (device.type === 'offline') {
                unregisterDevices([device.id]);
              } else {
                registerDevice(client, device);
              }
            });

            tracker.on('remove', device => {
              unregisterDevices([device.id]);
            });
          })
          .catch(err => {
            if (err.code === 'ECONNREFUSED') {
              // adb server isn't running
            } else {
              throw err;
            }
          });
      })
      .catch(e => {
        console.error(`Failed to watch for android devices: ${e.message}`);
      });
  };

  async function registerDevice(adbClient: any, deviceData: any) {
    const androidDevice = await createDevice(adbClient, deviceData);
    logger.track('usage', 'register-device', {
      os: 'Android',
      name: androidDevice.title,
      serial: androidDevice.serial,
    });
    store.dispatch({
      type: 'REGISTER_DEVICE',
      payload: androidDevice,
    });
  }

  async function unregisterDevices(deviceIds: Array<string>) {
    deviceIds.forEach(id =>
      logger.track('usage', 'unregister-device', {
        os: 'Android',
        serial: id,
      }),
    );
    store.dispatch({
      type: 'UNREGISTER_DEVICES',
      payload: new Set(deviceIds),
    });
  }

  watchAndroidDevices();
};
