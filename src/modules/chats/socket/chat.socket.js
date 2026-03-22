const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const config = require('../../../config/env');
const redisClient = require('../../../config/redis');
const { CACHE_KEYS } = require('../../../constants/cacheKeys');
const { getUserEffectivePermissions } = require('../../../middlewares/permissions');
const User = require('../../users/user.model');
const { setChatIo, getUserRoom } = require('../chat.realtime');

const parseAllowedOrigins = () => {
  if (!config.cors.origin || config.cors.origin === '*') {
    return '*';
  }

  return config.cors.origin
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
};

const extractSocketToken = (socket) => {
  const authToken = socket.handshake.auth?.token;
  if (authToken) return String(authToken);

  const authHeader = socket.handshake.headers?.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  return null;
};

const initializeChatSocketServer = (httpServer) => {
  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: {
      origin: parseAllowedOrigins(),
      credentials: true,
      methods: ['GET', 'POST'],
    },
  });

  io.use(async (socket, next) => {
    try {
      const token = extractSocketToken(socket);
      if (!token) {
        return next(new Error('AUTH_UNAUTHORIZED'));
      }

      const decoded = jwt.verify(token, config.jwt.accessSecret);
      const user = await User.findById(decoded.sub)
        .select('role extraPermissions deniedPermissions isDeleted isLocked authVersion fullName avatar')
        .lean();

      if (!user || user.isDeleted) {
        return next(new Error('AUTH_TOKEN_INVALID'));
      }

      if (user.isLocked) {
        return next(new Error('AUTH_ACCOUNT_LOCKED'));
      }

      if (decoded.jti) {
        const isBlacklisted = await redisClient.get(CACHE_KEYS.TOKEN_BLACKLIST(decoded.jti));
        if (isBlacklisted) {
          return next(new Error('AUTH_TOKEN_BLACKLISTED'));
        }
      }

      if (Number(decoded.authVersion || 0) !== Number(user.authVersion || 0)) {
        return next(new Error('AUTH_SESSION_INVALIDATED'));
      }

      socket.data.user = {
        id: String(user._id),
        role: user.role,
        fullName: user.fullName || '',
        avatar: user.avatar?.url || '',
      };
      socket.data.permissions = await getUserEffectivePermissions(
        user._id,
        user.role,
        user.extraPermissions || [],
        user.deniedPermissions || []
      );

      return next();
    } catch (error) {
      return next(
        new Error(error.name === 'TokenExpiredError' ? 'AUTH_TOKEN_EXPIRED' : 'AUTH_TOKEN_INVALID')
      );
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.data.user?.id;
    if (userId) {
      socket.join(getUserRoom(userId));
    }

    socket.emit('chat:connected', {
      userId,
    });
  });

  setChatIo(io);
  return io;
};

module.exports = {
  initializeChatSocketServer,
};
