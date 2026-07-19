const { analyzeAmbiguous, analyzeAssignments, blockerBreakdown } = require('../../scripts/churchServiceResolution/analyzer');
const { validateIdentityMappings } = require('../../scripts/churchServiceResolution/identityMappings');

const U1 = '100000000000000000000001';
const U2 = '100000000000000000000002';
const U3 = '100000000000000000000003';
const M1 = '200000000000000000000001';

function person(overrides = {}) {
  return { original: 'مريم سمير حنا', normalizedName: 'مريم سمير حنا', role: 'member', rows: [2], status: 'AMBIGUOUS', matchMethod: 'EXACT', candidateCount: 2, candidates: [{ id: U1, name: 'مريم سمير حنا' }, { id: U2, name: 'مريم سمير حنا' }], ...overrides };
}

function row(overrides = {}) {
  return { rowNumber: 2, sector: 'قطاع', meeting: 'ثانوي بنات', grade: 'الاول', group: 'فصل أ', servants: [], member: 'مريم سمير حنا', ...overrides };
}

function group(overrides = {}) {
  return { sourceKey: ['قطاع', 'ثانوي بنات', 'الاول', 'فصل أ'].join('\u001f'), sector: 'قطاع', meeting: 'ثانوي بنات', meetingId: M1, grade: 'الاول', originalGroupName: 'فصل أ', targetGroupName: 'فصل أ', groupAction: 'REUSE', operations: { group: 'REUSE' }, blockers: [], ...overrides };
}

describe('manual church-service identity mapping validation', () => {
  const users = [{ _id: U1, fullName: 'مريم سمير حنا', role: 'USER', isDeleted: false }, { _id: U2, fullName: 'مريم سمير حنا', role: 'USER', isDeleted: true }];

  test('accepts a listed active ambiguity candidate', () => {
    const result = validateIdentityMappings([{ original: 'مريم سمير حنا', approvedUserId: U1, decision: 'APPROVE' }], [person()], users);
    expect(result.valid).toBe(true);
  });

  test('rejects deleted and nonexistent candidate IDs', () => {
    expect(validateIdentityMappings([{ original: 'مريم سمير حنا', approvedUserId: U2 }], [person()], users).errors[0]).toMatch(/deleted/);
    expect(validateIdentityMappings([{ original: 'مريم سمير حنا', approvedUserId: U3 }], [person()], users).errors[0]).toMatch(/does not exist/);
  });

  test('requires documentation when mapping a missing identity to an outside user', () => {
    const missing = person({ status: 'MISSING', candidates: [], candidateCount: 0 });
    expect(validateIdentityMappings([{ original: missing.original, approvedUserId: U1, decision: 'APPROVE' }], [missing], users).valid).toBe(false);
    expect(validateIdentityMappings([{ original: missing.original, approvedUserId: U1, decision: 'APPROVE_OUTSIDE_CANDIDATES', notes: 'Verified parish register' }], [missing], users).valid).toBe(true);
  });

  test('rejects unique-match override without explicit override metadata', () => {
    const exact = person({ status: 'EXACT_MATCH', matchedId: U1, candidates: [{ id: U1 }] });
    expect(validateIdentityMappings([{ original: exact.original, approvedUserId: U2 }], [exact], users).valid).toBe(false);
  });
});

describe('deterministic ambiguity evidence', () => {
  test('eliminates a gender-incompatible candidate', () => {
    const plan = { peopleMatches: [person()] };
    const occurrences = new Map([[person().original, [{ role: 'member', rowNumber: 2, meeting: 'ثانوي بنات', grade: 'الاول', group: 'فصل أ' }]]]);
    const result = analyzeAmbiguous(plan, occurrences, [{ _id: U1, fullName: person().original, gender: 'female' }, { _id: U2, fullName: person().original, gender: 'male' }], new Map());
    expect(result[0]).toMatchObject({ recommendedCandidateId: U1, automaticallyResolvable: true });
  });

  test('eliminates an incompatible education stage', () => {
    const plan = { peopleMatches: [person()] };
    const occurrences = new Map([[person().original, [{ role: 'member', rowNumber: 2, meeting: 'ابتدائي 1', grade: 'الاول', group: 'فصل أ' }]]]);
    const users = [{ _id: U1, fullName: person().original, education: { stage: 'primary_grade_1' } }, { _id: U2, fullName: person().original, education: { stage: 'preparatory_grade_1' } }];
    expect(analyzeAmbiguous(plan, occurrences, users, new Map())[0].recommendedCandidateId).toBe(U1);
  });

  test('excludes a deleted candidate', () => {
    const plan = { peopleMatches: [person()] };
    const occurrences = new Map([[person().original, [{ role: 'member', rowNumber: 2, meeting: 'جامعيين', grade: '', group: 'فصل أ' }]]]);
    const users = [{ _id: U1, fullName: person().original }, { _id: U2, fullName: person().original, isDeleted: true }];
    expect(analyzeAmbiguous(plan, occurrences, users, new Map())[0].recommendedCandidateId).toBe(U1);
  });
});

describe('operation-level conflict planning', () => {
  function analyze(rows, meeting = {}) {
    const names = [...new Set(rows.flatMap((entry) => [entry.member, ...entry.servants]))];
    const peopleMatches = names.map((name, index) => ({ original: name, matchedId: index ? U2 : U1, status: 'EXACT_MATCH' }));
    const groups = [...new Set(rows.map((entry) => [entry.sector, entry.meeting, entry.grade, entry.group].join('\u001f')))].map((key) => group({ sourceKey: key, originalGroupName: key.split('\u001f')[3], targetGroupName: key.split('\u001f')[3] }));
    return analyzeAssignments({ peopleMatches, groups }, rows, [{ _id: M1, name: 'ثانوي بنات', servedUserIds: [], groupAssignments: [], servants: [], ...meeting }]);
  }

  test('classifies an existing exact member assignment as a no-op', () => {
    const result = analyze([row()], { groupAssignments: [{ group: 'فصل أ', servedUserIds: [U1] }] });
    expect(result.reconciliation.memberNoOps).toBe(1);
  });

  test('blocks a different group in the same meeting', () => {
    const result = analyze([row()], { groupAssignments: [{ group: 'فصل ب', servedUserIds: [U1] }] });
    expect(result.conflicts.find((entry) => entry.kind === 'member').classification).toBe('DIFFERENT_GROUP_IN_SAME_MEETING');
  });

  test('blocks only the person assigned to multiple Excel groups in one meeting', () => {
    const result = analyze([row(), row({ rowNumber: 3, group: 'فصل ب' })]);
    expect(result.reconciliation.memberBlocked).toBe(2);
    expect(result.impacts.every((entry) => entry.groupCreationSafe)).toBe(true);
  });

  test('allows additive membership in another meeting and preserves safe operations', () => {
    const result = analyze([row()]);
    expect(result.reconciliation.memberSafeAdds).toBe(1);
  });

  test('classifies the same resolved person in different meetings as allowed', () => {
    const secondMeetingId = '200000000000000000000002';
    const rows = [row(), row({ rowNumber: 3, meeting: 'جامعيين', grade: '', group: 'فصل ب' })];
    const sourcePlan = {
      peopleMatches: [{ original: 'مريم سمير حنا', matchedId: U1, status: 'EXACT_MATCH' }],
      groups: [group(), group({ sourceKey: ['قطاع', 'جامعيين', '', 'فصل ب'].join('\u001f'), meeting: 'جامعيين', meetingId: secondMeetingId, grade: '', originalGroupName: 'فصل ب', targetGroupName: 'فصل ب' })],
    };
    const meetings = [{ _id: M1, name: 'ثانوي بنات', servedUserIds: [], groupAssignments: [], servants: [] }, { _id: secondMeetingId, name: 'جامعيين', servedUserIds: [], groupAssignments: [], servants: [] }];
    const result = analyzeAssignments(sourcePlan, rows, meetings);
    expect(result.conflicts.some((entry) => entry.classification === 'MULTIPLE_MEETINGS_ALLOWED' && entry.disposition === 'WARNING')).toBe(true);
    expect(result.reconciliation.memberSafeAdds).toBe(2);
  });

  test('servant spelling variants resolving to one ID and count mismatches do not block', () => {
    const rows = [row({ servants: ['نسمة صلاح'], declaredMembers: '99' }), row({ rowNumber: 3, servants: ['نسمه صلاح'], member: 'عضو آخر', declaredMembers: '99' })];
    const plan = { peopleMatches: [{ original: 'مريم سمير حنا', matchedId: U1 }, { original: 'عضو آخر', matchedId: U2 }, { original: 'نسمة صلاح', matchedId: U3 }, { original: 'نسمه صلاح', matchedId: U3 }], groups: [group()] };
    const result = analyzeAssignments(plan, rows, [{ _id: M1, name: 'ثانوي بنات', groupAssignments: [], servants: [], servedUserIds: [] }]);
    expect(result.reconciliation.servantSafeAdds).toBe(1);
    expect(result.reconciliation.servantBlocked).toBe(0);
  });

  test('blocker breakdown excludes warnings', () => {
    const result = blockerBreakdown({ blockingErrors: [{ type: 'MISSING_USER' }], warnings: [{ type: 'MEMBER_SOURCE_ROW_COUNT_MISMATCH' }] });
    expect(result.find((entry) => entry.type === 'MISSING_PERSON_BLOCKER').count).toBe(1);
    expect(result.some((entry) => entry.type === 'MEMBER_SOURCE_ROW_COUNT_MISMATCH')).toBe(false);
  });
});
