const { getAgeGroup } = require('../../constants/ageGroups');
const {
  HOUSEHOLD_CLASSIFICATION_METRICS,
  HOUSEHOLD_CLASSIFICATION_OPERATORS,
} = require('./householdClassification.catalog');

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function trimOrNull(value) {
  const trimmed = String(value || '').trim();
  return trimmed || null;
}

function createHouseholdSeed(member) {
  const houseName = trimOrNull(member.houseName);

  if (houseName) {
    return {
      householdKey: `house:${normalizeText(houseName)}`,
      householdName: houseName,
      sourceField: 'houseName',
    };
  }

  return null;
}

function mapMember(member) {
  const monthlyIncomeRaw = member?.financial?.monthlyIncome;
  const monthlyIncome = Number.isFinite(Number(monthlyIncomeRaw))
    ? Number(monthlyIncomeRaw)
    : null;

  return {
    id: String(member._id || member.id),
    fullName: member.fullName || '',
    phonePrimary: member.phonePrimary || '',
    familyName: trimOrNull(member.familyName),
    houseName: trimOrNull(member.houseName),
    gender: member.gender || null,
    ageGroup: member.ageGroup || getAgeGroup(member.birthDate) || null,
    employmentStatus: member?.employment?.status || null,
    presenceStatus: member?.presence?.status || 'present',
    travelDestination: trimOrNull(member?.presence?.travelDestination),
    monthlyIncome,
    diseases: Array.isArray(member?.health?.conditions)
      ? member.health.conditions
        .map((condition) => trimOrNull(condition?.name))
        .filter(Boolean)
      : [],
  };
}

function buildHouseholdSnapshots(users = []) {
  const grouped = new Map();

  users.forEach((user) => {
    const seed = createHouseholdSeed(user);
    if (!seed) return;
    const existing = grouped.get(seed.householdKey);
    if (!existing) {
      grouped.set(seed.householdKey, {
        householdKey: seed.householdKey,
        householdName: seed.householdName,
        sourceField: seed.sourceField,
        members: [mapMember(user)],
      });
      return;
    }

    existing.members.push(mapMember(user));
  });

  return [...grouped.values()].map((group) => {
    const members = group.members.sort((a, b) =>
      String(a.fullName || '').localeCompare(String(b.fullName || ''), undefined, {
        sensitivity: 'base',
      })
    );

    const membersWithIncome = members.filter((member) => member.monthlyIncome != null);
    const totalMemberIncome = membersWithIncome.reduce(
      (sum, member) => sum + Number(member.monthlyIncome || 0),
      0
    );

    return {
      ...group,
      members,
      memberCount: members.length,
      totalMemberIncome,
      averageMemberIncome: membersWithIncome.length
        ? totalMemberIncome / membersWithIncome.length
        : 0,
    };
  });
}

function hasActiveMemberFilters(filters = {}) {
  const arrayKeys = [
    'genders',
    'ageGroups',
    'employmentStatuses',
    'presenceStatuses',
    'diseases',
    'travelDestinations',
  ];

  return (
    arrayKeys.some((key) => Array.isArray(filters[key]) && filters[key].length > 0) ||
    Number.isFinite(Number(filters.minMonthlyIncome)) ||
    Number.isFinite(Number(filters.maxMonthlyIncome))
  );
}

function memberMatchesFilters(member, filters = {}) {
  if (!hasActiveMemberFilters(filters)) return true;

  if (Array.isArray(filters.genders) && filters.genders.length > 0) {
    if (!filters.genders.includes(member.gender)) return false;
  }

  if (Array.isArray(filters.ageGroups) && filters.ageGroups.length > 0) {
    if (!filters.ageGroups.includes(member.ageGroup)) return false;
  }

  if (Array.isArray(filters.employmentStatuses) && filters.employmentStatuses.length > 0) {
    if (!filters.employmentStatuses.includes(member.employmentStatus)) return false;
  }

  if (Array.isArray(filters.presenceStatuses) && filters.presenceStatuses.length > 0) {
    if (!filters.presenceStatuses.includes(member.presenceStatus)) return false;
  }

  if (Array.isArray(filters.travelDestinations) && filters.travelDestinations.length > 0) {
    const normalizedDestinations = filters.travelDestinations.map(normalizeText);
    if (!normalizedDestinations.includes(normalizeText(member.travelDestination))) return false;
  }

  const minMonthlyIncome = Number(filters.minMonthlyIncome);
  if (Number.isFinite(minMonthlyIncome)) {
    if (member.monthlyIncome == null || Number(member.monthlyIncome) < minMonthlyIncome) return false;
  }

  const maxMonthlyIncome = Number(filters.maxMonthlyIncome);
  if (Number.isFinite(maxMonthlyIncome)) {
    if (member.monthlyIncome == null || Number(member.monthlyIncome) > maxMonthlyIncome) return false;
  }

  if (Array.isArray(filters.diseases) && filters.diseases.length > 0) {
    const memberDiseases = new Set((member.diseases || []).map(normalizeText));
    const requestedDiseases = filters.diseases.map(normalizeText);
    const mode = filters.diseaseMatchMode === 'all' ? 'all' : 'any';
    const diseaseMatched =
      mode === 'all'
        ? requestedDiseases.every((disease) => memberDiseases.has(disease))
        : requestedDiseases.some((disease) => memberDiseases.has(disease));

    if (!diseaseMatched) return false;
  }

  return true;
}

function compareNumeric(actual, criterion) {
  switch (criterion.operator) {
    case HOUSEHOLD_CLASSIFICATION_OPERATORS.EQ:
      return Number(actual) === Number(criterion.value);
    case HOUSEHOLD_CLASSIFICATION_OPERATORS.GTE:
      return Number(actual) >= Number(criterion.value);
    case HOUSEHOLD_CLASSIFICATION_OPERATORS.LTE:
      return Number(actual) <= Number(criterion.value);
    case HOUSEHOLD_CLASSIFICATION_OPERATORS.BETWEEN:
      return (
        Number(actual) >= Number(criterion.minValue) &&
        Number(actual) <= Number(criterion.maxValue)
      );
    default:
      return false;
  }
}

function compareBoolean(actual, criterion) {
  if (criterion.operator === HOUSEHOLD_CLASSIFICATION_OPERATORS.IS_TRUE) {
    return Boolean(actual) === true;
  }
  if (criterion.operator === HOUSEHOLD_CLASSIFICATION_OPERATORS.IS_FALSE) {
    return Boolean(actual) === false;
  }
  return false;
}

function evaluateCriterion(snapshot, criterion) {
  const matchingMembers = snapshot.members.filter((member) =>
    memberMatchesFilters(member, criterion.filters)
  );

  let actualValue;

  switch (criterion.metric) {
    case HOUSEHOLD_CLASSIFICATION_METRICS.HOUSEHOLD_MEMBER_COUNT:
      actualValue = snapshot.memberCount;
      break;
    case HOUSEHOLD_CLASSIFICATION_METRICS.HOUSEHOLD_TOTAL_MEMBER_INCOME:
      actualValue = snapshot.totalMemberIncome;
      break;
    case HOUSEHOLD_CLASSIFICATION_METRICS.HOUSEHOLD_AVERAGE_MEMBER_INCOME:
      actualValue = snapshot.averageMemberIncome;
      break;
    case HOUSEHOLD_CLASSIFICATION_METRICS.MEMBERS_MATCHING_COUNT:
      actualValue = matchingMembers.length;
      break;
    case HOUSEHOLD_CLASSIFICATION_METRICS.MEMBERS_ANY_MATCH:
      actualValue = matchingMembers.length > 0;
      break;
    case HOUSEHOLD_CLASSIFICATION_METRICS.MEMBERS_ALL_MATCH:
      actualValue = snapshot.memberCount > 0 && matchingMembers.length === snapshot.memberCount;
      break;
    default:
      actualValue = null;
      break;
  }

  const passed =
    typeof actualValue === 'boolean'
      ? compareBoolean(actualValue, criterion)
      : compareNumeric(actualValue, criterion);

  return {
    id: String(criterion._id || criterion.id || ''),
    label: criterion.label || null,
    isRequired: criterion.isRequired !== false,
    metric: criterion.metric,
    operator: criterion.operator,
    value: criterion.value ?? null,
    minValue: criterion.minValue ?? null,
    maxValue: criterion.maxValue ?? null,
    filters: criterion.filters || {},
    actualValue,
    passed,
  };
}

function evaluateCategory(snapshot, category) {
  const criteria = Array.isArray(category.criteria) ? category.criteria : [];
  const results = criteria.map((criterion) => evaluateCriterion(snapshot, criterion));
  const requiredResults = results.filter((result) => result.isRequired);
  const optionalResults = results.filter((result) => !result.isRequired);

  const matched =
    results.length > 0 &&
    requiredResults.every((result) => result.passed) &&
    (requiredResults.length > 0 || optionalResults.some((result) => result.passed));

  return {
    id: String(category._id || category.id),
    name: category.name,
    description: category.description || '',
    color: category.color,
    priority: category.priority,
    isDefault: Boolean(category.isDefault),
    isActive: Boolean(category.isActive),
    isConfigured: criteria.length > 0,
    matched,
    criteria: results,
    matchedRequiredCriteria: requiredResults.filter((result) => result.passed).length,
    matchedOptionalCriteria: optionalResults.filter((result) => result.passed).length,
  };
}

function evaluateHouseholdSnapshot(snapshot, categories = []) {
  const categoryEvaluations = categories
    .map((category) => evaluateCategory(snapshot, category))
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));

  const matchedCategories = categoryEvaluations.filter((category) => category.matched);
  const primaryClassification = matchedCategories[0] || null;

  return {
    householdKey: snapshot.householdKey,
    householdName: snapshot.householdName,
    sourceField: snapshot.sourceField,
    memberCount: snapshot.memberCount,
    totalMemberIncome: snapshot.totalMemberIncome,
    averageMemberIncome: snapshot.averageMemberIncome,
    members: snapshot.members,
    primaryClassification: primaryClassification
      ? {
        id: primaryClassification.id,
        name: primaryClassification.name,
        color: primaryClassification.color,
        priority: primaryClassification.priority,
      }
      : null,
    matchedCategories: matchedCategories.map((category) => ({
      id: category.id,
      name: category.name,
      color: category.color,
      priority: category.priority,
    })),
    categoryEvaluations,
  };
}

module.exports = {
  buildHouseholdSnapshots,
  createHouseholdSeed,
  evaluateHouseholdSnapshot,
  hasActiveMemberFilters,
};
