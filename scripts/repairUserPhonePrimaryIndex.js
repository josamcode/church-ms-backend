const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const User = require('../src/modules/users/user.model');

async function main() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/church');

  const collection = User.collection;
  const indexes = await collection.indexes();
  const currentIndex = indexes.find((index) => index.name === 'phonePrimary_1');

  if (!currentIndex) {
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
    console.log('Created phonePrimary_1 as a partial unique index.');
    return;
  }

  const alreadyCompatible =
    currentIndex.unique === true &&
    currentIndex.partialFilterExpression &&
    currentIndex.partialFilterExpression.phonePrimary &&
    currentIndex.partialFilterExpression.phonePrimary.$type === 'string' &&
    currentIndex.partialFilterExpression.phonePrimary.$gt === '';

  if (alreadyCompatible) {
    console.log('phonePrimary_1 is already using the expected partial unique index.');
    return;
  }

  const duplicatePhones = await User.aggregate([
    { $match: { phonePrimary: { $exists: true, $nin: [null, ''] } } },
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

  if (duplicatePhones.length > 0) {
    throw new Error(
      `Cannot rebuild phonePrimary_1 because duplicate non-empty phone numbers already exist: ${JSON.stringify(duplicatePhones)}`
    );
  }

  await collection.dropIndex('phonePrimary_1');
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

  console.log('Rebuilt phonePrimary_1 as a partial unique index.');
}

main()
  .catch((error) => {
    console.error(`Phone index repair failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
