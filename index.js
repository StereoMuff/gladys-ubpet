// -----------------------------------------------------------------------------
// Entry point: the SDK, the controller, the handlers. No device logic here.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { Controller } from './src/controller.js';
import { registerHandlers } from './src/handlers.js';

const gladys = new GladysIntegration();
const controller = new Controller({ gladys });
registerHandlers(gladys, controller);

gladys.handleShutdown(async (signal) => {
  logger.info(`Received ${signal}, shutting down`);
  await controller.stop();
});

logger.info('Starting the UBPet / UPET litter box integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
