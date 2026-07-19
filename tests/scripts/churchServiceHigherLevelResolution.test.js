const { compareCandidateSet, buildGroupAliasAudit } = require('../../scripts/churchServiceResolution/higherLevelAudit');
const { validateAliasRows, validateDuplicateRows } = require('../../scripts/churchServiceResolution/workbookValidator');
const { buildResolutionAwarePlan } = require('../../scripts/churchServiceResolution/resolutionPlanner');
const { buildOccurrenceResolutions } = require('../../scripts/churchServiceResolution/resolutionPlanner');
const { stableKey } = require('../../scripts/churchServiceResolution/workbookSchema');
const { buildHigherLevelPlan } = require('../../scripts/churchServiceResolution/higherLevelReports');

const M1 = '200000000000000000000001';
const M2 = '200000000000000000000002';
const userId = (number) => `1000000000000000000000${String(number).padStart(2, '0')}`;
const state = () => ({ unresolved: 0, completed: 0, results: [], errors: [], warnings: [], aliasDecisions: new Map(), duplicateDecisions: new Map() });

function evidenceFor(users, scores = []) {
  return new Map(users.map((user, index) => [String(user._id), { userId: String(user._id), completeness: scores[index] || 5, meetingCount: index, groupCount: index, activityCount: index, relationships: index }]));
}

describe('duplicate database-user evidence', () => {
  test('same national ID is strong duplicate evidence', () => {
    const users = [{ _id: userId(1), fullName: 'مينا عادل حنا', gender: 'male', birthDate: '2000-01-01', nationalId: '123', familyName: 'حنا', houseName: 'عادل' }, { _id: userId(2), fullName: 'مينا عادل حنا', gender: 'male', birthDate: '2000-01-01', nationalId: '123', familyName: 'حنا', houseName: 'عادل' }];
    const result = compareCandidateSet(users, evidenceFor(users, [12, 5]), new Map([['123', 2]]));
    expect(result.classification).toBe('LIKELY_DUPLICATE_DATABASE_RECORDS');
    expect(String(result.canonical.user._id)).toBe(userId(1));
    expect(result.reason).toMatch(/same national ID/);
  });

  test('distinct birth dates reduce duplicate confidence to distinct people', () => {
    const users = [{ _id: userId(1), fullName: 'مينا عادل حنا', gender: 'male', birthDate: '2000-01-01' }, { _id: userId(2), fullName: 'مينا عادل حنا', gender: 'male', birthDate: '2010-01-01' }];
    expect(compareCandidateSet(users, evidenceFor(users), new Map()).classification).toBe('DISTINCT_PEOPLE');
  });

  test('canonical recommendation uses completeness rather than creation order', () => {
    const users = [{ _id: userId(1), fullName: 'مينا عادل حنا', gender: 'male', birthDate: '2000-01-01', familyName: 'حنا', houseName: 'عادل', customDetails: { importSourceWorkbook: 'A' } }, { _id: userId(2), fullName: 'مينا عادل حنا', gender: 'male', birthDate: '2000-01-01', familyName: 'حنا', houseName: 'عادل', customDetails: { importSourceWorkbook: 'A' } }];
    const result = compareCandidateSet(users, evidenceFor(users, [4, 15]), new Map());
    expect(String(result.canonical.user._id)).toBe(userId(2));
  });

  test('canonical mapping validates candidates and explicitly performs no merge', () => {
    const users = [{ _id: userId(1), fullName: 'أ', role: 'USER', isDeleted: false }, { _id: userId(2), fullName: 'ب', role: 'USER', isDeleted: false }];
    const review = { duplicateReviewKey: 'd1', identityKey: 'i1', candidateUserIds: `${userId(1)} | ${userId(2)}`, manualDecision: 'MAP_TO_CANONICAL_USER', approvedCanonicalUserId: userId(2) };
    const resultState = state(); validateDuplicateRows([review], { users }, resultState);
    expect(resultState.errors).toHaveLength(0);
    expect(resultState.duplicateDecisions.get('d1').approvedCanonicalUserId).toBe(userId(2));
    expect(resultState.results[0].message).toMatch(/no database records will be merged/);
  });

  test('approved duplicate canonical mapping is used only by planning', () => {
    const users = [{ _id: userId(1), fullName: 'اسم مكرر', role: 'USER', isDeleted: false }, { _id: userId(2), fullName: 'اسم مكرر', role: 'USER', isDeleted: false }];
    const before = JSON.stringify(users);
    const row = { rowNumber: 2, servants: [], member: 'اسم مكرر' };
    const result = buildOccurrenceResolutions({ rows: [row], currentPlan: { peopleMatches: [{ original: 'اسم مكرر', normalizedName: 'اسم مكرر', status: 'AMBIGUOUS', matchedId: '' }] }, users, validation: { identityRows: [], duplicateRows: [{ duplicateReviewKey: 'd1', sourceName: 'اسم مكرر' }], decisions: { identities: [], duplicates: [{ duplicateReviewKey: 'd1', decision: 'MAP_TO_CANONICAL_USER', approvedCanonicalUserId: userId(2) }] } } });
    expect(result.resolveOccurrence('اسم مكرر', 'member', row).userId).toBe(userId(2));
    expect(JSON.stringify(users)).toBe(before);
  });

  test('restructured decision total includes each review level exactly once', () => {
    const data = { aliasRows: Array(10).fill({}), duplicateRows: Array(29).fill({ classification: 'INSUFFICIENT_EVIDENCE' }), identityRows: Array(16).fill({ currentStatus: 'POTENTIAL_HOMONYM' }), groupRows: Array(48).fill({}), servantRows: Array(3).fill({}), candidateRows: [], duplicateDetailRows: [], duplicateCleanupRows: [] };
    const plan = buildHigherLevelPlan({ data, resolutionPlan: { input: {}, planChecksum: 'r' }, sourceAssignmentPlan: { planChecksum: 's' }, databaseName: 'test', databaseFingerprint: 'd', generatedAt: '2026-01-01T00:00:00.000Z' });
    expect(plan.totals.expectedManualDecisionsAfterRestructuring).toBe(106);
  });
});

describe('group alias validation and planning', () => {
  const meeting = { _id: M1, name: 'الحكماء', groups: ['الاسم أ', 'الاسم ب'], groupAssignments: [], servants: [], servedUserIds: [] };

  test('rejects invalid canonical names and alias cycles/conflicts', () => {
    let resultState = state();
    validateAliasRows([{ aliasKey: 'a1', meetingId: M1, firstGroupName: 'الاسم أ', secondGroupName: 'الاسم ب', manualDecision: 'SAME_GROUP_ALIAS', canonicalGroupName: 'اسم مجهول', notes: '' }], { meetings: [meeting] }, resultState);
    expect(resultState.errors.join(' ')).toMatch(/Canonical group/);
    resultState = state();
    validateAliasRows([
      { aliasKey: 'a1', meetingId: M1, firstGroupName: 'الاسم أ', secondGroupName: 'الاسم ب', manualDecision: 'SAME_GROUP_ALIAS', canonicalGroupName: 'الاسم أ', notes: '' },
      { aliasKey: 'a2', meetingId: M1, firstGroupName: 'الاسم ب', secondGroupName: 'الاسم ج', manualDecision: 'SAME_GROUP_ALIAS', canonicalGroupName: 'الاسم ج', notes: 'CORRECTED: verified map' },
    ], { meetings: [meeting] }, resultState);
    expect(resultState.errors.join(' ')).toMatch(/cycle\/conflict/);
  });

  test('same alias names in different meetings remain independent', () => {
    const resultState = state();
    validateAliasRows([
      { aliasKey: 'a1', meetingId: M1, firstGroupName: 'أ', secondGroupName: 'ب', manualDecision: 'SAME_GROUP_ALIAS', canonicalGroupName: 'أ', notes: '' },
      { aliasKey: 'a2', meetingId: M2, firstGroupName: 'أ', secondGroupName: 'ب', manualDecision: 'SAME_GROUP_ALIAS', canonicalGroupName: 'ب', notes: '' },
    ], { meetings: [{ _id: M1, groups: ['أ', 'ب'] }, { _id: M2, groups: ['أ', 'ب'] }] }, resultState);
    expect(resultState.errors).toHaveLength(0);
  });

  test('builds one high-impact alias row for 36 person conflicts', () => {
    const groupRows = Array.from({ length: 36 }, (_, index) => ({ userId: userId(index + 1), meetingId: M1, meetingName: 'الحكماء', sourceGroups: 'عنوان أ | عنوان ب', sourceRowsByGroup: JSON.stringify({ 'عنوان أ': [index + 2], 'عنوان ب': [index + 100] }) }));
    const audit = buildGroupAliasAudit({ groupRows, sourceAssignmentPlan: { groups: [{ meetingId: M1, sector: 'قطاع' }] }, meetings: [{ _id: M1, groups: ['عنوان أ', 'عنوان ب'], groupAssignments: [], servants: [] }] });
    expect(audit).toHaveLength(1);
    expect(audit[0].affectedPeopleCount).toBe(36);
  });

  test('approved alias collapses 36 person conflicts to 36 deduplicated additions and leaves servant conflict unchanged', () => {
    const users = Array.from({ length: 36 }, (_, index) => ({ _id: userId(index + 1), fullName: `عضو ${index + 1}`, role: 'USER', isDeleted: false }));
    const parsedRows = users.flatMap((user, index) => [
      { rowNumber: index + 2, sector: 'قطاع', meeting: 'الحكماء', grade: '', group: 'عنوان أ', servants: [], member: user.fullName },
      { rowNumber: index + 102, sector: 'قطاع', meeting: 'الحكماء', grade: '', group: 'عنوان ب', servants: [], member: user.fullName },
    ]);
    const peopleMatches = users.map((user) => ({ original: user.fullName, normalizedName: user.fullName, status: 'EXACT_MATCH', matchedId: String(user._id), matchMethod: 'EXACT' }));
    const groups = ['عنوان أ', 'عنوان ب'].map((name) => ({ sourceKey: ['قطاع', 'الحكماء', '', name].join('\u001f'), sector: 'قطاع', meeting: 'الحكماء', meetingId: M1, grade: '', originalGroupName: name, targetGroupName: name, groupAction: 'REUSE', operations: {} }));
    const aliasKey = stableKey('church-service-group-alias', `${M1}\u001fعنوان أ\u001fعنوان ب`);
    const groupRows = users.map((user) => ({ conflictKey: stableKey('church-service-group-conflict', `${M1}\u001f${user._id}`), userId: String(user._id), meetingId: M1, sourceGroups: 'عنوان أ | عنوان ب' }));
    const validation = { identityRows: [], duplicateRows: [], aliasRows: [{ aliasKey, meetingId: M1, firstGroupName: 'عنوان أ', secondGroupName: 'عنوان ب' }], groupRows, servantRows: [{ conflictKey: 'servant-unresolved' }], decisions: { identities: [], duplicates: [], aliases: [{ aliasKey, decision: 'SAME_GROUP_ALIAS', meetingId: M1, firstGroupName: 'عنوان أ', secondGroupName: 'عنوان ب', canonicalGroupName: 'عنوان أ' }], groups: [], servants: [] }, completedDecisions: 1, unresolvedDecisions: 1, errors: [], warnings: [], complete: false, metadata: { sourceResolutionPlanChecksum: 'r', generatedFieldsHash: 'g' } };
    const plan = buildResolutionAwarePlan({ parsed: { rows: parsedRows }, currentPlan: { input: { path: 'x', sha256: 'h' }, database: { name: 'test' }, planChecksum: 'p', warnings: [], peopleMatches, groups }, validation, users, meetings: [{ _id: M1, name: 'الحكماء', groups: ['عنوان أ'], groupAssignments: [], servants: [], servedUserIds: [] }], workbookPath: 'w', workbookHash: 'h', databaseFingerprint: 'd', generatedAt: '2026-01-01T00:00:00.000Z' });
    expect(plan.totals.safeMemberAssignments).toBe(36);
    expect(plan.blockingErrors.filter((entry) => entry.type === 'UNRESOLVED_GROUP_DECISION')).toHaveLength(0);
    expect(plan.blockingErrors.some((entry) => entry.type === 'UNRESOLVED_SERVANT_DECISION')).toBe(true);
  });
});
