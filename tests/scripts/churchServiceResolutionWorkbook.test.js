const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const { calculatePlanChecksum, sha256File } = require('../../scripts/churchServiceImport/integrity');
const { assertResolutionApplyPreconditions } = require('../../scripts/churchServiceImport/integrity');
const { generateResolutionWorkbook } = require('../../scripts/churchServiceResolution/workbookGenerator');
const { parseAndValidateResolutionWorkbook, parseSplitDefinition } = require('../../scripts/churchServiceResolution/workbookValidator');
const { generatedFieldsHash, SHEETS } = require('../../scripts/churchServiceResolution/workbookSchema');
const { buildOccurrenceResolutions, buildResolutionAwarePlan } = require('../../scripts/churchServiceResolution/resolutionPlanner');

const U1 = '100000000000000000000001';
const U2 = '100000000000000000000002';
const M1 = '200000000000000000000001';

function rowsFixture() {
  return [
    { rowNumber: 2, sector: 'قطاع', meeting: 'اجتماع', grade: 'الأول', group: 'فصل أ', servants: ['خادم مختلف'], member: 'شخص ملتبس' },
    { rowNumber: 3, sector: 'قطاع', meeting: 'اجتماع', grade: 'الأول', group: 'فصل ب', servants: ['خادم آخر'], member: 'شخص ملتبس' },
  ];
}

function dataFixture() {
  return {
    identityRows: [{ identityKey: 'identity-1', normalizedName: 'شخص ملتبس', sourceSpellings: 'شخص ملتبس', roles: 'member', meetings: 'اجتماع', groups: 'فصل أ | فصل ب', grades: 'الأول', excelRows: '2 | 3', currentStatus: 'AMBIGUOUS', candidateCount: 2, candidateUserIds: `${U1} | ${U2}`, candidateUserNames: 'مرشح 1 | مرشح 2', candidateSummary: '', recommendedDecision: 'MAP_EXISTING_USER', recommendationReason: '', confidence: 'MANUAL_REVIEW', manualDecision: '', approvedUserId: '', correctedCanonicalName: '', splitDefinition: '', notes: '', validationStatus: '', validationMessage: '' }],
    candidateRows: [{ identityKey: 'identity-1', sourceName: 'شخص ملتبس', normalizedName: 'شخص ملتبس', candidateUserId: U1, candidateFullName: 'مرشح 1', candidateGender: '', candidateBirthDate: '', candidateAgeGroup: '', candidateEducation: '{}', candidateFamilyName: '', candidateHouseName: '', candidateMeetings: '', candidateGroups: '{}', candidateImportSource: '{}', candidateIsDeleted: false, candidateHasLogin: false, matchReason: 'exact ambiguity', conflictingEvidence: '', supportingEvidence: '' }],
    groupRows: [{ conflictKey: 'group-1', userId: U1, userFullName: 'مرشح 1', meetingId: M1, meetingName: 'اجتماع', sourceGroups: 'فصل أ | فصل ب', sourceRowsByGroup: '{"فصل أ":[2],"فصل ب":[3]}', existingMeetingMembership: 'NO', existingGroupMembership: '', domainAllowsMultipleGroups: 'NO', recommendedDecision: 'KEEP_ONE_GROUP', recommendationReason: '', manualDecision: '', approvedGroupName: '', notes: '', validationStatus: '', validationMessage: '' }],
    servantRows: [{ conflictKey: 'servant-1', sector: 'قطاع', meeting: 'اجتماع', grade: 'الأول', groupName: 'فصل أ', candidateServantSets: 'SET_1: خادم مختلف\nSET_2: خادم آخر', candidateServantIds: `SET_1: ${U1}\nSET_2: ${U2}`, sourceRowsBySet: '{"SET_1":[2],"SET_2":[3]}', resolvedSameUsers: 'NO', recommendedDecision: '', recommendationReason: '', manualDecision: '', approvedServantUserIds: '', approvedSourceSet: '', notes: '', validationStatus: '', validationMessage: '' }],
    aliasRows: [{ aliasKey: 'alias-1', sector: 'قطاع', meetingId: M1, meetingName: 'اجتماع', firstGroupName: 'فصل أ', secondGroupName: 'فصل ب', firstGroupExisting: 'YES', secondGroupExisting: 'YES', affectedPeopleCount: 1, affectedUserIds: U1, firstGroupRows: '2', secondGroupRows: '3', normalizedSimilarity: '50%', sharedAddressTokens: 'فصل', existingDatabaseEvidence: 'فصل أ | فصل ب', recommendedDecision: 'DIFFERENT_GROUPS', recommendationReason: '', manualDecision: '', canonicalGroupName: '', notes: '', validationStatus: '', validationMessage: '' }],
    duplicateRows: [{ duplicateReviewKey: 'duplicate-1', identityKey: 'identity-1', sourceName: 'شخص ملتبس', meeting: 'اجتماع', group: 'فصل أ', candidateUserIds: `${U1} | ${U2}`, candidateNames: 'مرشح 1 | مرشح 2', sameNormalizedName: 'YES', sameGender: 'YES', sameBirthDate: 'YES', sameNationalId: 'UNKNOWN', samePhone: 'UNKNOWN', sameFamilyName: 'YES', sameHouseName: 'YES', sameParents: 'UNKNOWN', sameImportSource: 'YES', candidateDataCompleteness: `${U1}:5 | ${U2}:4`, candidateLoginStatus: `${U1}:NO_LOGIN | ${U2}:NO_LOGIN`, candidateRelationshipCounts: `${U1}:0 | ${U2}:0`, candidateMeetingCounts: `${U1}:0/0 | ${U2}:0/0`, candidateActivityCounts: `${U1}:0 | ${U2}:0`, classification: 'LIKELY_DUPLICATE_DATABASE_RECORDS', recommendedCanonicalUserId: U1, recommendationReason: '', manualDecision: '', approvedCanonicalUserId: '', notes: '', validationStatus: '', validationMessage: '' }],
  };
}

describe('manual resolution workbook', () => {
  let dir; let workbookPath; let sourcePlanPath; let data;
  const users = [{ _id: U1, fullName: 'مرشح 1', role: 'USER', isDeleted: false }, { _id: U2, fullName: 'مرشح 2', role: 'USER', isDeleted: true }];
  const meetings = [{ _id: M1, name: 'اجتماع', groups: ['فصل أ', 'فصل ب'], groupAssignments: [], servants: [], servedUserIds: [] }];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'church-resolution-'));
    workbookPath = path.join(dir, 'review.xlsx');
    sourcePlanPath = path.join(dir, 'resolution-plan.json');
    const plan = { input: { sha256: 'excel-hash' }, safeToApply: false, blockingErrors: [{}], planChecksum: null };
    plan.planChecksum = calculatePlanChecksum(plan);
    fs.writeFileSync(sourcePlanPath, JSON.stringify(plan));
    data = dataFixture();
    await generateResolutionWorkbook({ data, metadata: { generatedAt: '2026-07-19T00:00:00.000Z', sourceResolutionPlanPath: sourcePlanPath, sourceResolutionPlanChecksum: plan.planChecksum, sourceAssignmentPlanPath: sourcePlanPath, sourceAssignmentPlanChecksum: plan.planChecksum, sourceExcelHash: 'excel-hash', databaseName: 'test', databaseFingerprint: 'db-fingerprint' }, outputPath: workbookPath });
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  async function edit(sheetName, updates, extraRow = null) {
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(workbookPath);
    const sheet = workbook.getWorksheet(sheetName);
    for (const [columnName, value] of Object.entries(updates)) {
      const column = sheet.getRow(1).values.findIndex((entry) => entry === columnName);
      sheet.getCell(2, column).value = value;
    }
    if (extraRow) sheet.addRow(extraRow);
    await workbook.xlsx.writeFile(workbookPath);
  }

  function validate(overrides = {}) {
    return parseAndValidateResolutionWorkbook({ workbookPath, expectedSourceExcelHash: 'excel-hash', expectedDatabaseFingerprint: 'db-fingerprint', users, meetings, parsedRows: rowsFixture(), expectedData: data, ...overrides });
  }

  test('generates the required workbook structure and integrity hash', async () => {
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(workbookPath);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(SHEETS);
    expect(generatedFieldsHash(data)).toMatch(/^[a-f0-9]{64}$/);
  });

  test('blank decisions are valid but unresolved', async () => {
    const result = await validate();
    expect(result).toMatchObject({ structurallyValid: true, complete: false, completedDecisions: 0, unresolvedDecisions: 5 });
  });

  test('validates an existing-user mapping', async () => {
    await edit('Identity Review', { manualDecision: 'MAP_EXISTING_USER', approvedUserId: U1 });
    expect((await validate()).decisions.identities[0]).toMatchObject({ approvedUserId: U1 });
  });

  test('rejects invalid, deleted, and outside-candidate IDs without override', async () => {
    await edit('Identity Review', { manualDecision: 'MAP_EXISTING_USER', approvedUserId: '999999999999999999999999' });
    expect((await validate()).errors.join(' ')).toMatch(/does not exist/);
    await edit('Identity Review', { approvedUserId: U2 });
    expect((await validate()).errors.join(' ')).toMatch(/deleted/);
    users.push({ _id: '100000000000000000000099', fullName: 'خارجي', role: 'USER', isDeleted: false });
    await edit('Identity Review', { approvedUserId: '100000000000000000000099' });
    expect((await validate()).errors.join(' ')).toMatch(/outside the candidate set/);
  });

  test('accepts an outside candidate only with explicit documented override', async () => {
    const outside = '100000000000000000000099'; users.push({ _id: outside, fullName: 'خارجي', role: 'USER', isDeleted: false });
    await edit('Identity Review', { manualDecision: 'MAP_EXISTING_USER', approvedUserId: outside, notes: 'OVERRIDE: verified parish record 42' });
    expect((await validate()).structurallyValid).toBe(true);
  });

  test('validates deterministic identity splitting by rows and meeting/group selectors', () => {
    expect(parseSplitDefinition('{"parts":[{"identityKey":"a","rows":[2]},{"identityKey":"b","rows":[3]}]}', [2, 3], rowsFixture())).toHaveLength(2);
    expect(parseSplitDefinition('{"parts":[{"identityKey":"a","group":"فصل أ"},{"identityKey":"b","group":"فصل ب"}]}', [2, 3], rowsFixture())).toHaveLength(2);
  });

  test('rejects incomplete split definitions', async () => {
    await edit('Identity Review', { manualDecision: 'SPLIT_SOURCE_IDENTITY', splitDefinition: '{"parts":[{"identityKey":"a","rows":[2]},{"identityKey":"b","rows":[4]}]}' });
    expect((await validate()).errors.join(' ')).toMatch(/unrelated row|missing rows/);
  });

  test('validates corrected name and invalid-source skip requirements', async () => {
    await edit('Identity Review', { manualDecision: 'CORRECT_SOURCE_NAME', correctedCanonicalName: 'اسم مصحح' });
    expect((await validate()).errors).toHaveLength(0);
    await edit('Identity Review', { manualDecision: 'SKIP_INVALID_SOURCE', correctedCanonicalName: '' });
    expect((await validate()).errors.join(' ')).toMatch(/only for invalid/);
  });

  test('validates one-group selection and rejects multiple groups by domain', async () => {
    await edit('Group Conflicts', { manualDecision: 'KEEP_ONE_GROUP', approvedGroupName: 'فصل أ' });
    expect((await validate()).errors).toHaveLength(0);
    await edit('Group Conflicts', { manualDecision: 'ALLOW_BOTH_GROUPS', approvedGroupName: '' });
    expect((await validate()).errors.join(' ')).toMatch(/rejects multiple groups/);
  });

  test('keeping an existing group requires an existing relationship', async () => {
    await edit('Group Conflicts', { manualDecision: 'KEEP_EXISTING_GROUP' });
    expect((await validate()).errors.join(' ')).toMatch(/No existing group/);
  });

  test('validates servant source-set and manual-ID selection without removals', async () => {
    await edit('Servant Conflicts', { manualDecision: 'USE_SOURCE_SET', approvedSourceSet: 'SET_1' });
    let result = await validate();
    expect(result.decisions.servants[0].approvedServantUserIds).toEqual([U1]);
    await edit('Servant Conflicts', { manualDecision: 'USE_MANUAL_SERVANT_IDS', approvedSourceSet: '', approvedServantUserIds: U1 });
    result = await validate();
    expect(result.results.find((entry) => entry.resultType === 'SERVANT').message).toMatch(/will not be removed/);
  });

  test.each([
    ['source hash', { expectedSourceExcelHash: 'wrong' }, /Source Excel hash mismatch/],
    ['database fingerprint', { expectedDatabaseFingerprint: 'wrong' }, /Database target fingerprint mismatch/],
  ])('rejects %s mismatch', async (_label, overrides, pattern) => expect((await validate(overrides)).errors.join(' ')).toMatch(pattern));

  test('detects modified generated fields, unknown keys, and duplicate rows', async () => {
    await edit('Identity Review', { identityKey: 'unknown-key' });
    let result = await validate();
    expect(result.errors.join(' ')).toMatch(/Unknown identity key|Generated workbook fields/);
    await generateResolutionWorkbook({ data, metadata: { generatedAt: '2026-07-19T00:00:00.000Z', sourceResolutionPlanPath: sourcePlanPath, sourceResolutionPlanChecksum: JSON.parse(fs.readFileSync(sourcePlanPath)).planChecksum, sourceAssignmentPlanPath: sourcePlanPath, sourceAssignmentPlanChecksum: '', sourceExcelHash: 'excel-hash', databaseName: 'test', databaseFingerprint: 'db-fingerprint' }, outputPath: workbookPath });
    const duplicate = Object.values(data.identityRows[0]);
    await edit('Identity Review', {}, duplicate);
    result = await validate();
    expect(result.errors.join(' ')).toMatch(/Duplicate identity key/);
  });

  test('writes validation results without changing generated-field integrity', async () => {
    let result = await validate({ writeResults: true });
    expect(result.structurallyValid).toBe(true);
    const written = new ExcelJS.Workbook(); await written.xlsx.readFile(workbookPath);
    expect(written.getWorksheet('Validation Results').rowCount).toBe(6);
    result = await validate();
    expect(result.structurallyValid).toBe(true);
    expect(sha256File(workbookPath)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('resolution-aware occurrence and operation planning', () => {
  const users = [{ _id: U1, fullName: 'اسم مصحح', role: 'USER', isDeleted: false }, { _id: U2, fullName: 'عضو آمن', role: 'USER', isDeleted: false }];

  test('rematches corrected names and leaves split missing parts for user review', () => {
    const rows = rowsFixture();
    const currentPlan = { peopleMatches: [{ original: 'شخص ملتبس', normalizedName: 'شخص ملتبس', status: 'MISSING', matchedId: '' }, { original: 'خادم مختلف', status: 'MISSING', matchedId: '' }, { original: 'خادم آخر', status: 'MISSING', matchedId: '' }] };
    const identityRows = [{ identityKey: 'identity-1', normalizedName: 'شخص ملتبس', sourceSpellings: 'شخص ملتبس' }];
    let result = buildOccurrenceResolutions({ rows, currentPlan, users, validation: { identityRows, decisions: { identities: [{ identityKey: 'identity-1', decision: 'CORRECT_SOURCE_NAME', correctedCanonicalName: 'اسم مصحح' }] } } });
    expect(result.resolveOccurrence('شخص ملتبس', 'member', rows[0]).userId).toBe(U1);
    result = buildOccurrenceResolutions({ rows, currentPlan, users, validation: { identityRows, decisions: { identities: [{ identityKey: 'identity-1', decision: 'SPLIT_SOURCE_IDENTITY', parts: [{ identityKey: 'a', rows: [2], canonicalName: 'اسم مصحح' }, { identityKey: 'b', rows: [3], canonicalName: 'شخص جديد' }] }] } } });
    expect(result.missingUserReviewPlan).toHaveLength(1);
  });

  test('keeps safe operations available while blank decisions block full apply', () => {
    const parsed = { rows: [{ rowNumber: 2, sector: 'قطاع', meeting: 'اجتماع', grade: '', group: 'فصل أ', servants: [], member: 'عضو آمن' }, { rowNumber: 3, sector: 'قطاع', meeting: 'اجتماع', grade: '', group: 'فصل أ', servants: [], member: 'شخص ملتبس' }] };
    const currentPlan = { input: { path: 'x', sha256: 'h' }, database: { name: 'test' }, planChecksum: 'p', warnings: [], peopleMatches: [{ original: 'عضو آمن', normalizedName: 'عضو امن', status: 'EXACT_MATCH', matchedId: U2, matchMethod: 'EXACT' }, { original: 'شخص ملتبس', normalizedName: 'شخص ملتبس', status: 'MISSING', matchedId: '' }], groups: [{ sourceKey: ['قطاع', 'اجتماع', '', 'فصل أ'].join('\u001f'), sector: 'قطاع', meeting: 'اجتماع', meetingId: M1, grade: '', originalGroupName: 'فصل أ', targetGroupName: 'فصل أ', groupAction: 'REUSE', operations: {} }] };
    const validation = { identityRows: [{ identityKey: 'identity-1', normalizedName: 'شخص ملتبس', sourceSpellings: 'شخص ملتبس' }], groupRows: [], servantRows: [], decisions: { identities: [], groups: [], servants: [] }, completedDecisions: 0, unresolvedDecisions: 1, errors: [], warnings: ['blank'], complete: false, metadata: { sourceResolutionPlanChecksum: 'r', generatedFieldsHash: 'g' } };
    const plan = buildResolutionAwarePlan({ parsed, currentPlan, validation, users, meetings: [{ _id: M1, name: 'اجتماع', groupAssignments: [], servants: [], servedUserIds: [] }], workbookPath: 'review.xlsx', workbookHash: 'w', databaseFingerprint: 'd', generatedAt: '2026-07-19T00:00:00.000Z' });
    expect(plan.safeOperationsAvailable).toBe(true);
    expect(plan.safeForFullApply).toBe(false);
    expect(plan.totals.safeMemberAssignments).toBe(1);
  });

  test('future apply rejects a modified workbook hash', () => {
    const plan = { resolutionWorkbook: { sha256: 'approved' }, databaseFingerprint: 'db', safeForFullApply: true, safeToApply: true };
    expect(() => assertResolutionApplyPreconditions({ plan, currentResolutionWorkbookHash: 'changed', currentDatabaseFingerprint: 'db' })).toThrow(/workbook checksum mismatch/);
  });
});

describe('workbook generator CLI guard', () => {
  const { execFileSync } = require('child_process');
  const generatorScript = path.resolve(__dirname, '../../scripts/generateChurchServiceResolutionWorkbook.js');

  test('requiring the module runs no CLI side effect and emits no ENOENT', () => {
    // Importing the generator must NOT fire main() — no Mongo connection, no
    // attempt to read a default plan.json. FORCE_COLOR=0 keeps output plain.
    const output = execFileSync(
      process.execPath,
      ['-e', `const m = require(${JSON.stringify(generatorScript)}); process.stdout.write(typeof m.parseArgs + ',' + typeof m.main);`],
      { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', FORCE_COLOR: '0', NO_COLOR: '1' } }
    );

    expect(output).toBe('function,function');
    expect(output).not.toMatch(/ENOENT/);
    expect(output).not.toMatch(/plan\.json/);
    expect(output).not.toMatch(/generation failed/);
  });

  test('exports parseArgs and main without invoking either', () => {
    // eslint-disable-next-line global-require
    const mod = require('../../scripts/generateChurchServiceResolutionWorkbook');
    expect(typeof mod.parseArgs).toBe('function');
    expect(typeof mod.main).toBe('function');
    // parseArgs still behaves as the CLI parser.
    expect(mod.parseArgs(['--ai-explain']).aiExplain).toBe(true);
    expect(() => mod.parseArgs(['--nope'])).toThrow(/Unknown argument/);
  });
});
