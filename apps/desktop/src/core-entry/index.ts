import { startCoreProcess } from '@kepcup/core';

startCoreProcess({
  appVersion: process.env['KEPCUP_APP_VERSION'],
  exitOnShutdown: true,
});
