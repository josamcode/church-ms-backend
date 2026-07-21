/**
 * Integration: regex escaping against a real MongoDB query planner.
 *
 * The unit suite proves the escaped STRING is correct. This proves the escaped
 * string behaves correctly when MongoDB — not Node — compiles and evaluates it,
 * which is where the actual exposure lives.
 */

const mongoose = require('mongoose');
const { withMongo } = require('../helpers/mongo');
const { buildSafeRegexFilter } = require('../../src/utils/escapeRegex');

withMongo();

const memberSchema = new mongoose.Schema({
  fullName: String,
  houseName: String,
  day: String,
});

let Member;

beforeAll(() => {
  Member = mongoose.models.RegexTestMember
    || mongoose.model('RegexTestMember', memberSchema);
});

const SEED = [
  { fullName: 'Mina Adel', houseName: 'Adel', day: 'Sunday' },
  { fullName: 'Marina Samir', houseName: 'Samir', day: 'Monday' },
  { fullName: 'a.b literal', houseName: 'Dot', day: 'Tuesday' },
  { fullName: 'axb wildcard bait', houseName: 'Bait', day: 'Wednesday' },
  { fullName: '(a+)+$', houseName: 'Redos', day: 'Thursday' },
];

beforeEach(async () => {
  await Member.insertMany(SEED);
});

async function findNames(filter) {
  const docs = await Member.find(filter ? { fullName: filter } : {}).lean();
  return docs.map((d) => d.fullName).sort();
}

describe('escaped regex against a real server', () => {
  it('seeds the fixture collection', async () => {
    expect(await Member.countDocuments({})).toBe(5);
  });

  it('treats "." as a literal dot, not a wildcard', async () => {
    const names = await findNames(buildSafeRegexFilter('a.b'));
    expect(names).toEqual(['a.b literal']);
    // The unescaped form would also have matched this decoy.
    expect(names).not.toContain('axb wildcard bait');
  });

  it('does not let ".*" match every document', async () => {
    expect(await findNames(buildSafeRegexFilter('.*'))).toEqual([]);
  });

  it('matches a ReDoS payload as a literal string', async () => {
    expect(await findNames(buildSafeRegexFilter('(a+)+$'))).toEqual(['(a+)+$']);
  });

  it('treats "|" as a literal, so alternation cannot be injected', async () => {
    expect(await findNames(buildSafeRegexFilter('Mina|Marina'))).toEqual([]);
    expect(await findNames(buildSafeRegexFilter('Mina'))).toEqual(['Mina Adel']);
  });

  it('treats "^" as a literal rather than an anchor', async () => {
    expect(await findNames(buildSafeRegexFilter('^Mina'))).toEqual([]);
  });

  it('still performs ordinary substring search', async () => {
    expect(await findNames(buildSafeRegexFilter('samir'))).toEqual(['Marina Samir']);
  });

  it('does not throw on an unbalanced bracket', async () => {
    await expect(findNames(buildSafeRegexFilter('['))).resolves.toEqual([]);
  });
});

describe('exact anchoring against a real server', () => {
  it('matches the whole value only', async () => {
    const docs = await Member.find({ day: buildSafeRegexFilter('Sunday', { exact: true }) }).lean();
    expect(docs.map((d) => d.day)).toEqual(['Sunday']);
  });

  it('is case-insensitive as the original filter was', async () => {
    const docs = await Member.find({ day: buildSafeRegexFilter('sunday', { exact: true }) }).lean();
    expect(docs).toHaveLength(1);
  });

  // The regression this PR closes: `^${unescaped}$` let a `$|` payload close the
  // anchor and OR an empty alternative, matching every document in the
  // collection. Escaping first makes the payload match nothing.
  it('cannot be broken out of by an anchor-terminating payload', async () => {
    const docs = await Member.find({ day: buildSafeRegexFilter('$|', { exact: true }) }).lean();
    expect(docs).toEqual([]);
  });

  it('demonstrates the unescaped form really was exploitable', async () => {
    // Deliberately unescaped — this is the OLD behaviour, asserted so the
    // severity of the fix is documented rather than assumed.
    const exploited = await Member.find({
      day: { $regex: `^${'$|'}$`, $options: 'i' },
    }).lean();
    expect(exploited.length).toBe(5); // every document leaked
  });
});
