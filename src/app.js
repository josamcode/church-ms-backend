const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');
const hpp = require('hpp');
const morgan = require('morgan');
const config = require('./config/env');
const { generalLimiter } = require('./middlewares/rateLimit');
const requestId = require('./middlewares/requestId');
const notFound = require('./middlewares/notFound');
const errorHandler = require('./middlewares/errorHandler');
const logger = require('./utils/logger');

// Route imports
const authRoutes = require('./modules/auth/auth.routes');
const userRoutes = require('./modules/users/user.routes');
const settingsRoutes = require('./modules/settings/settings.routes');
const confessionsRoutes = require('./modules/confessions/confessions.routes');

// Swagger
const { swaggerUi, specs } = require('./docs/swagger');

const app = express();

/* ══════════════════ Security Middleware ══════════════════ */

app.use(helmet());

app.use(
  cors({
    origin: config.cors.origin === '*' ? '*' : config.cors.origin.split(','),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  })
);

app.use(mongoSanitize());
app.use(xss());
app.use(hpp());

/* ══════════════════ Request ID ══════════════════ */

app.use(requestId);

/* ══════════════════ Body Parsing ══════════════════ */

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

/* ══════════════════ Rate Limiting ══════════════════ */

app.use('/api', generalLimiter);

/* ══════════════════ Logging ══════════════════ */

if (config.env !== 'test') {
  const morganStream = {
    write: (message) => logger.info(message.trim()),
  };
  app.use(
    morgan(':method :url :status :res[content-length] - :response-time ms', {
      stream: morganStream,
      skip: (req) => req.path.startsWith('/socket.io'),
    })
  );
}

/* ══════════════════ API Documentation ══════════════════ */

app.use(
  '/api/docs',
  swaggerUi.serve,
  swaggerUi.setup(specs, {
    explorer: true,
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'نظام إدارة الكنيسة - توثيق API',
  })
);

/* ══════════════════ Routes ══════════════════ */

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/confessions', confessionsRoutes);

/* ══════════════════ Health Check ══════════════════ */

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'الخادم يعمل بنجاح',
    data: {
      uptime: process.uptime(),
      environment: config.env,
      timestamp: new Date().toISOString(),
    },
    requestId: res.requestId,
    timestamp: new Date().toISOString(),
  });
});

/* ══════════════════ Ignore Socket.IO probes (no WebSocket server) ══════════════════ */

app.use((req, res, next) => {
  if (req.path.startsWith('/socket.io')) {
    res.status(404).end();
    return;
  }
  next();
});

/* ══════════════════ Error Handling ══════════════════ */

app.use(notFound);
app.use(errorHandler);

module.exports = app;
