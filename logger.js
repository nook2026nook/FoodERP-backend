const pino = require('pino');
const config = require('./config');

module.exports = pino({
  level: process.env.LOG_LEVEL || (config.isProd ? 'info' : 'debug'),
  redact: {
    paths: [
      'req.headers.authorization',
      'req.body.password',
      'req.body.newPassword',
      'req.body.currentPassword',
      'req.body.passcode',
      '*.access_token', '*.refresh_token'
    ],
    censor: '[redacted]'
  }
});
