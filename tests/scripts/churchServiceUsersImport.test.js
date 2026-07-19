const { buildMissingIdentityPlan, deriveGender, deriveEducation, stablePersonKey } = require('../../scripts/churchServiceUsersImport/identityPlanner');
const { fatherPrefixEvidence, matchFamily, validateManualFamilyMappings } = require('../../scripts/churchServiceUsersImport/familyMatcher');
const { buildUsersImportPlan } = require('../../scripts/churchServiceUsersImport/planner');
const { highConfidenceFamilyRows } = require('../../scripts/churchServiceUsersImport/reports');
const { calculatePlanChecksum, assertApplyPreconditions } = require('../../scripts/churchServiceImport/integrity');
const {
  validateUserPayload,
  parseArgs,
  selectSafeUserIdentities,
  assertGlobalExecutionPreconditions,
  assertValidApplyActor,
  revalidateIdentity,
  revalidateApprovedIdentities,
  processUsersOnlyRecords,
} = require('../../scripts/importChurchServiceUsers');
const { parseCsv } = require('../../scripts/churchServiceUsersImport/manualMappings');
const userService = require('../../src/modules/users/user.service');

const user = (id, fullName, extra = {}) => ({ _id: id.padStart(24, '0'), fullName, isDeleted: false, ...extra });
const row = (overrides = {}) => ({
  rowNumber: 2, sector: 'قطاع', meeting: 'ابتدائي 1', grade: 'الاول', group: 'فصل 1',
  servants: [], member: 'طفل عماد يونان', declaredServants: '0', declaredMembers: '1', ...overrides,
});

function identities(rows, activeUsers = [], allUsers = activeUsers) {
  return buildMissingIdentityPlan({ rows, activeUsers, allUsers, batchId: 'batch', workbookName: 'source.xlsx' });
}

describe('missing identity clustering and evidence', () => {
  test('combines repeated occurrences into one missing identity', () => {
    const result = identities([row(), row({ rowNumber: 3 })]);
    expect(result.identities).toHaveLength(1);
    expect(result.identities[0].rowNumbers).toEqual([2, 3]);
  });

  test('combines servant and member occurrences under the same normalized name', () => {
    const result = identities([row({ meeting: 'شباب', servants: ['مينا فايز عادل'], member: 'مينا فايز عادل' })]);
    expect(result.identities[0].roles).toEqual(['member', 'servant']);
  });

  test('combines harmless source spelling variants and preserves all spellings', () => {
    const result = identities([row({ member: 'أحمد مجدى' }), row({ rowNumber: 3, member: 'احمد مجدي' })]);
    expect(result.identities).toHaveLength(1);
    expect(result.identities[0].originalSpellings).toHaveLength(2);
    expect(result.identities[0].canonicalFullName).toBe('أحمد مجدى');
  });

  test('marks child/adult contexts as a potential homonym', () => {
    const result = identities([row({ member: 'مينا عادل حنا' }), row({ rowNumber: 3, meeting: 'الرجال', grade: '', group: 'منطقة', member: 'مينا عادل حنا' })]);
    expect(result.identities[0].operation).toBe('POTENTIAL_HOMONYM');
  });

  test('blocks contradictory gender-specific member contexts', () => {
    const result = identities([row({ meeting: 'شابات', member: 'اسم متكرر كامل' }), row({ rowNumber: 3, meeting: 'شباب', member: 'اسم متكرر كامل' })]);
    expect(result.identities[0].gender).toBeNull();
    expect(result.identities[0].blockers.join(' ')).toMatch(/Gender|gender/);
  });

  test('derives gender only from explicit member meetings', () => {
    expect(deriveGender([{ role: 'member', meeting: 'اعدادي بنات' }])).toMatchObject({ gender: 'female', conflict: false });
    expect(deriveGender([{ role: 'member', meeting: 'اعدادي بنين' }])).toMatchObject({ gender: 'male', conflict: false });
  });

  test('does not infer gender for servants', () => {
    expect(deriveGender([{ role: 'servant', meeting: 'اعدادي بنات' }]).gender).toBe('');
  });

  test('maps exact education meeting and grade values', () => {
    expect(deriveEducation([{ role: 'member', meeting: 'ابتدائي 1', grade: 'الثالث' }]).education).toEqual({ stage: 'primary_grade_3' });
    expect(deriveEducation([{ role: 'member', meeting: 'حضانة', grade: 'KG2' }]).education).toEqual({ stage: 'kindergarten_kg2' });
  });

  test('never invents birth date, national ID, contact, or credentials', () => {
    const planned = identities([row()]).identities[0].plannedUser;
    expect(planned).toMatchObject({ hasLogin: false, accountStatus: 'approved', role: 'USER' });
    for (const field of ['birthDate', 'ageGroup', 'nationalId', 'phonePrimary', 'whatsappNumber', 'email', 'password', 'passwordHash']) expect(planned).not.toHaveProperty(field);
  });

  test('stable import source keys are deterministic', () => {
    expect(stablePersonKey('احمد مجدي')).toBe(stablePersonKey('احمد مجدي'));
    expect(stablePersonKey('احمد مجدي')).not.toBe(stablePersonKey('احمد سمير'));
  });

  test('existing exact user is not proposed for creation', () => {
    const existing = user('1', 'طفل عماد يونان');
    const result = identities([row()], [existing], [existing]);
    expect(result.identities).toHaveLength(0);
    expect(result.classifications[0].classification).toBe('REUSE_EXISTING');
  });
});

describe('family matching', () => {
  const identity = { canonicalFullName: 'مايكل عماد يونان', meetings: ['ابتدائي 2'] };

  test('matches father using consecutive patronymic prefix tokens', () => {
    expect(fatherPrefixEvidence('مايكل عماد يونان', 'عماد يونان اسكاروس')).toMatchObject({ matches: true, tokens: ['عماد', 'يونان'], count: 2 });
  });

  test('plans one high-confidence father candidate', () => {
    const father = user('1', 'عماد يونان اسكاروس', { gender: 'male', houseName: 'بيت يونان' });
    expect(matchFamily(identity, [father])).toMatchObject({ confidence: 'HIGH_CONFIDENCE_AUTO_LINK', father: { id: father._id }, plannedAction: 'PROPOSE_LINK_FATHER', manualApprovalRequired: true });
  });

  test('reports ambiguous father candidates', () => {
    const candidates = [user('1', 'عماد يونان اسكاروس', { gender: 'male', houseName: 'بيت أ' }), user('2', 'عماد يونان جرجس', { gender: 'male', houseName: 'بيت ب' })];
    expect(matchFamily(identity, candidates).confidence).toBe('AMBIGUOUS_FAMILY');
  });

  test('does not infer mother from surname similarity', () => {
    const father = user('1', 'عماد يونان اسكاروس', { gender: 'male', houseName: 'بيت يونان' });
    const surnameOnlyWoman = user('2', 'مريم يونان اسكاروس', { gender: 'female', houseName: 'بيت يونان' });
    expect(matchFamily(identity, [father, surnameOnlyWoman]).mother).toBeNull();
  });

  test('resolves mother only through uniquely matched father spouse household', () => {
    const mother = user('2', 'مريم جرجس كامل', { gender: 'female', houseName: 'بيت يونان' });
    const father = user('1', 'عماد يونان اسكاروس', { gender: 'male', houseName: 'بيت يونان', spouse: { userId: mother._id } });
    expect(matchFamily(identity, [father, mother])).toMatchObject({ confidence: 'HIGH_CONFIDENCE_AUTO_LINK', mother: { id: mother._id }, plannedAction: 'PROPOSE_LINK_FATHER_AND_MOTHER', manualApprovalRequired: true });
  });

  test('reports incompatible existing candidate as family conflict', () => {
    const candidate = user('1', 'عماد يونان اسكاروس', { gender: 'female' });
    expect(matchFamily(identity, [candidate]).confidence).toBe('FAMILY_CONFLICT');
  });
});

describe('manual family mapping validation', () => {
  const plannedIdentity = { stablePersonKey: 'person-1', blockers: [] };
  const father = user('1', 'أب مرشح كامل', { gender: 'male' });
  const mother = user('2', 'أم مرشحة كاملة', { gender: 'female' });

  test('accepts compatible existing approved IDs', () => {
    const result = validateManualFamilyMappings([{ stablePersonKey: 'person-1', decision: 'APPROVE', approvedFatherId: father._id, approvedMotherId: mother._id }], [plannedIdentity], [father, mother]);
    expect(result.errors).toEqual([]);
    expect(result.approved).toHaveLength(1);
  });

  test('rejects unknown and gender-incompatible approved IDs', () => {
    const result = validateManualFamilyMappings([{ stablePersonKey: 'person-1', decision: 'APPROVE', approvedFatherId: mother._id, approvedMotherId: 'f'.repeat(24) }], [plannedIdentity], [father, mother]);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  test('parses editable quoted CSV mapping fields', () => {
    const parsed = parseCsv('\uFEFFStable person key,decision,notes\r\nperson-1,APPROVE,"reviewed, manually"\r\n');
    expect(parsed).toEqual([{ 'Stable person key': 'person-1', decision: 'APPROVE', notes: 'reviewed, manually' }]);
  });
});

describe('apply rechecks and integrity safeguards', () => {
  function safePlan() {
    const plan = buildUsersImportPlan({ parsed: { rows: [row()], sheetName: 'Sheet2' }, activeUsers: [], allUsers: [], databaseName: 'test', inputPath: 'source.xlsx', inputHash: 'hash', generatedAt: '2026-01-01T00:00:00.000Z', validateUserPayload: () => [] });
    plan.safeToApply = true;
    plan.blockers = [];
    plan.blockingErrors = [];
    plan.planChecksum = calculatePlanChecksum(plan);
    return plan;
  }

  test('idempotent rerun finds an already imported source key', () => {
    const plan = safePlan();
    const identity = plan.identities[0];
    const existing = user('1', identity.canonicalFullName, { customDetails: { importSourceKey: identity.importSourceKey } });
    expect(revalidateApprovedIdentities(plan, [existing])[0]).toMatchObject({ action: 'NO_OP_ALREADY_IMPORTED', existingUserId: existing._id });
  });

  test('blocks an import source key claimed by a different name', () => {
    const plan = safePlan();
    const identity = plan.identities[0];
    const existing = user('1', '\u0634\u062e\u0635 \u0622\u062e\u0631 \u0645\u062e\u062a\u0644\u0641', { customDetails: { importSourceKey: identity.importSourceKey } });
    expect(revalidateIdentity(identity, [existing]).status).toBe('BLOCKED');
  });

  test('reuses a newly appeared unique existing name instead of creating', () => {
    const plan = safePlan();
    const existing = user('1', plan.identities[0].canonicalFullName);
    expect(revalidateApprovedIdentities(plan, [existing])[0].action).toBe('REUSE_EXISTING');
  });

  test('new ambiguity skips only that identity', () => {
    const plan = safePlan();
    const duplicateA = user('1', plan.identities[0].canonicalFullName);
    const duplicateB = user('2', plan.identities[0].canonicalFullName);
    expect(revalidateIdentity(plan.identities[0], [duplicateA, duplicateB]).status).toBe('SKIPPED_NEW_AMBIGUITY');
  });

  test('blocks checksum mismatch', () => {
    const plan = safePlan();
    expect(() => assertApplyPreconditions({ plan, suppliedChecksum: 'wrong', currentInputHash: 'hash', currentDatabaseName: 'test' })).toThrow(/checksum/);
  });

  test('plan checksum is stable across JSON serialization of date evidence', () => {
    const plan = safePlan();
    plan.evidenceDate = new Date('2000-01-01T00:00:00.000Z');
    plan.planChecksum = calculatePlanChecksum(plan);
    const roundTripped = JSON.parse(JSON.stringify(plan));
    expect(calculatePlanChecksum(roundTripped)).toBe(plan.planChecksum);
  });

  test('blocks Excel hash mismatch', () => {
    const plan = safePlan();
    expect(() => assertApplyPreconditions({ plan, suppliedChecksum: plan.planChecksum, currentInputHash: 'changed', currentDatabaseName: 'test' })).toThrow(/workbook checksum mismatch/);
  });

  test('blocks database target mismatch', () => {
    const plan = safePlan();
    expect(() => assertApplyPreconditions({ plan, suppliedChecksum: plan.planChecksum, currentInputHash: 'hash', currentDatabaseName: 'other' })).toThrow(/Database target mismatch/);
  });

  test('record blockers do not become global execution errors', () => {
    const plan = safePlan();
    plan.recordBlockers = [{ type: 'POTENTIAL_HOMONYM' }];
    plan.blockers = plan.recordBlockers;
    plan.planChecksum = calculatePlanChecksum(plan);
    expect(() => assertGlobalExecutionPreconditions({ plan, suppliedChecksum: plan.planChecksum, currentInputHash: 'hash', currentDatabaseName: 'test' })).not.toThrow();
  });

  test('global checksum mismatch blocks the full users-only run', () => {
    const plan = safePlan();
    expect(() => assertGlobalExecutionPreconditions({ plan, suppliedChecksum: 'wrong', currentInputHash: 'hash', currentDatabaseName: 'test' })).toThrow(/checksum/);
  });

  test('global database mismatch blocks the full users-only run', () => {
    const plan = safePlan();
    expect(() => assertGlobalExecutionPreconditions({ plan, suppliedChecksum: plan.planChecksum, currentInputHash: 'hash', currentDatabaseName: 'other' })).toThrow(/Database target mismatch/);
  });

  test('invalid actor blocks the full users-only run', () => {
    expect(() => assertValidApplyActor({ role: 'ADMIN', accountStatus: 'approved', isLocked: false })).toThrow(/SUPER_ADMIN/);
    expect(() => assertValidApplyActor({ role: 'SUPER_ADMIN', accountStatus: 'approved', isLocked: false, isDeleted: false })).not.toThrow();
  });

  test('combined apply flag is disabled and phases require explicit flags', () => {
    expect(() => parseArgs(['--apply'])).toThrow(/combined --apply mode is disabled/);
    expect(parseArgs([]).mode).toBe('dry-run');
    expect(parseArgs(['--apply-users-only', '--plan-file=plan.json', '--confirm=abc', `--actor-user-id=${'a'.repeat(24)}`]).mode).toBe('apply-users-only');
    expect(parseArgs(['--apply-families-only', '--plan-file=plan.json', '--confirm=abc', `--actor-user-id=${'a'.repeat(24)}`]).mode).toBe('apply-families-only');
  });

  test('domain import service rejects credentials before database access', async () => {
    await expect(userService.createImportedUser({ fullName: 'اسم كامل', hasLogin: true, password: 'Fake123!' }, '0'.repeat(24))).rejects.toMatchObject({ errorCode: 'IMPORT_CREDENTIALS_FORBIDDEN' });
  });
});

describe('record-scoped users-only execution', () => {
  const SAFE_NAME = '\u0634\u062e\u0635 \u0622\u0645\u0646 \u0643\u0627\u0645\u0644';
  const REPEATED_NAME = '\u0627\u0633\u0645 \u0645\u062a\u0643\u0631\u0631 \u0643\u0627\u0645\u0644';
  const EXISTING_NAME = '\u0627\u0633\u0645 \u0645\u0648\u062c\u0648\u062f \u0643\u0627\u0645\u0644';
  function buildPlan(rows, activeUsers = []) {
    const plan = buildUsersImportPlan({ parsed: { rows, sheetName: 'Sheet2' }, activeUsers, allUsers: activeUsers, databaseName: 'test', inputPath: 'source.xlsx', inputHash: 'hash', generatedAt: '2026-01-01T00:00:00.000Z', validateUserPayload: () => [] });
    plan.planChecksum = calculatePlanChecksum(plan);
    return plan;
  }

  test('one blocked identity does not block an unrelated safe identity', () => {
    const rows = [
      row({ member: SAFE_NAME }),
      row({ rowNumber: 3, member: REPEATED_NAME, meeting: '\u0634\u0628\u0627\u0628', group: '\u0643\u0628\u0627\u0631' }),
      row({ rowNumber: 4, member: REPEATED_NAME, meeting: '\u0627\u0628\u062a\u062f\u0627\u0626\u064a 1', group: '\u0623\u0637\u0641\u0627\u0644' }),
    ];
    const plan = buildPlan(rows);
    expect(selectSafeUserIdentities(plan)).toHaveLength(1);
    expect(plan.identities.some((identity) => identity.operation === 'POTENTIAL_HOMONYM')).toBe(true);
    expect(plan.globalExecutionErrors).toEqual([]);
  });

  test('family audit contains only safe proposed high-confidence identities and leaves approval empty', () => {
    const safe = { operation: 'CREATE', stablePersonKey: 'safe', canonicalFullName: 'Safe', meetings: [], groups: [], family: { confidence: 'HIGH_CONFIDENCE_AUTO_LINK', father: { id: '1', name: 'Father' }, mother: null, household: null, candidates: [], evidence: [], conflicts: [] } };
    const blocked = { ...safe, operation: 'POTENTIAL_HOMONYM', stablePersonKey: 'blocked' };
    const rows = highConfidenceFamilyRows({ identities: [safe, blocked] });
    expect(rows).toHaveLength(1);
    expect(rows[0]['New user stable key']).toBe('safe');
    expect(rows[0]['Manual approval']).toBe('');
  });

  test('potential homonyms, existing ambiguity, and invalid one-character names are excluded', () => {
    const ambiguousUsers = [user('1', EXISTING_NAME), user('2', EXISTING_NAME)];
    const plan = buildPlan([
      row({ member: REPEATED_NAME, meeting: '\u0634\u0628\u0627\u0628', group: '\u0643\u0628\u0627\u0631' }),
      row({ rowNumber: 3, member: REPEATED_NAME, meeting: '\u0627\u0628\u062a\u062f\u0627\u0626\u064a 1', group: '\u0623\u0637\u0641\u0627\u0644' }),
      row({ rowNumber: 4, member: EXISTING_NAME }),
      row({ rowNumber: 5, member: '\u0627' }),
    ], ambiguousUsers);
    expect(selectSafeUserIdentities(plan)).toHaveLength(0);
    expect(plan.sourceClassifications.some((entry) => entry.classification === 'EXISTING_AMBIGUOUS')).toBe(true);
    expect(plan.identities.some((identity) => identity.classification === 'INVALID_SOURCE_NAME')).toBe(true);
  });

  test('users-only processor creates safe users and never invokes family or meeting services', async () => {
    const plan = buildPlan([row({ member: SAFE_NAME })]);
    const createUser = jest.fn().mockResolvedValue({ id: 'a'.repeat(24) });
    const familySpy = jest.spyOn(userService, 'linkImportedParentChild');
    const records = await processUsersOnlyRecords({
      plan,
      actorUserId: 'b'.repeat(24),
      loadUsers: jest.fn().mockResolvedValue([]),
      createUser,
      runInTransaction: (work) => work(null),
    });
    expect(records.filter((record) => record.status === 'CREATED')).toHaveLength(1);
    expect(createUser).toHaveBeenCalledTimes(1);
    const payload = createUser.mock.calls[0][0];
    expect(payload).toMatchObject({ hasLogin: false, accountStatus: 'approved', role: 'USER' });
    for (const field of ['father', 'mother', 'spouse', 'familyMembers', 'familyName', 'houseName', 'meeting', 'group', 'meetings', 'groups']) expect(payload).not.toHaveProperty(field);
    expect(familySpy).not.toHaveBeenCalled();
    familySpy.mockRestore();
  });

  test('unknown gender and education pass the real schema validation', () => {
    const plan = buildPlan([row({ meeting: '\u062c\u0627\u0645\u0639\u064a\u064a\u0646', grade: '', member: '\u0634\u062e\u0635 \u0628\u0644\u0627 \u0628\u064a\u0627\u0646\u0627\u062a' })]);
    const payload = selectSafeUserIdentities(plan)[0].plannedUser;
    expect(payload).not.toHaveProperty('gender');
    expect(payload).not.toHaveProperty('education');
    expect(validateUserPayload(payload)).toEqual([]);
  });

  test('rerun is idempotent through import source key revalidation', async () => {
    const plan = buildPlan([row({ member: SAFE_NAME })]);
    const identity = selectSafeUserIdentities(plan)[0];
    const existing = user('1', identity.canonicalFullName, { customDetails: { importSourceKey: identity.importSourceKey } });
    const createUser = jest.fn();
    const records = await processUsersOnlyRecords({ plan, actorUserId: 'b'.repeat(24), loadUsers: async () => [existing], createUser, runInTransaction: (work) => work(null) });
    expect(records.some((record) => record.status === 'SKIPPED_ALREADY_IMPORTED')).toBe(true);
    expect(createUser).not.toHaveBeenCalled();
  });
});
