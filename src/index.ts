import { emptyDirSync } from 'fs-extra';

import * as SourceMapSupport from 'source-map-support';

import * as state from './state';
import * as config from './common/config';
import logger = require('./common/logger');
import { currentClusterName } from './supervisor/cluster';
import { beginWatchingWorkloads } from './supervisor/watchers';

process.on('uncaughtException', (err) => {
  if (state.shutdownInProgress) {
    return;
  }

  try {
    logger.error({err}, 'UNCAUGHT EXCEPTION!');
  } catch (ignore) {
    console.log('UNCAUGHT EXCEPTION!', err);
  } finally {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason) => {
  if (state.shutdownInProgress) {
    return;
  }

  try {
    logger.error({reason}, 'UNHANDLED REJECTION!');
  } catch (ignore) {
    console.log('UNHANDLED REJECTION!', reason);
  } finally {
    process.exit(1);
  }
});

function cleanUpTempStorage() {
  const { IMAGE_STORAGE_ROOT } = config;
  try {
    emptyDirSync(IMAGE_STORAGE_ROOT);
    logger.info({}, 'Cleaned temp storage');
  } catch (err) {
    logger.error({ err }, 'Error deleting files');
  }
};

function monitor(): void {
  try {
    logger.info({cluster: currentClusterName}, 'starting to monitor');
    beginWatchingWorkloads();
  } catch (error) {
    logger.error({error}, 'an error occurred while monitoring the cluster');
    process.exit(1);
  }
}

SourceMapSupport.install();
cleanUpTempStorage();
monitor();
