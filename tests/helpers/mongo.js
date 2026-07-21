/**
 * MongoDB harness for integration tests.
 *
 * Unit tests in this repo mock the Mongoose layer, which is fast but proves
 * nothing about how a query actually behaves against a real server. Regex
 * escaping and index behaviour in particular can only be verified by letting
 * MongoDB evaluate the query.
 *
 * Two backends, in priority order:
 *
 *   1. `MONGO_TEST_URI` — an already-running server. Used when the environment
 *      cannot spawn the downloaded `mongod` binary (locked-down Windows hosts
 *      with an Application Control policy, for instance).
 *   2. `mongodb-memory-server` — the default. Hermetic, and what CI uses.
 *
 * Either way the tests run against a real server. The database name is unique
 * per run and dropped on teardown, so pointing `MONGO_TEST_URI` at a shared
 * development server cannot disturb existing data.
 */

const crypto = require('crypto');
const mongoose = require('mongoose');

let mongoServer = null;
let dbName = null;

function makeDbName() {
  return `church_ms_itest_${crypto.randomBytes(6).toString('hex')}`;
}

async function connect() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;

  dbName = makeDbName();
  const externalUri = String(process.env.MONGO_TEST_URI || '').trim();

  if (externalUri) {
    await mongoose.connect(externalUri, { dbName, serverSelectionTimeoutMS: 10000 });
    return mongoose.connection;
  }

  // Required lazily so the dependency is only loaded on the path that uses it.
  const { MongoMemoryServer } = require('mongodb-memory-server');
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri(), { dbName });
  return mongoose.connection;
}

async function clearDatabase() {
  if (mongoose.connection.readyState !== 1) return;
  const { collections } = mongoose.connection;
  await Promise.all(
    Object.values(collections).map((collection) => collection.deleteMany({}))
  );
}

async function disconnect() {
  if (mongoose.connection.readyState !== 0) {
    // Scoped to the generated database only — never the caller's other data.
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
