// Environment loading and validation.
// Values come from process.env (populated by `node --env-file-if-exists=../.env`).
// Validation never throws at import time so /api/health can report an invalid env.

const NODE_ENVS = ['development', 'test', 'production'];

export function validateEnv(source = process.env) {
  const errors = [];

  const nodeEnv = source.NODE_ENV ?? 'development';
  if (!NODE_ENVS.includes(nodeEnv)) {
    errors.push(`NODE_ENV must be one of ${NODE_ENVS.join(', ')}`);
  }

  const rawPort = source.PORT ?? '4000';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push('PORT must be an integer between 1 and 65535');
  }

  const mongodbUri = source.MONGODB_URI;
  if (!mongodbUri) {
    errors.push('MONGODB_URI is required');
  } else if (!/^mongodb(\+srv)?:\/\//.test(mongodbUri)) {
    errors.push('MONGODB_URI must start with mongodb:// or mongodb+srv://');
  }

  return {
    valid: errors.length === 0,
    errors,
    config: Object.freeze({ nodeEnv, port, mongodbUri }),
  };
}

export const env = validateEnv();
