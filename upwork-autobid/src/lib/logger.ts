import pino, { type Logger, type LoggerOptions } from 'pino';
import { env, isProd } from '../config/env';
import { serializeError } from './errors';

const baseOptions: LoggerOptions = {
  level: env.LOG_LEVEL,
  base: { service: 'upwork-autobid' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'headers.authorization',
      'headers["x-api-key"]',
      'apiKey',
      'accessToken',
      'refreshToken',
      'password',
      'secret',
      '*.apiKey',
      '*.accessToken',
      '*.refreshToken',
      '*.password',
      '*.secret',
    ],
    censor: '[redacted]',
  },
  serializers: {
    err: serializeError,
    error: serializeError,
  },
};

// Pretty output is a dev convenience only; production stays newline-delimited JSON.
export const logger: Logger = isProd
  ? pino(baseOptions)
  : pino({
      ...baseOptions,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname,service',
          singleLine: false,
        },
      },
    });

/** Child logger tagged with the component name used in heartbeats and metrics. */
export function child(component: string, bindings: Record<string, unknown> = {}): Logger {
  return logger.child({ component, ...bindings });
}

export function createLogger(component: string, bindings: Record<string, unknown> = {}): Logger {
  return child(component, bindings);
}

export type { Logger };
export default logger;
