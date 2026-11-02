// -----------------------------------------------------------------------------
// SDK handlers, registered before connect(). Shared by index.js and the tests.
// -----------------------------------------------------------------------------

import { logger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';

/**
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys
 * @param {import('./controller.js').Controller} controller
 */
export function registerHandlers(gladys, controller) {
  let started = false;

  // Discovery: re-read the account's boxes and publish them.
  gladys.onScanRequest(async () => {
    await controller.refresh({ discover: true });
  });

  // A command from the user, a scene or the dashboard.
  gladys.onSetValue(async (device, feature, value) => {
    logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
    await controller.setValue(device, feature, value);
  });

  gladys.onDeviceCreated(async (device) => {
    await controller.onDeviceCreated(device);
  });

  gladys.onAction('test_connection', () => controller.testConnection());

  gladys.onConfigUpdated(async (newConfig) => {
    logger.info('Configuration updated');
    await controller.reconfigure(normalizeConfig(newConfig));
  });

  gladys.on('connected', async () => {
    try {
      if (!started) {
        started = true;
        await controller.start(normalizeConfig(await gladys.getConfig()));
      } else {
        await controller.onGladysReconnected();
      }
    } catch (err) {
      logger.error('Initialization failed', err);
      await gladys
        .setConnectionStatus(false, {
          en: 'Initialization failed, check the integration logs.',
          fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
        })
        .catch(() => {});
    }
  });
}
