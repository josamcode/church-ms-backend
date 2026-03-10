const mongoose = require('mongoose');
const User = require('../users/user.model');
const ApiError = require('../../utils/ApiError');
const HouseholdClassification = require('./householdClassification.model');
const {
  BOOLEAN_METRICS,
  DEFAULT_HOUSEHOLD_CLASSIFICATIONS,
  HOUSEHOLD_CLASSIFICATION_OPERATORS,
  NUMERIC_METRICS,
} = require('./householdClassification.catalog');
const {
  buildHouseholdSnapshots,
  createHouseholdSeed,
  evaluateHouseholdSnapshot,
  hasActiveMemberFilters,
} = require('./householdClassification.engine');

function trimString(value) {
  if (value == null) return undefined;
  const trimmed = String(value).trim();
  return trimmed || undefined;
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class HouseholdClassificationService {
  async ensureDefaultCategories() {
    const totalCategories = await HouseholdClassification.countDocuments({});
    if (totalCategories > 0) return;
    await HouseholdClassification.insertMany(DEFAULT_HOUSEHOLD_CLASSIFICATIONS, { ordered: false });
  }

  _normalizeFilters(filters = {}) {
    const normalizeArray = (value) =>
      [...new Set((Array.isArray(value) ? value : []).map(trimString).filter(Boolean))];

    const normalized = {
      genders: normalizeArray(filters.genders),
      ageGroups: normalizeArray(filters.ageGroups),
      employmentStatuses: normalizeArray(filters.employmentStatuses),
      presenceStatuses: normalizeArray(filters.presenceStatuses),
      diseases: normalizeArray(filters.diseases),
      diseaseMatchMode: filters.diseaseMatchMode === 'all' ? 'all' : 'any',
      travelDestinations: normalizeArray(filters.travelDestinations),
    };

    if (Number.isFinite(Number(filters.minMonthlyIncome))) {
      normalized.minMonthlyIncome = Number(filters.minMonthlyIncome);
    }

    if (Number.isFinite(Number(filters.maxMonthlyIncome))) {
      normalized.maxMonthlyIncome = Number(filters.maxMonthlyIncome);
    }

    return normalized;
  }

  _normalizeCriterion(criterion = {}, index = 0) {
    const normalized = {
      label: trimString(criterion.label),
      isRequired: criterion.isRequired !== false,
      metric: criterion.metric,
      operator: criterion.operator,
      filters: this._normalizeFilters(criterion.filters),
    };

    if (criterion.value !== undefined && criterion.value !== null && criterion.value !== '') {
      normalized.value =
        typeof criterion.value === 'number' || typeof criterion.value === 'boolean'
          ? criterion.value
          : Number(criterion.value);
    }

    if (criterion.minValue !== undefined && criterion.minValue !== null && criterion.minValue !== '') {
      normalized.minValue = Number(criterion.minValue);
    }

    if (criterion.maxValue !== undefined && criterion.maxValue !== null && criterion.maxValue !== '') {
      normalized.maxValue = Number(criterion.maxValue);
    }

    this._assertCriterionIsValid(normalized, index);
    return normalized;
  }

  _assertCriterionIsValid(criterion, index) {
    if (NUMERIC_METRICS.has(criterion.metric)) {
      const isBetween = criterion.operator === HOUSEHOLD_CLASSIFICATION_OPERATORS.BETWEEN;
      const numericOperators = new Set([
        HOUSEHOLD_CLASSIFICATION_OPERATORS.EQ,
        HOUSEHOLD_CLASSIFICATION_OPERATORS.GTE,
        HOUSEHOLD_CLASSIFICATION_OPERATORS.LTE,
        HOUSEHOLD_CLASSIFICATION_OPERATORS.BETWEEN,
      ]);

      if (!numericOperators.has(criterion.operator)) {
        throw ApiError.badRequest(
          `Criterion ${index + 1} uses an unsupported numeric operator.`,
          'VALIDATION_ERROR'
        );
      }

      if (isBetween) {
        if (!Number.isFinite(criterion.minValue) || !Number.isFinite(criterion.maxValue)) {
          throw ApiError.badRequest(
            `Criterion ${index + 1} requires both minValue and maxValue.`,
            'VALIDATION_ERROR'
          );
        }
      } else if (!Number.isFinite(Number(criterion.value))) {
        throw ApiError.badRequest(
          `Criterion ${index + 1} requires a numeric value.`,
          'VALIDATION_ERROR'
        );
      }
    }

    if (BOOLEAN_METRICS.has(criterion.metric)) {
      const booleanOperators = new Set([
        HOUSEHOLD_CLASSIFICATION_OPERATORS.IS_TRUE,
        HOUSEHOLD_CLASSIFICATION_OPERATORS.IS_FALSE,
      ]);

      if (!booleanOperators.has(criterion.operator)) {
        throw ApiError.badRequest(
          `Criterion ${index + 1} uses an unsupported boolean operator.`,
          'VALIDATION_ERROR'
        );
      }
    }

    if (criterion.metric.startsWith('members.') && !hasActiveMemberFilters(criterion.filters)) {
      throw ApiError.badRequest(
        `Criterion ${index + 1} must include at least one member filter.`,
        'VALIDATION_ERROR'
      );
    }
  }

  _serializeCategory(category) {
    return {
      id: String(category._id || category.id),
      name: category.name,
      description: category.description || '',
      color: category.color,
      priority: category.priority,
      isDefault: Boolean(category.isDefault),
      isActive: Boolean(category.isActive),
      isConfigured: Array.isArray(category.criteria) && category.criteria.length > 0,
      criteriaCount: Array.isArray(category.criteria) ? category.criteria.length : 0,
      criteria: Array.isArray(category.criteria)
        ? category.criteria.map((criterion) => ({
            id: String(criterion._id || criterion.id || ''),
            label: criterion.label || '',
            isRequired: criterion.isRequired !== false,
            metric: criterion.metric,
            operator: criterion.operator,
            value: criterion.value ?? null,
            minValue: criterion.minValue ?? null,
            maxValue: criterion.maxValue ?? null,
            filters: criterion.filters || {},
          }))
        : [],
      createdAt: category.createdAt,
      updatedAt: category.updatedAt,
    };
  }

  async listCategories() {
    await this.ensureDefaultCategories();
    const categories = await HouseholdClassification.find({ isDeleted: { $ne: true } })
      .sort({ priority: 1, name: 1 })
      .lean();

    return categories.map((category) => this._serializeCategory(category));
  }

  async createCategory(data, actorUserId) {
    await this.ensureDefaultCategories();

    const name = trimString(data.name);
    const description = trimString(data.description);
    const color = trimString(data.color) || '#2563eb';
    const priority = Number.isFinite(Number(data.priority)) ? Number(data.priority) : 100;
    const isActive = data.isActive !== false;
    const criteria = Array.isArray(data.criteria)
      ? data.criteria.map((criterion, index) => this._normalizeCriterion(criterion, index))
      : [];

    const existing = await HouseholdClassification.findOne({
      isDeleted: { $ne: true },
      name: { $regex: new RegExp(`^${escapeRegex(name)}$`, 'i') },
    }).lean();

    if (existing) {
      throw ApiError.conflict(
        'A household classification with the same name already exists.',
        'RESOURCE_ALREADY_EXISTS'
      );
    }

    const created = await HouseholdClassification.create({
      name,
      description,
      color,
      priority,
      isActive,
      criteria,
      createdBy: actorUserId,
      updatedBy: actorUserId,
    });

    return this._serializeCategory(created.toObject());
  }

  async updateCategory(categoryId, data, actorUserId) {
    await this.ensureDefaultCategories();

    if (!mongoose.Types.ObjectId.isValid(categoryId)) {
      throw ApiError.badRequest('Invalid household classification id.', 'VALIDATION_ERROR');
    }

    const category = await HouseholdClassification.findOne({
      _id: categoryId,
      isDeleted: { $ne: true },
    });
    if (!category) {
      throw ApiError.notFound(
        'Household classification was not found.',
        'RESOURCE_NOT_FOUND'
      );
    }

    const nextName = trimString(data.name);
    if (nextName && nextName.toLowerCase() !== String(category.name || '').toLowerCase()) {
      const existing = await HouseholdClassification.findOne({
        _id: { $ne: category._id },
        isDeleted: { $ne: true },
        name: { $regex: new RegExp(`^${escapeRegex(nextName)}$`, 'i') },
      }).lean();

      if (existing) {
        throw ApiError.conflict(
          'A household classification with the same name already exists.',
          'RESOURCE_ALREADY_EXISTS'
        );
      }

      category.name = nextName;
    }

    if (data.description !== undefined) {
      category.description = trimString(data.description) || '';
    }

    if (data.color !== undefined) {
      category.color = trimString(data.color) || '#2563eb';
    }

    if (data.priority !== undefined && Number.isFinite(Number(data.priority))) {
      category.priority = Number(data.priority);
    }

    if (data.isActive !== undefined) {
      category.isActive = Boolean(data.isActive);
    }

    if (Array.isArray(data.criteria)) {
      category.criteria = data.criteria.map((criterion, index) =>
        this._normalizeCriterion(criterion, index)
      );
    }

    category.updatedBy = actorUserId;
    await category.save();

    return this._serializeCategory(category.toObject());
  }

  async deleteCategory(categoryId, actorUserId) {
    await this.ensureDefaultCategories();

    if (!mongoose.Types.ObjectId.isValid(categoryId)) {
      throw ApiError.badRequest('Invalid household classification id.', 'VALIDATION_ERROR');
    }

    const category = await HouseholdClassification.findOne({
      _id: categoryId,
      isDeleted: { $ne: true },
    });
    if (!category) {
      throw ApiError.notFound(
        'Household classification was not found.',
        'RESOURCE_NOT_FOUND'
      );
    }

    category.isDeleted = true;
    category.deletedAt = new Date();
    category.deletedBy = actorUserId;
    category.updatedBy = actorUserId;
    await category.save();
  }

  async _loadCategoriesForEvaluation() {
    await this.ensureDefaultCategories();
    return HouseholdClassification.find({
      isActive: true,
      isDeleted: { $ne: true },
    })
      .sort({ priority: 1, name: 1 })
      .lean();
  }

  async _loadUsersForEvaluation() {
    return User.find()
      .select(
        [
          'fullName',
          'phonePrimary',
          'familyName',
          'houseName',
          'gender',
          'ageGroup',
          'birthDate',
          'financial',
          'employment',
          'presence',
          'health',
        ].join(' ')
      )
      .lean();
  }

  async listHouseholds({
    page = 1,
    limit = 12,
    search,
    classificationId,
    includeUnclassified = true,
  }) {
    const [categories, users] = await Promise.all([
      this._loadCategoriesForEvaluation(),
      this._loadUsersForEvaluation(),
    ]);

    let evaluations = buildHouseholdSnapshots(users)
      .map((snapshot) => evaluateHouseholdSnapshot(snapshot, categories))
      .sort((a, b) => {
        const aPriority = a.primaryClassification?.priority ?? Number.MAX_SAFE_INTEGER;
        const bPriority = b.primaryClassification?.priority ?? Number.MAX_SAFE_INTEGER;
        if (aPriority !== bPriority) return aPriority - bPriority;
        return a.householdName.localeCompare(b.householdName, undefined, { sensitivity: 'base' });
      });

    const normalizedSearch = trimString(search)?.toLowerCase();
    if (normalizedSearch) {
      evaluations = evaluations.filter((entry) => {
        if (entry.householdName.toLowerCase().includes(normalizedSearch)) return true;
        return entry.members.some((member) =>
          String(member.fullName || '').toLowerCase().includes(normalizedSearch)
        );
      });
    }

    if (classificationId) {
      evaluations = evaluations.filter(
        (entry) => entry.primaryClassification?.id === String(classificationId)
      );
    }

    if (!includeUnclassified) {
      evaluations = evaluations.filter((entry) => Boolean(entry.primaryClassification));
    }

    const totalCount = evaluations.length;
    const safePage = Math.max(Number(page) || 1, 1);
    const safeLimit = Math.max(Math.min(Number(limit) || 12, 100), 1);
    const totalPages = Math.max(Math.ceil(totalCount / safeLimit), 1);
    const currentPage = Math.min(safePage, totalPages);
    const startIndex = (currentPage - 1) * safeLimit;
    const households = evaluations.slice(startIndex, startIndex + safeLimit);

    const categoryCountMap = new Map();
    evaluations.forEach((entry) => {
      if (!entry.primaryClassification) return;
      const key = entry.primaryClassification.id;
      categoryCountMap.set(key, (categoryCountMap.get(key) || 0) + 1);
    });

    const summary = {
      totalHouseholds: evaluations.length,
      classifiedHouseholds: evaluations.filter((entry) => Boolean(entry.primaryClassification)).length,
      unclassifiedHouseholds: evaluations.filter((entry) => !entry.primaryClassification).length,
      categoryBreakdown: categories.map((category) => ({
        id: String(category._id),
        name: category.name,
        color: category.color,
        count: categoryCountMap.get(String(category._id)) || 0,
      })),
    };

    return {
      households,
      meta: {
        page: currentPage,
        limit: safeLimit,
        totalCount,
        totalPages,
        hasNextPage: currentPage < totalPages,
        hasPrevPage: currentPage > 1,
      },
      summary,
    };
  }

  async getHouseholdSummaryForUser(user) {
    if (!user) return null;

    const [categories, users] = await Promise.all([
      this._loadCategoriesForEvaluation(),
      this._loadUsersForEvaluation(),
    ]);

    const seed = createHouseholdSeed(user);
    if (!seed) return null;
    const snapshot = buildHouseholdSnapshots(users).find(
      (entry) => entry.householdKey === seed.householdKey
    );

    if (!snapshot) return null;

    return evaluateHouseholdSnapshot(snapshot, categories);
  }
}

module.exports = new HouseholdClassificationService();
