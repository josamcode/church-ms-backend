const HOUSEHOLD_CLASSIFICATION_METRICS = Object.freeze({
  HOUSEHOLD_MEMBER_COUNT: 'household.memberCount',
  HOUSEHOLD_TOTAL_MEMBER_INCOME: 'household.totalMemberIncome',
  HOUSEHOLD_AVERAGE_MEMBER_INCOME: 'household.averageMemberIncome',
  MEMBERS_MATCHING_COUNT: 'members.matchingCount',
  MEMBERS_ANY_MATCH: 'members.anyMatch',
  MEMBERS_ALL_MATCH: 'members.allMatch',
});

const HOUSEHOLD_CLASSIFICATION_METRICS_ARRAY = Object.values(
  HOUSEHOLD_CLASSIFICATION_METRICS
);

const HOUSEHOLD_CLASSIFICATION_OPERATORS = Object.freeze({
  EQ: 'eq',
  GTE: 'gte',
  LTE: 'lte',
  BETWEEN: 'between',
  IS_TRUE: 'isTrue',
  IS_FALSE: 'isFalse',
});

const HOUSEHOLD_CLASSIFICATION_OPERATORS_ARRAY = Object.values(
  HOUSEHOLD_CLASSIFICATION_OPERATORS
);

const NUMERIC_METRICS = new Set([
  HOUSEHOLD_CLASSIFICATION_METRICS.HOUSEHOLD_MEMBER_COUNT,
  HOUSEHOLD_CLASSIFICATION_METRICS.HOUSEHOLD_TOTAL_MEMBER_INCOME,
  HOUSEHOLD_CLASSIFICATION_METRICS.HOUSEHOLD_AVERAGE_MEMBER_INCOME,
  HOUSEHOLD_CLASSIFICATION_METRICS.MEMBERS_MATCHING_COUNT,
]);

const BOOLEAN_METRICS = new Set([
  HOUSEHOLD_CLASSIFICATION_METRICS.MEMBERS_ANY_MATCH,
  HOUSEHOLD_CLASSIFICATION_METRICS.MEMBERS_ALL_MATCH,
]);

const DEFAULT_HOUSEHOLD_CLASSIFICATIONS = Object.freeze([
  {
    name: 'الأكثر إحتياجا',
    description: 'الأسر ذات الأولوية القصوى التي تتطلب متابعة ودعماً عاجلاً.',
    color: '#dc2626',
    priority: 10,
    isDefault: true,
    isActive: true,
    criteria: [],
  },
  {
    name: 'محتاجين',
    description: 'الأسر التي تستوفي معايير دعم الخدمة ولكنها ليست ضمن أعلى مستوى من الاحتياجات العاجلة.',
    color: '#d97706',
    priority: 20,
    isDefault: true,
    isActive: true,
    criteria: [],
  },
  {
    name: 'مستورين',
    description: 'الأسر التي تشير ظروفها إلى استقرار مالي مقارنة بالفئات الأخرى.',
    color: '#059669',
    priority: 30,
    isDefault: true,
    isActive: true,
    criteria: [],
  },
]);

module.exports = {
  BOOLEAN_METRICS,
  DEFAULT_HOUSEHOLD_CLASSIFICATIONS,
  HOUSEHOLD_CLASSIFICATION_METRICS,
  HOUSEHOLD_CLASSIFICATION_METRICS_ARRAY,
  HOUSEHOLD_CLASSIFICATION_OPERATORS,
  HOUSEHOLD_CLASSIFICATION_OPERATORS_ARRAY,
  NUMERIC_METRICS,
};
