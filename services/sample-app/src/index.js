'use strict';

const express = require('express');
const pino = require('pino');
const client = require('prom-client');

const app = express();
const port = Number(process.env.PORT || 8080);
const env = process.env.APP_ENV || 'dev';
const service = 'sample-app';

const logger = pino({
  base: { service, env },
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
});

const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'sample_app_' });

const requestCounter = new client.Counter({
  name: 'sample_app_http_requests_total',
  help: 'Total HTTP requests processed by sample-app',
  labelNames: ['method', 'route', 'status_code', 'env'],
  registers: [register],
});

const requestDuration = new client.Histogram({
  name: 'sample_app_http_request_duration_seconds',
  help: 'HTTP request latency for sample-app',
  labelNames: ['method', 'route', 'status_code', 'env'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route && req.route.path ? req.route.path : req.path;
    const labels = {
      method: req.method,
      route,
      status_code: String(res.statusCode),
      env,
    };

    requestCounter.inc(labels, 1);
    requestDuration.observe(labels, durationSeconds);

    logger.info({
      method: req.method,
      route,
      statusCode: res.statusCode,
      durationSeconds,
      msg: 'request completed',
    });
  });

  next();
});

app.get('/', (req, res) => {
  res.json({
    service,
    env,
    message: 'Hello from the GitOps sample app',
    now: new Date().toISOString(),
  });
});

app.get('/healthz', (req, res) => {
  res.status(200).send('ok');
});

app.get('/readyz', (req, res) => {
  res.status(200).send('ready');
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.listen(port, () => {
  logger.info({ port, env, msg: 'sample-app listening' });
});
