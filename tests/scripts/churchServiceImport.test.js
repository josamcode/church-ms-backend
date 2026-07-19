const { cleanExactName, normalizeArabicComparison } = require('../../src/utils/arabicNormalization');
const { scalarCellValue } = require('../../scripts/churchServiceImport/workbook');
const { buildNameLookup, resolveName } = require('../../scripts/churchServiceImport/matching');
const { buildImportPlan, resolveExistingGroup, planSingleAssignment } = require('../../scripts/churchServiceImport/planner');
const { calculatePlanChecksum, assertApplyPreconditions } = require('../../scripts/churchServiceImport/integrity');

describe('Arabic comparison normalization', () => {
  test.each([
    ['احمد', 'أحمد'],
    ['احمد', 'إحمد'],
    ['احمد', 'آحمد'],
    ['احمد', 'ٱحمد'],
    ['نسمه', 'نسمة'],
    ['مجدي', 'مجدى'],
    ['فواد', 'فؤاد'],
    ['وايل', 'وائل'],
    ['ابتدائي 1', 'ابتدائي ١'],
    ['ابتدائي 2', 'ابتدائي ۲'],
    ['احمد مجدي', '  أَحْــمَد   مجدى  '],
  ])('normalizes %s and %s identically', (a, b) => {
    expect(normalizeArabicComparison(a)).toBe(normalizeArabicComparison(b));
  });

  test('preserves original display form and word order', () => {
    expect(cleanExactName('  أحمد   مجدى ')).toBe('أحمد مجدى');
    expect(normalizeArabicComparison('مجدي أحمد')).not.toBe(normalizeArabicComparison('أحمد مجدي'));
  });

  test('normalizes harmless surrounding punctuation', () => {
    expect(normalizeArabicComparison('(أحمد)، مجدى.')).toBe('احمد مجدي');
  });
});

describe('cached Excel values', () => {
  test('extracts cached formula result and never formula text', () => {
    expect(scalarCellValue({ formula: '__xludf.DUMMYFUNCTION(...)', result: 'التربية الكنسية' }, 'A2')).toBe('التربية الكنسية');
  });

  test('rejects #NAME? cached results', () => {
    expect(() => scalarCellValue({ formula: 'x()', result: { error: '#NAME?' } }, 'A2')).toThrow(/#NAME\?/);
  });
});

describe('deterministic full-name matching', () => {
  const users = [
    { _id: '1', fullName: 'أحمد مجدي' },
    { _id: '2', fullName: 'نسمة سمير' },
  ];
  const lookup = buildNameLookup(users);

  test('exact match has priority', () => expect(resolveName('أحمد مجدي', lookup).status).toBe('EXACT_MATCH'));
  test('unique normalized match is accepted', () => expect(resolveName('احمد مجدى', lookup).status).toBe('NORMALIZED_MATCH'));
  test('missing match is reported', () => expect(resolveName('شخص غير موجود', lookup).status).toBe('MISSING'));
  test('ambiguous normalized match is never selected', () => {
    const ambiguous = buildNameLookup([...users, { _id: '3', fullName: 'احمد مجدى' }]);
    const result = resolveName('احمد مجدي', ambiguous);
    expect(result.status).toBe('AMBIGUOUS');
    expect(result.matched).toBeUndefined();
  });
});

function smallPlanFixture({ duplicate = false, missing = false, existing = false } = {}) {
  const users = [
    { _id: '000000000000000000000001', fullName: 'خادم واحد', accountStatus: 'approved', role: 'USER' },
    { _id: '000000000000000000000002', fullName: 'عضو واحد', accountStatus: 'approved', role: 'USER' },
  ];
  const baseRow = {
    rowNumber: 2, sector: 'قطاع', meeting: 'اجتماع', grade: '', group: 'مجموعة',
    declaredServants: '1', servants: ['خادم واحد'], declaredMembers: duplicate ? '2' : '1', member: missing ? 'عضو مفقود' : 'عضو واحد',
  };
  const rows = duplicate ? [baseRow, { ...baseRow, rowNumber: 3 }] : [baseRow];
  return buildImportPlan({
    parsed: { rows, sheetName: 'Sheet2' },
    users,
    sectors: [{ _id: '100000000000000000000001', name: 'قطاع' }],
    meetings: [{
      _id: '200000000000000000000001', sectorId: '100000000000000000000001', name: 'اجتماع',
      groups: existing ? ['مجموعة'] : [], groupAssignments: existing ? [{ group: 'مجموعة', servedUserIds: ['000000000000000000000002'] }] : [], servants: [], servedUserIds: [],
    }],
    databaseName: 'test', inputPath: 'fixture.xlsx', inputHash: 'abc', generatedAt: '2026-01-01T00:00:00.000Z',
  });
}

describe('group and assignment planning', () => {
  test('reuses a unique normalized existing group', () => {
    const result = resolveExistingGroup('ابتدائي 1', { groups: ['ابتدائي ١'], groupAssignments: [], servants: [] });
    expect(result).toMatchObject({ status: 'REUSE', name: 'ابتدائي ١', method: 'NORMALIZED' });
  });

  test('detects duplicate member rows', () => {
    const plan = smallPlanFixture({ duplicate: true });
    expect(plan.conflicts.some((entry) => entry.type === 'DUPLICATE_MEMBER_ROWS')).toBe(true);
  });

  test('plans existing assignments as idempotent no-ops', () => {
    const plan = smallPlanFixture({ existing: true });
    expect(plan.groups[0].operations.memberAssignments).toEqual({ ADD: 0, NO_OP: 1 });
    expect(planSingleAssignment({ existingIds: ['1'], requestedIds: ['1', '2', '2'] })).toEqual([
      { id: '1', action: 'NO_OP' }, { id: '2', action: 'ADD' },
    ]);
  });
});

describe('apply safety', () => {
  function approvedPlan() {
    const plan = smallPlanFixture();
    plan.safeToApply = true;
    plan.blockingErrors = [];
    plan.planChecksum = calculatePlanChecksum(plan);
    return plan;
  }

  test('blocks apply when unresolved matches remain', () => {
    const plan = smallPlanFixture({ missing: true });
    plan.planChecksum = calculatePlanChecksum(plan);
    expect(() => assertApplyPreconditions({ plan, suppliedChecksum: plan.planChecksum, currentInputHash: 'abc', currentDatabaseName: 'test' })).toThrow(/blocking errors/);
  });

  test('blocks input checksum mismatch', () => {
    const plan = approvedPlan();
    expect(() => assertApplyPreconditions({ plan, suppliedChecksum: plan.planChecksum, currentInputHash: 'changed', currentDatabaseName: 'test' })).toThrow(/workbook checksum mismatch/);
  });

  test('blocks plan confirmation checksum mismatch', () => {
    const plan = approvedPlan();
    expect(() => assertApplyPreconditions({ plan, suppliedChecksum: 'wrong', currentInputHash: 'abc', currentDatabaseName: 'test' })).toThrow(/Confirmation checksum/);
  });
});
