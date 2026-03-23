const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const mongoSanitize = require('express-mongo-sanitize');
const hpp = require('hpp');
const morgan = require('morgan');
const config = require('./config/env');
const { generalLimiter } = require('./middlewares/rateLimit');
const requestId = require('./middlewares/requestId');
const sanitizeRequest = require('./middlewares/sanitizeRequest');
const notFound = require('./middlewares/notFound');
const errorHandler = require('./middlewares/errorHandler');
const logger = require('./utils/logger');

const authRoutes = require('./modules/auth/auth.routes');
const userRoutes = require('./modules/users/user.routes');
const settingsRoutes = require('./modules/settings/settings.routes');
const landingContentRoutes = require('./modules/landingContent/landingContent.routes');
const confessionsRoutes = require('./modules/confessions/confessions.routes');
const visitationsRoutes = require('./modules/visitations/visitations.routes');
const meetingsRoutes = require('./modules/meetings/meetings.routes');
const divineLiturgiesRoutes = require('./modules/divineLiturgies/divineLiturgies.routes');
const archiveRoutes = require('./modules/archive/archive.routes');
const notificationsInboxRoutes = require('./modules/notifications/inbox.routes');
const notificationsContentRoutes = require('./modules/notifications/notifications.routes');
const pushRoutes = require('./modules/notifications/push.routes');
const bookingsRoutes = require('./modules/bookings/bookings.routes');
const householdClassificationRoutes = require('./modules/householdClassifications/householdClassification.routes');
const aidRoutes = require('./modules/aids/aid.routes');
const chatRoutes = require('./modules/chats/chat.routes');
const systemAnalyticsRoutes = require('./modules/systemAnalytics/systemAnalytics.routes');

const { swaggerUi, specs } = require('./docs/swagger');

const app = express();

app.set('trust proxy', config.http.trustProxy);
app.use(helmet());

app.use(
  cors({
    credentials: config.cors.credentials,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (config.cors.allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error('CORS origin not allowed'));
    },
  })
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(mongoSanitize());
app.use(hpp());
app.use(sanitizeRequest);
app.use(requestId);
app.use('/api', generalLimiter);

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

if (config.docs.enabled) {
  app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(specs, {
      explorer: true,
      customCss: '.swagger-ui .topbar { display: none }',
      customSiteTitle: 'Church Management API Docs',
    })
  );
}

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/landing-content', landingContentRoutes);
app.use('/api/confessions', confessionsRoutes);
app.use('/api/visitations', visitationsRoutes);
app.use('/api/meetings', meetingsRoutes);
app.use('/api/divine-liturgies', divineLiturgiesRoutes);
app.use('/api/archive', archiveRoutes);
app.use('/api/notifications', notificationsInboxRoutes);
app.use('/api/notifications/content', notificationsContentRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/bookings', bookingsRoutes);
app.use('/api/household-classifications', householdClassificationRoutes);
app.use('/api/aids', aidRoutes);
app.use('/api/system-analytics', systemAnalyticsRoutes);

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'Server is healthy',
    data: {
      uptime: process.uptime(),
      environment: config.env,
      timestamp: new Date().toISOString(),
      redisFallback: require('./config/redis').isFallback,
    },
    requestId: res.requestId,
    timestamp: new Date().toISOString(),
  });
});

app.use(notFound);
app.use(errorHandler);

module.exports = app;
