const mongoose = require('mongoose');
const redisClient = require('../../config/redis');
const { CACHE_KEYS } = require('../../constants/cacheKeys');
const { getEducationStageGroup } = require('../../constants/education');
const { PERMISSIONS } = require('../../constants/permissions');
const User = require('../users/user.model');
const ApiError = require('../../utils/ApiError');
const HouseholdClassification = require('./householdClassification.model');
const HouseholdProfile = require('./householdProfile.model');
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

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function buildHouseholdKey(houseName) {
  const normalizedHouseName = normalizeText(houseName);
  return normalizedHouseName ? `house:${normalizedHouseName}` : null;
}

function uniqueTrimmedStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map(trimString).filter(Boolean))];
}

class HouseholdClassificationService {
  async ensureDefaultCategories() {
    const totalCategories = await HouseholdClassification.countDocuments({});
    if (totalCategories > 0) return;
    await HouseholdClassification.insertMany(DEFAULT_HOUSEHOLD_CLASSIFICATIONS, { ordered: false });
  }

  _getExactHouseNameQuery(houseName) {
    return {
      houseName: { $regex: new RegExp(`^${escapeRegex(String(houseName || '').trim())}$`, 'i') },
    };
  }

  _buildIncomeSourceList(members = []) {
    return uniqueTrimmedStrings(members.map((member) => member?.financial?.source)).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' })
    );
  }

  _serializeClassificationReference(category, { isManual = false } = {}) {
    if (!category) return null;
    return {
      id: String(category._id || category.id),
      name: category.name,
      color: category.color,
      priority: category.priority,
      isManual,
    };
  }

  _applyHouseholdProfileToEvaluation(evaluation, profile, categoryMap = new Map()) {
    const incomeSources = Array.isArray(profile?.financial?.incomeSources) && profile.financial.incomeSources.length > 0
      ? uniqueTrimmedStrings(profile.financial.incomeSources).sort((a, b) =>
          a.localeCompare(b, undefined, { sensitivity: 'base' })
        )
      : this._buildIncomeSourceList(evaluation.members);

    const manualCategory = profile?.manualPrimaryClassificationId
      ? categoryMap.get(String(profile.manualPrimaryClassificationId))
      : null;

    return {
      ...evaluation,
      incomeSources,
      profile: profile
        ? {
            id: String(profile._id || profile.id),
            houseName: profile.houseName,
            incomeSources,
            manualPrimaryClassificationId: profile.manualPrimaryClassificationId
              ? String(profile.manualPrimaryClassificationId)
              : null,
          }
        : null,
      primaryClassification: manualCategory
        ? this._serializeClassificationReference(manualCategory, { isManual: true })
        : evaluation.primaryClassification,
      computedPrimaryClassification: evaluation.primaryClassification,
      isPrimaryClassificationManual: Boolean(manualCategory),
    };
  }

  async _loadActiveCategoriesForEvaluation() {
    await this.ensureDefaultCategories();
    return HouseholdClassification.find({
      isActive: true,
      isDeleted: { $ne: true },
    })
      .sort({ priority: 1, name: 1 })
      .lean();
  }

  async _loadProfilesByKeys(householdKeys = []) {
    const keys = uniqueTrimmedStrings(householdKeys);
    if (keys.length === 0) return [];
    return HouseholdProfile.find({ householdKey: { $in: keys } }).lean();
  }

  _normalizeFilters(filters = {}) {
    const normalizeArray = (value) =>
      [...new Set((Array.isArray(value) ? value : []).map(trimString).filter(Boolean))];
    const normalizeEducationStages = (value) =>
      [...new Set(
        (Array.isArray(value) ? value : [])
          .map((entry) => getEducationStageGroup(trimString(entry)))
          .filter(Boolean)
      )];

    const normalized = {
      genders: normalizeArray(filters.genders),
      ageGroups: normalizeArray(filters.ageGroups),
      educationStages: normalizeEducationStages(filters.educationStages),
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

  _serializeCategory(category, extra = {}) {
    return {
      id: String(category._id || category.id),
      name: category.name,
      description: category.description || '',
      color: category.color,
      priority: category.priority,
      isDefault: Boolean(category.isDefault),
      isActive: Boolean(category.isActive),
      isConfigured: Array.isArray(category.criteria) && category.criteria.length > 0,
      count: Number(extra.count) || 0,
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

  async _buildCategoryCountMap(categories = []) {
    const activeCategories = (Array.isArray(categories) ? categories : []).filter(
      (category) => Boolean(category) && category.isActive !== false && category.isDeleted !== true
    );

    if (activeCategories.length === 0) {
      return new Map();
    }

    const { evaluations } = await this._evaluateAllHouseholds();

    const categoryCountMap = new Map();
    evaluations.forEach((entry) => {
      if (!entry.primaryClassification?.id) return;
      const key = String(entry.primaryClassification.id);
      categoryCountMap.set(key, (categoryCountMap.get(key) || 0) + 1);
    });

    return categoryCountMap;
  }

  async listCategories() {
    await this.ensureDefaultCategories();
    const categories = await HouseholdClassification.find({ isDeleted: { $ne: true } })
      .sort({ priority: 1, name: 1 })
      .lean();

    const categoryCountMap = await this._buildCategoryCountMap(categories);

    return categories.map((category) =>
      this._serializeCategory(category, {
        count: categoryCountMap.get(String(category._id || category.id)) || 0,
      })
    );
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

  async _loadUsersForEvaluation() {
    return User.find({ isDeleted: { $ne: true } })
      .select(
        [
          'fullName',
          'phonePrimary',
          'familyName',
          'houseName',
          'gender',
          'ageGroup',
          'birthDate',
          'education',
          'financial',
          'employment',
          'presence',
          'health',
        ].join(' ')
      )
      .lean();
  }

  async _evaluateAllHouseholds() {
    const [categories, users] = await Promise.all([
      this._loadActiveCategoriesForEvaluation(),
      this._loadUsersForEvaluation(),
    ]);

    const snapshots = buildHouseholdSnapshots(users);
    const profiles = await this._loadProfilesByKeys(snapshots.map((snapshot) => snapshot.householdKey));
    const profileMap = new Map(profiles.map((profile) => [profile.householdKey, profile]));
    const categoryMap = new Map(categories.map((category) => [String(category._id), category]));

    const evaluations = snapshots
      .map((snapshot) => {
        const evaluation = evaluateHouseholdSnapshot(snapshot, categories);
        return this._applyHouseholdProfileToEvaluation(
          evaluation,
          profileMap.get(snapshot.householdKey),
          categoryMap
        );
      })
      .sort((a, b) => {
        const aPriority = a.primaryClassification?.priority ?? Number.MAX_SAFE_INTEGER;
        const bPriority = b.primaryClassification?.priority ?? Number.MAX_SAFE_INTEGER;
        if (aPriority !== bPriority) return aPriority - bPriority;
        return a.householdName.localeCompare(b.householdName, undefined, { sensitivity: 'base' });
      });

    return { categories, evaluations };
  }

  _buildIncomeDistribution(totalIncome, members = []) {
    const targetTotal = Math.max(Math.round(Number(totalIncome) || 0), 0);
    if (!Array.isArray(members) || members.length === 0) return [];

    const baselineAmounts = members.map((member) => {
      const amount = Number(member?.financial?.monthlyIncome);
      return Number.isFinite(amount) && amount > 0 ? amount : 0;
    });
    const positiveTotal = baselineAmounts.reduce((sum, amount) => sum + amount, 0);

    const rawShares =
      positiveTotal > 0
        ? baselineAmounts.map((amount) => (amount > 0 ? (targetTotal * amount) / positiveTotal : 0))
        : members.map(() => targetTotal / members.length);

    const roundedShares = rawShares.map((amount) => Math.floor(amount));
    let remainder = targetTotal - roundedShares.reduce((sum, amount) => sum + amount, 0);

    const allocationOrder = rawShares
      .map((amount, index) => ({
        index,
        fraction: amount - Math.floor(amount),
      }))
      .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

    for (let index = 0; index < allocationOrder.length && remainder > 0; index += 1) {
      roundedShares[allocationOrder[index].index] += 1;
      remainder -= 1;
    }

    return members.map((member, index) => ({
      member,
      monthlyIncome: roundedShares[index],
    }));
  }

  async getHouseholdByName(houseName) {
    const normalizedHouseName = trimString(houseName);
    if (!normalizedHouseName) {
      throw ApiError.badRequest('House name is required.', 'VALIDATION_ERROR');
    }

    const { evaluations } = await this._evaluateAllHouseholds();
    const household = evaluations.find(
      (entry) => normalizeText(entry.householdName) === normalizeText(normalizedHouseName)
    );

    if (!household) {
      throw ApiError.notFound('Household was not found.', 'RESOURCE_NOT_FOUND');
    }

    return household;
  }

  async listHouseholds({
    page = 1,
    limit = 12,
    search,
    classificationId,
    includeUnclassified = true,
  }) {
    const { categories, evaluations: allEvaluations } = await this._evaluateAllHouseholds();
    let evaluations = [...allEvaluations];

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

  async updateHousehold(data, actorUserId, actorPermissions = []) {
    const permissionSet = new Set(
      Array.isArray(actorPermissions) ? actorPermissions : []
    );
    const canUpdateMembers = permissionSet.has(PERMISSIONS.USERS_UPDATE);
    const canManageHouseholdProfiles = permissionSet.has(
      PERMISSIONS.HOUSEHOLD_CLASSIFICATIONS_MANAGE
    );
    const wantsToUpdateMembers =
      data.houseName !== undefined || data.totalIncome !== undefined;
    const wantsToUpdateProfile =
      data.manualPrimaryClassificationId !== undefined || data.incomeSources !== undefined;

    if (!wantsToUpdateMembers && !wantsToUpdateProfile) {
      throw ApiError.badRequest(
        'At least one editable household field must be provided.',
        'VALIDATION_ERROR'
      );
    }

    if (wantsToUpdateMembers && !canUpdateMembers) {
      throw ApiError.forbidden(
        'You do not have permission to rename the household or update total income.',
        'PERMISSION_DENIED'
      );
    }

    if (wantsToUpdateProfile && !canManageHouseholdProfiles) {
      throw ApiError.forbidden(
        'You do not have permission to update household classification details.',
        'PERMISSION_DENIED'
      );
    }

    const currentHouseName = trimString(data.currentHouseName);
    const nextHouseName = trimString(data.houseName) || currentHouseName;
    const currentHouseholdKey = buildHouseholdKey(currentHouseName);
    const nextHouseholdKey = buildHouseholdKey(nextHouseName);

    if (!currentHouseName || !currentHouseholdKey) {
      throw ApiError.badRequest('Current house name is required.', 'VALIDATION_ERROR');
    }
    if (!nextHouseName || !nextHouseholdKey) {
      throw ApiError.badRequest('House name is required.', 'VALIDATION_ERROR');
    }

    const [members, existingProfile] = await Promise.all([
      User.find({
        isDeleted: { $ne: true },
        ...this._getExactHouseNameQuery(currentHouseName),
      }),
      HouseholdProfile.findOne({ householdKey: currentHouseholdKey }),
    ]);

    if (members.length === 0 && !existingProfile) {
      throw ApiError.notFound('Household was not found.', 'RESOURCE_NOT_FOUND');
    }

    if (currentHouseholdKey !== nextHouseholdKey) {
      const [conflictingMembers, conflictingProfile] = await Promise.all([
        User.exists({
          isDeleted: { $ne: true },
          ...this._getExactHouseNameQuery(nextHouseName),
        }),
        HouseholdProfile.findOne({ householdKey: nextHouseholdKey }).lean(),
      ]);

      if (conflictingMembers || conflictingProfile) {
        throw ApiError.conflict(
          'Another household already uses this house name.',
          'RESOURCE_ALREADY_EXISTS'
        );
      }
    }

    let manualPrimaryClassificationId = existingProfile?.manualPrimaryClassificationId || null;
    if (data.manualPrimaryClassificationId !== undefined) {
      const nextManualId = trimString(data.manualPrimaryClassificationId);
      if (!nextManualId) {
        manualPrimaryClassificationId = null;
      } else {
        if (!mongoose.Types.ObjectId.isValid(nextManualId)) {
          throw ApiError.badRequest(
            'Invalid household classification id.',
            'VALIDATION_ERROR'
          );
        }

        const category = await HouseholdClassification.findOne({
          _id: nextManualId,
          isActive: true,
          isDeleted: { $ne: true },
        }).lean();

        if (!category) {
          throw ApiError.notFound(
            'Household classification was not found.',
            'RESOURCE_NOT_FOUND'
          );
        }

        manualPrimaryClassificationId = category._id;
      }
    }

    const incomeSources =
      data.incomeSources !== undefined
        ? uniqueTrimmedStrings(data.incomeSources).sort((a, b) =>
            a.localeCompare(b, undefined, { sensitivity: 'base' })
          )
        : existingProfile?.financial?.incomeSources || [];

    const shouldRedistributeIncome = wantsToUpdateMembers && data.totalIncome !== undefined;
    const shouldCheckAutomaticClassification =
      shouldRedistributeIncome &&
      data.manualPrimaryClassificationId === undefined &&
      !existingProfile?.manualPrimaryClassificationId;
    const currentEvaluation = shouldCheckAutomaticClassification
      ? await this.getHouseholdByName(currentHouseName).catch(() => null)
      : null;
    const incomeDistribution = shouldRedistributeIncome
      ? this._buildIncomeDistribution(data.totalIncome, members)
      : [];

    await Promise.all(
      incomeDistribution.map(async ({ member, monthlyIncome }) => {
        const previousIncome = Number.isFinite(Number(member?.financial?.monthlyIncome))
          ? Number(member.financial.monthlyIncome)
          : null;
        const changes = [];

        if (!member.financial || typeof member.financial !== 'object') {
          member.financial = {};
        }

        if (previousIncome !== monthlyIncome) {
          member.financial.monthlyIncome = monthlyIncome;
          member.financial.currency = 'EGP';
          changes.push({
            field: 'financial.monthlyIncome',
            from: previousIncome,
            to: monthlyIncome,
          });
        }

        if (changes.length === 0) return;

        if (!Array.isArray(member.changeLog)) {
          member.changeLog = [];
        }
        member.updatedBy = actorUserId;
        member.changeLog.push({
          by: actorUserId,
          action: 'Household total income updated',
          changes,
        });
        await member.save();
      })
    );

    await Promise.all(
      members.map(async (member) => {
        if (member.houseName === nextHouseName) return;

        const previousHouseName = member.houseName;
        member.houseName = nextHouseName;
        if (!Array.isArray(member.changeLog)) {
          member.changeLog = [];
        }
        member.updatedBy = actorUserId;
        member.changeLog.push({
          by: actorUserId,
          action: 'Household name updated',
          changes: [
            {
              field: 'houseName',
              from: previousHouseName,
              to: nextHouseName,
            },
          ],
        });
        await member.save();
      })
    );

    let profile = null;
    if (existingProfile || canManageHouseholdProfiles) {
      profile =
        existingProfile ||
        new HouseholdProfile({
          houseName: nextHouseName,
          createdBy: actorUserId,
        });

      profile.houseName = nextHouseName;
      if (canManageHouseholdProfiles) {
        profile.manualPrimaryClassificationId = manualPrimaryClassificationId;
        profile.financial = {
          ...(profile.financial || {}),
          incomeSources,
        };
      }
      profile.updatedBy = actorUserId;
      await profile.save();
    }

    let updatedHousehold = await this.getHouseholdByName(nextHouseName);
    const shouldStoreAutomaticClassification =
      shouldCheckAutomaticClassification &&
      !currentEvaluation?.primaryClassification &&
      Boolean(updatedHousehold?.primaryClassification?.id);

    if (shouldStoreAutomaticClassification) {
      const autoProfile =
        profile ||
        existingProfile ||
        new HouseholdProfile({
          houseName: nextHouseName,
          createdBy: actorUserId,
        });

      autoProfile.houseName = nextHouseName;
      autoProfile.manualPrimaryClassificationId = updatedHousehold.primaryClassification.id;
      autoProfile.updatedBy = actorUserId;
      await autoProfile.save();
      updatedHousehold = await this.getHouseholdByName(nextHouseName);
    }

    await Promise.all(
      members.map(async (member) => {
        try {
          const memberId = String(member._id);
          await redisClient.del(CACHE_KEYS.USER_PROFILE(memberId));
          await redisClient.del(CACHE_KEYS.USER_PERMISSIONS(memberId));
        } catch (_error) {
          // Non-fatal cache miss.
        }
      })
    );

    return updatedHousehold;
  }

  async getHouseholdSummaryForUser(user) {
    if (!user) return null;

    const [categories, users] = await Promise.all([
      this._loadActiveCategoriesForEvaluation(),
      this._loadUsersForEvaluation(),
    ]);

    const seed = createHouseholdSeed(user);
    if (!seed) return null;
    const profile = await HouseholdProfile.findOne({ householdKey: seed.householdKey }).lean();
    const categoryMap = new Map(categories.map((category) => [String(category._id), category]));
    const snapshot = buildHouseholdSnapshots(users).find(
      (entry) => entry.householdKey === seed.householdKey
    );

    if (!snapshot) return null;

    return this._applyHouseholdProfileToEvaluation(
      evaluateHouseholdSnapshot(snapshot, categories),
      profile,
      categoryMap
    );
  }
}

module.exports = new HouseholdClassificationService();
