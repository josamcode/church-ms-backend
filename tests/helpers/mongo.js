/**
 * MongoDB harness for integration tests.
 *
 * Unit tests in this repo mock the Mongoose layer, which is fast but proves
 * nothing about how a query actually behaves against a real server. Regex
 * escaping and index behaviour in particular can only be verified by letting
 * MongoDB evaluate the query.
 *
 * Backend selection, in priority order:
 *
 *   1. `MONGO_TEST_URI` — an already-running server. Set this on any host where
 *      the downloaded `mongod` binary cannot be spawned (locked-down Windows
 *      with an Application Control policy, for instance).
 *   2. `mongodb-memory-server` — hermetic, and what CI uses on Linux.
 *   3. A local fallback (`mongodb://127.0.0.1:27017`) — used ONLY when
 *      memory-server cannot spawn its binary, so `npm run test:integration`
 *      still works on a developer box that has a local MongoDB but a blocked
 *      memory-server. Opt out with `MONGO_TEST_DISABLE_LOCAL_FALLBACK=1`.
 *
 * SAFETY — the harness can never touch an application database:
 *   - it ALWAYS connects with an isolated, random `church_ms_itest_<hex>`
 *     database name, ignoring any database in the supplied URI;
 *   - teardown drops ONLY that generated database;
 *   - a guard refuses to proceed if the resolved database name is not the
 *     generated one, so a future edit cannot accidentally point it at prod.
 */

const crypto = require('crypto');
const mongoose = require('mongoose');

const DEFAULT_LOCAL_URI = 'mongodb://127.0.0.1:27017';
const DB_NAME_PREFIX = 'church_ms_itest_';

let mongoServer = null;
let dbName = null;

function makeDbName() {
  return `${DB_NAME_PREFIX}${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * Hard safety check: the connection must be using the generated isolated
 * database, never anything else. This is what makes "never touch production"
 * a structural guarantee rather than a convention.
 */
function assertIsolatedDatabase() {
  const active = mongoose.connection?.name;
  if (active !== dbName || !String(active).startsWith(DB_NAME_PREFIX)) {
    throw new Error(
      `Integration harness refused to run: connected database "${active}" is not the `
      + `isolated test database "${dbName}". Aborting to protect application data.`
    );
  }
}

async function tryConnect(uri, { serverSelectionTimeoutMS = 8000 } = {}) {
  await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS });
  assertIsolatedDatabase();
}

async function connect() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;

  dbName = makeDbName();
  const externalUri = String(process.env.MONGO_TEST_URI || '').trim();

  // 1. Explicit test server.
  if (externalUri) {
    await tryConnect(externalUri, { serverSelectionTimeoutMS: 10000 });
    return mongoose.connection;
  }

  // 2. mongodb-memory-server (hermetic; the CI path).
  try {
    // Required lazily so the dependency is only loaded on the path that uses it.
    const { MongoMemoryServer } = require('mongodb-memory-server');
    mongoServer = await MongoMemoryServer.create();
    await tryConnect(mongoServer.getUri());
    return mongoose.connection;
  } catch (memoryServerError) {
    // 3. Local fallback — only when memory-server genuinely could not start
    //    (e.g. `spawn UNKNOWN` on a host that blocks the downloaded binary).
    if (mongoServer) {
      try { await mongoServer.stop(); } catch { /* ignore */ }
      mongoServer = null;
    }
    if (String(process.env.MONGO_TEST_DISABLE_LOCAL_FALLBACK || '') === '1') {
      throw memoryServerError;
    }

    // eslint-disable-next-line no-console
    console.warn(
      `[integration] mongodb-memory-server unavailable (${memoryServerError.message}); `
      + `falling back to ${DEFAULT_LOCAL_URI}. Set MONGO_TEST_URI to override, or `
      + `MONGO_TEST_DISABLE_LOCAL_FALLBACK=1 to fail instead.`
    );
    await tryConnect(DEFAULT_LOCAL_URI);
    return mongoose.connection;
  }
}

async function clearDatabase() {
  if (mongoose.connection.readyState !== 1) return;
  assertIsolatedDatabase();
  const { collections } = mongoose.connection;
  await Promise.all(
    Object.values(collections).map((collection) => collection.deleteMany({}))
  );
}

async function disconnect() {
  if (mongoose.connection.readyState !== 0) {
    // Drop ONLY the generated isolated database, and only after re-checking it
    // is the isolated one — never the caller's other data.
    assertIsolatedDatabase();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  if (mongoServer) {
    await mongoServer.stop();
    mongoServer = null;
  }
  dbName = null;
}

/**
 * Install the standard lifecycle hooks.
 *
 * The generous timeout covers the one-off `mongod` binary download on a cold
 * cache; subsequent runs start in well under a second.
 */
function withMongo({ timeoutMs = 120000 } = {}) {
  beforeAll(async () => {
    await connect();
  }, timeoutMs);

  afterEach(async () => {
    await clearDatabase();
  });

  afterAll(async () => {
    await disconnect();
  }, timeoutMs);
}

module.exports = { connect, disconnect, clearDatabase, withMongo, makeDbName };
