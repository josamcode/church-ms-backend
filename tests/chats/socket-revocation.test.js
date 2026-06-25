/**
 * P0 Regression Tests — Socket Session Revocation
 */

const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const ACCESS_SECRET = 'test-access-secret-32-chars-min';

// ── Mocks ──

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

jest.mock('../../src/config/redis', () => ({
  get: jest.fn().mockResolvedValue(null),
  setex: jest.fn(), del: jest.fn(),
  isFallback: true, status: 'ready', on: jest.fn(), call: jest.fn(),
  ensureRedisReady: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/config/env', () => ({
  env: 'test', isProduction: false, isDevelopmentLike: true,
  jwt: { accessSecret: ACCESS_SECRET, refreshSecret: 'test-refresh', accessExpiresIn: '15m' },
  cors: { allowedOrigins: ['http://localhost:3000'] },
}));

jest.mock('../../src/constants/cacheKeys', () => ({
  CACHE_KEYS: { TOKEN_BLACKLIST: (jti) => `auth:blacklist:${jti}` },
}));

jest.mock('../../src/middlewares/permissions', () => ({
  getUserEffectivePermissions: jest.fn().mockResolvedValue(['AUTH_VIEW_SELF']),
}));

jest.mock('../../src/modules/chats/chatThread.model', () => ({
  ChatThread: { findById: jest.fn().mockReturnValue({ select: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue(null) }) },
}));

jest.mock('../../src/modules/chats/chat.realtime', () => {
  const actual = jest.requireActual('../../src/modules/chats/chat.realtime');
  return {
    ...actual,
    setChatIo: actual.setChatIo,
    getUserRoom: actual.getUserRoom,
    emitTypingIndicator: jest.fn(),
    syncSocketActiveThreadView: jest.fn(),
  };
});

// ═══════════════════════════════════════════════════════════════
//  Tests
// ═══════════════════════════════════════════════════════════════

describe('Socket Session Revocation', () => {
  let UserModel;
  let initializeChatSocketServer;

  beforeAll(() => {
    initializeChatSocketServer = require('../../src/modules/chats/socket/chat.socket').initializeChatSocketServer;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Stub User.findById to return a valid user by default
    UserModel = require('../../src/modules/users/user.model');
  });

  // ═══════════════════════════════════════════════════════════════
  //  Helpers
  // ═══════════════════════════════════════════════════════════════
  function signToken(overrides = {}) {
    return jwt.sign(
      {
        sub: String(overrides.sub || new mongoose.Types.ObjectId()),
        role: overrides.role || 'USER',
        authVersion: overrides.authVersion !== undefined ? overrides.authVersion : 0,
        jti: overrides.jti || 'test-jti',
      },
      ACCESS_SECRET,
      { expiresIn: '15m' }
    );
  }

  function mockSocket(token) {
    return {
      handshake: {
        auth: { token },
        headers: {},
      },
      data: {},
      join: jest.fn(),
      on: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
    };
  }

  function mockHttpServer() {
    // Socket.IO needs a real http.Server instance (checks .listeners).
    return require('http').createServer();
  }

  // ═══════════════════════════════════════════════════════════════
  //  1-5: Handshake rejection tests
  // ═══════════════════════════════════════════════════════════════
  describe('socket_handshake', () => {
    let ioInstance;

    beforeEach(() => {
      const httpServer = mockHttpServer();
      jest.spyOn(UserModel, 'findById').mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue({
          _id: new mongoose.Types.ObjectId(),
          role: 'USER',
          extraPermissions: [], deniedPermissions: [],
          isDeleted: false, isLocked: false,
          authVersion: 0, fullName: 'Test', avatar: null,
          hasLogin: true, accountStatus: 'approved',
        }),
      });
      ioInstance = initializeChatSocketServer(httpServer);
    });

    afterEach(() => {
      if (ioInstance) ioInstance.close();
    });

    function getAuthMiddleware() {
      const mainNs = ioInstance._nsps.get('/');
      return mainNs?._fns?.[0] || null;
    }

    function runMiddleware(socket, next) {
      const mw = getAuthMiddleware();
      if (!mw) throw new Error('No auth middleware registered');
      mw(socket, next);
    }

    // 1. socket_handshake_rejects_no_login_user
    it('socket_handshake_rejects_no_login_user', (done) => {
      UserModel.findById.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue({
          _id: new mongoose.Types.ObjectId(), role: 'USER',
          isDeleted: false, isLocked: false,
          authVersion: 0, hasLogin: false, accountStatus: 'approved',
          extraPermissions: [], deniedPermissions: [],
        }),
      });

      const socket = mockSocket(signToken());
      runMiddleware(socket, (err) => {
        expect(err).toBeDefined();
        expect(err.message).toBe('AUTH_NO_LOGIN_ACCESS');
        done();
      });
    });

    // 2. socket_handshake_rejects_pending_user
    it('socket_handshake_rejects_pending_user', (done) => {
      UserModel.findById.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue({
          _id: new mongoose.Types.ObjectId(), role: 'USER',
          isDeleted: false, isLocked: false,
          authVersion: 0, hasLogin: true, accountStatus: 'pending',
          extraPermissions: [], deniedPermissions: [],
        }),
      });

      const socket = mockSocket(signToken());
      runMiddleware(socket, (err) => {
        expect(err).toBeDefined();
        expect(err.message).toBe('AUTH_ACCOUNT_PENDING');
        done();
      });
    });

    // 3. socket_handshake_rejects_rejected_user
    it('socket_handshake_rejects_rejected_user', (done) => {
      UserModel.findById.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue({
          _id: new mongoose.Types.ObjectId(), role: 'USER',
          isDeleted: false, isLocked: false,
          authVersion: 0, hasLogin: true, accountStatus: 'rejected',
          extraPermissions: [], deniedPermissions: [],
        }),
      });

      const socket = mockSocket(signToken());
      runMiddleware(socket, (err) => {
        expect(err).toBeDefined();
        expect(err.message).toBe('AUTH_ACCOUNT_REJECTED');
        done();
      });
    });

    // 4. socket_handshake_rejects_locked_user
    it('socket_handshake_rejects_locked_user', (done) => {
      UserModel.findById.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue({
          _id: new mongoose.Types.ObjectId(), role: 'USER',
          isDeleted: false, isLocked: true,
          authVersion: 0, hasLogin: true, accountStatus: 'approved',
          extraPermissions: [], deniedPermissions: [],
        }),
      });

      const socket = mockSocket(signToken());
      runMiddleware(socket, (err) => {
        expect(err).toBeDefined();
        expect(err.message).toBe('AUTH_ACCOUNT_LOCKED');
        done();
      });
    });

    // 5. socket_handshake_rejects_auth_version_mismatch
    it('socket_handshake_rejects_auth_version_mismatch', (done) => {
      UserModel.findById.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue({
          _id: new mongoose.Types.ObjectId(), role: 'USER',
          isDeleted: false, isLocked: false,
          authVersion: 5, hasLogin: true, accountStatus: 'approved',
          extraPermissions: [], deniedPermissions: [],
        }),
      });

      const socket = mockSocket(signToken({ authVersion: 0 }));
      runMiddleware(socket, (err) => {
        expect(err).toBeDefined();
        expect(err.message).toBe('AUTH_SESSION_INVALIDATED');
        done();
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  6-10: disconnectUserSockets tests
  // ═══════════════════════════════════════════════════════════════
  describe('disconnectUserSockets', () => {
    let disconnectUserSockets;
    let chatRealtime;

    beforeAll(() => {
      chatRealtime = require('../../src/modules/chats/chat.realtime');
      disconnectUserSockets = chatRealtime.disconnectUserSockets;
    });

    beforeEach(() => {
      jest.clearAllMocks();
    });

    function setupMockIo(socketsMap = new Map(), roomsMap = new Map()) {
      const io = {
        sockets: {
          adapter: {
            rooms: roomsMap,
          },
          sockets: socketsMap,
        },
      };
      chatRealtime.setChatIo(io);
      return io;
    }

    function mockSocketInstance(id, userId) {
      return {
        id,
        data: { user: { id: String(userId) } },
        emit: jest.fn(),
        disconnect: jest.fn(),
        join: jest.fn(),
        on: jest.fn(),
      };
    }

    // 6. locked_user_socket_is_disconnected_and_receives_no_events
    it('locked_user_socket_is_disconnected_and_receives_no_events', () => {
      const userId = 'user-locked-1';
      const socket1 = mockSocketInstance('sock-a', userId);
      const socket2 = mockSocketInstance('sock-b', userId);

      const socketsMap = new Map([['sock-a', socket1], ['sock-b', socket2]]);
      const room = new Set(['sock-a', 'sock-b']);
      const roomsMap = new Map([[`user:${userId}`, room]]);

      setupMockIo(socketsMap, roomsMap);

      disconnectUserSockets(userId, 'account_locked');

      // Both sockets should emit auth:revoked then disconnect
      expect(socket1.emit).toHaveBeenCalledWith('auth:revoked', expect.objectContaining({
        reason: 'account_locked',
      }));
      expect(socket1.disconnect).toHaveBeenCalledWith(true);

      expect(socket2.emit).toHaveBeenCalledWith('auth:revoked', expect.objectContaining({
        reason: 'account_locked',
      }));
      expect(socket2.disconnect).toHaveBeenCalledWith(true);
    });

    // 7. has_login_false_disconnects_existing_user_sockets
    it('has_login_false_disconnects_existing_user_sockets', () => {
      const userId = 'user-nologin-1';
      const socket = mockSocketInstance('sock-c', userId);
      const socketsMap = new Map([['sock-c', socket]]);
      const room = new Set(['sock-c']);
      const roomsMap = new Map([[`user:${userId}`, room]]);

      setupMockIo(socketsMap, roomsMap);
      disconnectUserSockets(userId, 'account_disabled');

      expect(socket.emit).toHaveBeenCalledWith('auth:revoked', expect.objectContaining({
        reason: 'account_disabled',
      }));
      expect(socket.disconnect).toHaveBeenCalled();
    });

    // 8. account_status_change_disconnects_existing_user_sockets
    it('account_status_change_disconnects_existing_user_sockets', () => {
      const userId = 'user-status-1';
      const socket = mockSocketInstance('sock-d', userId);
      const socketsMap = new Map([['sock-d', socket]]);
      const room = new Set(['sock-d']);
      const roomsMap = new Map([[`user:${userId}`, room]]);

      setupMockIo(socketsMap, roomsMap);
      disconnectUserSockets(userId, 'account_disabled');

      expect(socket.emit).toHaveBeenCalled();
      expect(socket.disconnect).toHaveBeenCalled();
    });

    // 9. auth_version_increment_disconnects_existing_user_sockets
    it('auth_version_increment_disconnects_existing_user_sockets', () => {
      const userId = 'user-version-1';
      const socket = mockSocketInstance('sock-e', userId);
      const socketsMap = new Map([['sock-e', socket]]);
      const room = new Set(['sock-e']);
      const roomsMap = new Map([[`user:${userId}`, room]]);

      setupMockIo(socketsMap, roomsMap);
      disconnectUserSockets(userId, 'auth_version_changed');

      expect(socket.emit).toHaveBeenCalledWith('auth:revoked', expect.objectContaining({
        reason: 'auth_version_changed',
      }));
      expect(socket.disconnect).toHaveBeenCalled();
    });

    // 10. multiple_sockets_for_same_user_are_all_disconnected
    it('multiple_sockets_for_same_user_are_all_disconnected', () => {
      const userId = 'user-multi-1';
      const devices = ['sock-1', 'sock-2', 'sock-3', 'sock-4'].map((id) =>
        mockSocketInstance(id, userId)
      );

      const socketsMap = new Map(devices.map((d) => [d.id, d]));
      const room = new Set(devices.map((d) => d.id));
      const roomsMap = new Map([[`user:${userId}`, room]]);

      setupMockIo(socketsMap, roomsMap);
      disconnectUserSockets(userId, 'deleted');

      devices.forEach((d) => {
        expect(d.emit).toHaveBeenCalledWith('auth:revoked', expect.objectContaining({
          reason: 'deleted',
        }));
        expect(d.disconnect).toHaveBeenCalledWith(true);
      });
    });

    // No-op cases
    it('should do nothing when io is not initialized', () => {
      chatRealtime.setChatIo(null);
      expect(() => disconnectUserSockets('any-user', 'any-reason')).not.toThrow();
    });

    it('should do nothing when user has no sockets', () => {
      const socketsMap = new Map();
      const roomsMap = new Map();
      setupMockIo(socketsMap, roomsMap);
      expect(() => disconnectUserSockets('no-such-user', 'any-reason')).not.toThrow();
    });

    it('should handle missing socket in sockets map gracefully', () => {
      // Room references a socket ID that's not in the sockets map
      const userId = 'user-ghost-1';
      const socketsMap = new Map(); // empty
      const room = new Set(['ghost-sock']);
      const roomsMap = new Map([[`user:${userId}`, room]]);

      setupMockIo(socketsMap, roomsMap);
      expect(() => disconnectUserSockets(userId, 'any-reason')).not.toThrow();
    });

    it('should handle emit failure without breaking disconnect', () => {
      const userId = 'user-emit-fail';
      const socket = mockSocketInstance('sock-f', userId);
      socket.emit.mockImplementation(() => { throw new Error('emit failed'); });
      const socketsMap = new Map([['sock-f', socket]]);
      const room = new Set(['sock-f']);
      const roomsMap = new Map([[`user:${userId}`, room]]);

      setupMockIo(socketsMap, roomsMap);
      // Should not throw — disconnect is still called
      expect(() => disconnectUserSockets(userId, 'test')).not.toThrow();
      expect(socket.disconnect).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  Verify handshake select covers all required fields
  // ═══════════════════════════════════════════════════════════════
  describe('handshake_select_includes_all_required_fields', () => {
    it('socket handshake middleware selects hasLogin and accountStatus', () => {
      const fs = require('fs');
      const source = fs.readFileSync(
        require.resolve('../../src/modules/chats/socket/chat.socket'),
        'utf-8'
      );
      // The .select() line must include the new fields
      expect(source).toContain('hasLogin');
      expect(source).toContain('accountStatus');
      // Rejection reasons must be present
      expect(source).toContain('AUTH_NO_LOGIN_ACCESS');
      expect(source).toContain('AUTH_ACCOUNT_PENDING');
      expect(source).toContain('AUTH_ACCOUNT_REJECTED');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  Verify mutation sites call disconnectUserSockets
  // ═══════════════════════════════════════════════════════════════
  describe('mutation_sites_call_disconnectUserSockets', () => {
    it('user.service.js imports disconnectUserSockets', () => {
      const fs = require('fs');
      const source = fs.readFileSync(
        require.resolve('../../src/modules/users/user.service'),
        'utf-8'
      );
      expect(source).toContain("disconnectUserSockets");
      // lockUser, deleteUser, unlockUser, updateUser should all call it
      const disconnectCalls = (source.match(/disconnectUserSockets/g) || []).length;
      expect(disconnectCalls).toBeGreaterThanOrEqual(5); // import + 4 calls
    });

    it('auth.service.js imports disconnectUserSockets', () => {
      const fs = require('fs');
      const source = fs.readFileSync(
        require.resolve('../../src/modules/auth/auth.service'),
        'utf-8'
      );
      expect(source).toContain("disconnectUserSockets");
      const disconnectCalls = (source.match(/disconnectUserSockets/g) || []).length;
      expect(disconnectCalls).toBeGreaterThanOrEqual(3); // import + 2 calls
    });

    it('chat.realtime.js exports disconnectUserSockets', () => {
      const realtime = require('../../src/modules/chats/chat.realtime');
      expect(typeof realtime.disconnectUserSockets).toBe('function');
    });
  });
});
