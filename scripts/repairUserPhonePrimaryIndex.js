const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const User = require('../src/modules/users/user.model');

const CONFIRM_FLAG = '--confirm-rebuild-phone-index';

function isExpectedPhonePrimaryIndex(index) {
  const partial = index?.partialFilterExpression?.phonePrimary;
  return Boolean(
    index?.unique === true
    && partial
    && partial.$type === 'string'
    && partial.$gt === ''
  );
}

function summarizeIndex(index) {
  if (!index) return null;
  return {
    key: index.key,
    name: index.name,
    partialFilterExpression: index.partialFilterExpression || null,
    sparse: Boolean(index.sparse),
    unique: Boolean(index.unique),
  };
}

async function findDuplicatePhones() {
  return User.aggregate([
    { $match: { phonePrimary: { $exists: true, $type: 'string', $gt: '' } } },
    {
      $group: {
        _id: '$phonePrimary',
        count: { $sum: 1 },
        names: { $push: '$fullName' },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1, _id: 1 } },
  ]);
}

async function main() {
  const confirmed = process.argv.includes(CONFIRM_FLAG);

  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/church');

  const collection = User.collection;
  const indexes = await collection.indexes();
  const currentIndex = indexes.find((index) => index.name === 'phonePrimary_1');

  console.log('Current users indexes relevant to optional unique fields:');
  console.log(JSON.stringify(
    indexes
      .filter((index) => ['phonePrimary_1', 'email_1', 'nationalId_1'].includes(index.name))
      .map(summarizeIndex),
    null,
    2
  ));

  if (isExpectedPhonePrimaryIndex(currentIndex)) {
    console.log('phonePrimary_1 is already the expected partial unique index.');
    return;
  }

  const duplicatePhones = await findDuplicatePhones();
  if (duplicatePhones.length > 0) {
    throw new Error(
      `Cannot rebuild phonePrimary_1 because duplicate non-empty phone numbers already exist: ${JSON.stringify(duplicatePhones)}`
    );
  }

  console.log('Required index change:');
  console.log('- Drop only the existing phonePrimary_1 index if it exists and is incompatible.');
  console.log('- Create phonePrimary_1 as a unique partial index that only indexes non-empty strings.');
  console.log('- Target partialFilterExpression: { phonePrimary: { $type: "string", $gt: "" } }');

  if (!confirmed) {
    console.log(`Dry run only. Re-run with ${CONFIRM_FLAG} to apply this index change.`);
    return;
  }

  if (currentIndex) {
    await collection.dropIndex('phonePrimary_1');
    console.log('Dropped incompatible phonePrimary_1 index.');
  }

  await collection.createIndex(
    { phonePrimary: 1 },
    {
      name: 'phonePrimary_1',
      unique: true,
      partialFilterExpression: {
        phonePrimary: { $type: 'string', $gt: '' },
      },
    }
  );

  console.log('Created phonePrimary_1 as the expected partial unique index.');
}

main()
  .catch((error) => {
    console.error(`Phone index repair failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
