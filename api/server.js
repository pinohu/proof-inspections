'use strict';

/**
 * Express application factory. Keeps construction side-effect free so tests
 * can build isolated app instances against temp data directories.
 */

const express = require('express');
const { buildRouter } = require('./routes');

function createApp({ stmts, attestation, keypair, dataDir }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // JSON parse errors -> clean 400 instead of an HTML stack trace.
  app.use((err, _req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'invalid_json', message: 'request body is not valid JSON' } });
    }
    return next(err);
  });

  app.use(buildRouter({ stmts, attestation, keypair, dataDir }));

  // Final error handler: never leak internals.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.statusCode || 500;
    res.status(status).json({ error: { code: 'internal_error', message: 'unexpected server error' } });
  });

  return app;
}

module.exports = { createApp };
