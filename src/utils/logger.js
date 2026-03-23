const winston = require('winston');
const path = require('path');
const fs = require('fs');
const isProduction = process.env.NODE_ENV === 'production';
const enableConsoleLogging = process.env.LOG_TO_CONSOLE !== 'false';

const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const logger = winston.createLogger({
  level: isProduction ? 'info' : 'debug',
  format: logFormat,
  defaultMeta: { service: 'church-api' },
  transports: [
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 5242880,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      maxsize: 5242880,
      maxFiles: 5,
    }),
  ],
});

if (enableConsoleLogging) {
  logger.add(
    new winston.transports.Console({
      format: isProduction
        ? logFormat
        : winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ level, message, timestamp, service, ...meta }) => {
            const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
            return `${timestamp} [${service}] ${level}: ${message}${metaStr}`;
          })
        ),
    })
  );
}

module.exports = logger;
