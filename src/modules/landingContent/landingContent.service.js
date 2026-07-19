const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { validateImageUpload } = require('../../utils/fileUploads');
const storageService = require('../../services/storage/storage.service');
const User = require('../users/user.model');
const Meeting = require('../meetings/meeting.model');
const ChurchPriest = require('../divineLiturgies/churchPriest.model');
const DivineLiturgyRecurring = require('../divineLiturgies/divineLiturgyRecurring.model');
const DivineLiturgyException = require('../divineLiturgies/divineLiturgyException.model');
const { SERVICE_TYPES } = require('../divineLiturgies/divineLiturgyRecurring.model');
const LandingContent = require('./landingContent.model');
const {
  LANDING_CONTENT_DOCUMENT_KEY,
  LANDING_STAT_SOURCE_TYPES,
  LANDING_SYSTEM_STAT_KEYS,
  LANDING_STAT_ITEM_IDS,
  LANDING_DEFAULT_STAT_ITEMS,
  LANDING_SOCIAL_PLATFORMS,
} = require('./landingContent.constants');

class LandingContentService {
  _isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  _normalizeText(value, maxLength = 5000) {
    if (typeof value !== 'string') return '';
    const normalized = value.trim();
    return normalized.slice(0, maxLength);
  }

  _normalizeTextTree(value, depth = 0) {
    if (!this._isPlainObject(value) || depth > 12) return {};

    const next = {};
    Object.entries(value).forEach(([key, childValue]) => {
      const normalizedKey = this._normalizeText(key, 120);
      if (!normalizedKey) return;

      if (typeof childValue === 'string') {
        next[normalizedKey] = this._normalizeText(childValue, 5000);
        return;
      }

      if (this._isPlainObject(childValue)) {
        const normalizedChild = this._normalizeTextTree(childValue, depth + 1);
        if (Object.keys(normalizedChild).length > 0) {
          next[normalizedKey] = normalizedChild;
        }
      }
    });

    return next;
  }

  _normalizeTexts(texts = {}) {
    return {
      en: this._normalizeTextTree(texts?.en),
      ar: this._normalizeTextTree(texts?.ar),
    };
  }

  _normalizeLocalizedText(value = {}, maxLength = 2000) {
    return {
      en: this._normalizeText(value?.en, maxLength),
      ar: this._normalizeText(value?.ar, maxLength),
    };
  }

  _toId(value) {
    if (!value) return null;
    if (typeof value === 'string') return value;
    if (value._id) return String(value._id);
    return String(value);
  }

  _toObjectId(id, fieldName = 'id') {
    const normalizedId = this._toId(id);
    if (!normalizedId || !mongoose.Types.ObjectId.isValid(normalizedId)) {
      throw ApiError.badRequest(`Invalid ${fieldName}`, 'VALIDATION_ERROR');
    }
    return new mongoose.Types.ObjectId(normalizedId);
  }

  _mapUser(userLike) {
    const id = this._toId(userLike);
    if (!id) return null;

    const avatar =
      userLike?.avatar && typeof userLike.avatar === 'object' && userLike.avatar.url
        ? {
            url: userLike.avatar.url,
            storageKey: userLike.avatar.storageKey || null,
          }
        : null;

    return {
      id,
      fullName: userLike?.fullName || null,
      phonePrimary: userLike?.phonePrimary || null,
      avatar,
    };
  }

  _normalizeStatItem(value = {}, defaults = {}) {
    const fallback = defaults || {};
    const sourceType =
      value?.sourceType === LANDING_STAT_SOURCE_TYPES.MANUAL
        ? LANDING_STAT_SOURCE_TYPES.MANUAL
        : LANDING_STAT_SOURCE_TYPES.SYSTEM;

    const sourceKey = Object.values(LANDING_SYSTEM_STAT_KEYS).includes(value?.sourceKey)
      ? value.sourceKey
      : fallback.sourceKey;

    return {
      sourceType,
      sourceKey,
      manualValue: this._normalizeText(value?.manualValue, 120),
    };
  }

  _normalizeStats(stats = {}) {
    return LANDING_STAT_ITEM_IDS.reduce((acc, itemId) => {
      acc[itemId] = this._normalizeStatItem(stats?.[itemId], LANDING_DEFAULT_STAT_ITEMS[itemId]);
      return acc;
    }, {});
  }

  _normalizeLocation(location = {}) {
    return {
      placeName: this._normalizeText(location?.placeName, 240),
      plusCode: this._normalizeText(location?.plusCode, 120),
      addressLine: this._normalizeText(location?.addressLine, 500),
      mapEmbedUrl: this._normalizeText(location?.mapEmbedUrl, 2000),
      directionsUrl: this._normalizeText(location?.directionsUrl, 2000),
    };
  }

  _normalizeSocialLinks(entries = []) {
    const byPlatform = new Map(
      LANDING_SOCIAL_PLATFORMS.map((platform) => [
        platform,
        {
          platform,
          enabled: false,
          url: '',
          handle: '',
        },
      ])
    );

    (entries || []).forEach((entry) => {
      const platform = this._normalizeText(entry?.platform, 80).toLowerCase();
      if (!LANDING_SOCIAL_PLATFORMS.includes(platform)) return;

      byPlatform.set(platform, {
        platform,
        enabled: Boolean(entry?.enabled),
        url: this._normalizeText(entry?.url, 2000),
        handle: this._normalizeText(entry?.handle, 160),
      });
    });

    return LANDING_SOCIAL_PLATFORMS.map((platform) => byPlatform.get(platform));
  }

  _normalizePriestEntries(entries = []) {
    const normalized = [];
    const seen = new Set();

    (entries || []).forEach((entry) => {
      const priestUserId = this._toId(entry?.priestUserId);
      if (!priestUserId || !mongoose.Types.ObjectId.isValid(priestUserId) || seen.has(priestUserId)) {
        return;
      }

      seen.add(priestUserId);
      normalized.push({
        priestUserId: this._toObjectId(priestUserId, 'priestUserId'),
        role: this._normalizeLocalizedText(entry?.role, 240),
        bio: this._normalizeLocalizedText(entry?.bio, 4000),
        alt: this._normalizeLocalizedText(entry?.alt, 240),
      });
    });

    return normalized;
  }

  async _loadDocument() {
    return LandingContent.findOne({ key: LANDING_CONTENT_DOCUMENT_KEY }).lean();
  }

  async _ensureDocument() {
    let document = await LandingContent.findOne({ key: LANDING_CONTENT_DOCUMENT_KEY });
    if (!document) {
      document = await LandingContent.create({ key: LANDING_CONTENT_DOCUMENT_KEY });
    }
    return document;
  }

  async _assertPriestEntriesAllowed(entries = []) {
    if (!entries.length) return;

    const ids = entries.map((entry) => this._toObjectId(entry.priestUserId, 'priestUserId'));
    const allowed = await ChurchPriest.find({ userId: { $in: ids } }).select('userId').lean();
    const allowedSet = new Set(allowed.map((entry) => this._toId(entry.userId)).filter(Boolean));
    const invalid = entries.filter((entry) => !allowedSet.has(this._toId(entry.priestUserId)));

    if (invalid.length > 0) {
      throw ApiError.badRequest(
        'Some priest entries do not belong to the church priests list',
        'VALIDATION_ERROR'
      );
    }
  }

  async _loadChurchPriests() {
    return ChurchPriest.find({})
      .sort({ createdAt: 1, _id: 1 })
      .populate('userId', 'fullName phonePrimary avatar')
      .lean();
  }

  /**
   * Distinct family key for a user, as a MongoDB expression.
   *
   * Mirrors `_normalizeText(user.familyName || user.houseName, 240).toLowerCase()`:
   * JS `||` picks `houseName` whenever `familyName` is absent or an empty string,
   * and `_normalizeText` is `trim()` then `slice(0, 240)` on strings (non-strings
   * collapse to ''). `$strLenCP > 0` reproduces the `||` fallback, including the
   * case where `familyName` is whitespace-only (truthy in JS, so it wins the `||`
   * and then trims away to an empty — and therefore uncounted — key).
   */
  _familyKeyExpression() {
    return {
      $toLower: {
        $substrCP: [
          {
            $trim: {
              input: {
                $let: {
                  vars: {
                    familyName: {
                      $cond: [{ $eq: [{ $type: '$familyName' }, 'string'] }, '$familyName', ''],
                    },
                    houseName: {
                      $cond: [{ $eq: [{ $type: '$houseName' }, 'string'] }, '$houseName', ''],
                    },
                  },
                  in: {
                    $cond: [{ $gt: [{ $strLenCP: '$$familyName' }, 0] }, '$$familyName', '$$houseName'],
                  },
                },
              },
            },
          },
          0,
          240,
        ],
      },
    };
  }

  /**
   * These metrics are counts only, so they are computed inside MongoDB rather
   * than by pulling documents into Node.
   *
   * This backs the PUBLIC landing page, so it runs for every anonymous visitor.
   * It previously fetched every non-deleted user (~6.4k docs) and every meeting
   * document — including each servant's `servedUserIds` / `groupAssignments`
   * arrays — purely to size a couple of `Set`s. The connection to Atlas is
   * throughput-bound, so that transfer, not the query, was the cost. Nothing here
   * is permission-scoped, so aggregating is a straight win with no access
   * implications. See `meetings.service._listMeetingsSummaryAggregate` for the
   * same fix applied to the meetings list.
   */
  async _computeSystemMetrics() {
    const [
      userMetrics,
      churchPriestsCount,
      meetingMetrics,
      recurringDivineLiturgiesCount,
      recurringVespersCount,
      exceptionCount,
    ] = await Promise.all([
      // One document out: total members + distinct family keys.
      User.aggregate([
        { $match: { isDeleted: { $ne: true } } },
        { $group: { _id: this._familyKeyExpression(), members: { $sum: 1 } } },
        {
          $group: {
            _id: null,
            membersTotal: { $sum: '$members' },
            // Empty keys were skipped by the original `if (familyKey)` guard.
            familiesTotal: { $sum: { $cond: [{ $gt: [{ $strLenCP: '$_id' }, 0] }, 1, 0] } },
          },
        },
      ]),
      ChurchPriest.countDocuments({}),
      // One document out: meeting count + distinct servant/leadership user ids.
      Meeting.aggregate([
        { $match: { isDeleted: { $ne: true } } },
        {
          $facet: {
            total: [{ $count: 'value' }],
            servants: [
              {
                $project: {
                  userIds: {
                    $concatArrays: [
                      ['$serviceSecretary.userId'],
                      {
                        $map: {
                          input: { $ifNull: ['$assistantSecretaries', []] },
                          as: 'assistant',
                          in: '$$assistant.userId',
                        },
                      },
                      {
                        $map: {
                          input: { $ifNull: ['$servants', []] },
                          as: 'servant',
                          in: '$$servant.userId',
                        },
                      },
                    ],
                  },
                },
              },
              { $unwind: '$userIds' },
              // Stands in for the original `isValid()` guard: drops missing/null
              // entries and anything that is not a real ObjectId.
              { $match: { userIds: { $type: 'objectId' } } },
              { $group: { _id: '$userIds' } },
              { $count: 'value' },
            ],
          },
        },
      ]),
      DivineLiturgyRecurring.countDocuments({ serviceType: SERVICE_TYPES.DIVINE_LITURGY }),
      DivineLiturgyRecurring.countDocuments({ serviceType: SERVICE_TYPES.VESPERS }),
      DivineLiturgyException.countDocuments({}),
    ]);

    const users = {
      total: userMetrics?.[0]?.membersTotal || 0,
      families: userMetrics?.[0]?.familiesTotal || 0,
    };
    const meetingsCount = meetingMetrics?.[0]?.total?.[0]?.value || 0;
    const servantsCount = meetingMetrics?.[0]?.servants?.[0]?.value || 0;

    return {
      [LANDING_SYSTEM_STAT_KEYS.FAMILIES_TOTAL]: users.families,
      [LANDING_SYSTEM_STAT_KEYS.MEMBERS_TOTAL]: users.total,
      [LANDING_SYSTEM_STAT_KEYS.CHURCH_PRIESTS_TOTAL]: churchPriestsCount,
      [LANDING_SYSTEM_STAT_KEYS.MEETINGS_TOTAL]: meetingsCount,
      [LANDING_SYSTEM_STAT_KEYS.DIVINE_LITURGIES_TOTAL]:
        recurringDivineLiturgiesCount + exceptionCount,
      [LANDING_SYSTEM_STAT_KEYS.VESPERS_TOTAL]: recurringVespersCount,
      [LANDING_SYSTEM_STAT_KEYS.SERVICES_TOTAL]:
        meetingsCount + recurringDivineLiturgiesCount + recurringVespersCount + exceptionCount,
      [LANDING_SYSTEM_STAT_KEYS.SERVANTS_TOTAL]: servantsCount,
    };
  }

  _buildSystemStatOptions(systemMetrics = {}) {
    return [
      {
        key: LANDING_SYSTEM_STAT_KEYS.FAMILIES_TOTAL,
        label: 'Families',
        value: String(systemMetrics[LANDING_SYSTEM_STAT_KEYS.FAMILIES_TOTAL] ?? 0),
      },
      {
        key: LANDING_SYSTEM_STAT_KEYS.MEMBERS_TOTAL,
        label: 'Members',
        value: String(systemMetrics[LANDING_SYSTEM_STAT_KEYS.MEMBERS_TOTAL] ?? 0),
      },
      {
        key: LANDING_SYSTEM_STAT_KEYS.CHURCH_PRIESTS_TOTAL,
        label: 'Church priests',
        value: String(systemMetrics[LANDING_SYSTEM_STAT_KEYS.CHURCH_PRIESTS_TOTAL] ?? 0),
      },
      {
        key: LANDING_SYSTEM_STAT_KEYS.MEETINGS_TOTAL,
        label: 'Meetings',
        value: String(systemMetrics[LANDING_SYSTEM_STAT_KEYS.MEETINGS_TOTAL] ?? 0),
      },
      {
        key: LANDING_SYSTEM_STAT_KEYS.DIVINE_LITURGIES_TOTAL,
        label: 'Divine liturgies',
        value: String(systemMetrics[LANDING_SYSTEM_STAT_KEYS.DIVINE_LITURGIES_TOTAL] ?? 0),
      },
      {
        key: LANDING_SYSTEM_STAT_KEYS.VESPERS_TOTAL,
        label: 'Vespers',
        value: String(systemMetrics[LANDING_SYSTEM_STAT_KEYS.VESPERS_TOTAL] ?? 0),
      },
      {
        key: LANDING_SYSTEM_STAT_KEYS.SERVICES_TOTAL,
        label: 'All services',
        value: String(systemMetrics[LANDING_SYSTEM_STAT_KEYS.SERVICES_TOTAL] ?? 0),
      },
      {
        key: LANDING_SYSTEM_STAT_KEYS.SERVANTS_TOTAL,
        label: 'Servants',
        value: String(systemMetrics[LANDING_SYSTEM_STAT_KEYS.SERVANTS_TOTAL] ?? 0),
      },
    ];
  }

  _buildResolvedStats(stats = {}, systemMetrics = {}) {
    return LANDING_STAT_ITEM_IDS.map((itemId) => {
      const current = this._normalizeStatItem(stats?.[itemId], LANDING_DEFAULT_STAT_ITEMS[itemId]);
      const systemValue = String(systemMetrics[current.sourceKey] ?? 0);

      return {
        id: itemId,
        sourceType: current.sourceType,
        sourceKey: current.sourceKey,
        manualValue: current.manualValue,
        systemValue,
        resolvedValue:
          current.sourceType === LANDING_STAT_SOURCE_TYPES.MANUAL && current.manualValue
            ? current.manualValue
            : systemValue,
      };
    });
  }

  _buildPriests(churchPriests = [], priestEntries = []) {
    const priestEntriesMap = new Map(
      (priestEntries || []).map((entry) => [this._toId(entry?.priestUserId), entry])
    );

    return churchPriests
      .map((entry) => {
        const user = this._mapUser(entry?.userId);
        if (!user?.id) return null;

        const matchingEntry = priestEntriesMap.get(user.id) || {};
        return {
          churchPriestId: this._toId(entry?._id),
          priestUserId: user.id,
          user,
          role: this._normalizeLocalizedText(matchingEntry?.role, 240),
          bio: this._normalizeLocalizedText(matchingEntry?.bio, 4000),
          alt: this._normalizeLocalizedText(matchingEntry?.alt, 240),
        };
      })
      .filter(Boolean);
  }

  async _buildPayload(document = null) {
    const [churchPriests, systemMetrics] = await Promise.all([
      this._loadChurchPriests(),
      this._computeSystemMetrics(),
    ]);

    const normalizedTexts = this._normalizeTexts(document?.texts);
    const normalizedStats = this._normalizeStats(document?.stats);
    const normalizedLocation = this._normalizeLocation(document?.location);
    const normalizedSocialLinks = this._normalizeSocialLinks(document?.socialLinks);
    const priests = this._buildPriests(churchPriests, document?.priestEntries || []);

    return {
      texts: normalizedTexts,
      heroImage:
        document?.heroImage && document.heroImage.url
          ? {
              url: document.heroImage.url,
              storageKey: document.heroImage.storageKey || null,
              provider: document.heroImage.provider || 'r2',
              mimeType: document.heroImage.mimeType || '',
              size: document.heroImage.size || 0,
            }
          : null,
      stats: {
        items: this._buildResolvedStats(normalizedStats, systemMetrics),
        settings: normalizedStats,
        systemMetrics,
        systemStatOptions: this._buildSystemStatOptions(systemMetrics),
      },
      priests,
      location: normalizedLocation,
      socialLinks: normalizedSocialLinks,
      updatedAt: document?.updatedAt || null,
      createdAt: document?.createdAt || null,
    };
  }

  async getPublicContent() {
    const document = await this._loadDocument();
    const payload = await this._buildPayload(document);

    return {
      texts: payload.texts,
      heroImage: payload.heroImage,
      stats: {
        items: payload.stats.items,
      },
      priests: payload.priests,
      location: payload.location,
      socialLinks: payload.socialLinks,
      updatedAt: payload.updatedAt,
    };
  }

  async getManageContent() {
    const document = await this._loadDocument();
    return this._buildPayload(document);
  }

  async updateContent(payload = {}, actorUserId) {
    const document = await this._ensureDocument();
    const texts = this._normalizeTexts(payload?.texts);
    const stats = this._normalizeStats(payload?.stats);
    const priestEntries = this._normalizePriestEntries(payload?.priestEntries);
    const location = this._normalizeLocation(payload?.location);
    const socialLinks = this._normalizeSocialLinks(payload?.socialLinks);

    await this._assertPriestEntriesAllowed(priestEntries);

    document.texts = texts;
    document.stats = stats;
    document.priestEntries = priestEntries;
    document.location = location;
    document.socialLinks = socialLinks;
    document.updatedBy = this._toObjectId(actorUserId, 'actorUserId');
    if (!document.createdBy) {
      document.createdBy = this._toObjectId(actorUserId, 'actorUserId');
    }

    await document.save();

    return this.getManageContent();
  }

  async uploadHeroImage(file, actorUserId) {
    const fileDetails = validateImageUpload(file, { emptyLabel: 'image' });
    const uploadResult = await storageService.uploadFile(file, {
      prefix: 'landing/hero',
      fileDetails,
      failureMessage: 'Failed to upload hero image',
    });

    const document = await this._ensureDocument();
    const previousStorageKey = document?.heroImage?.storageKey || null;

    document.heroImage = {
      url: uploadResult.url,
      storageKey: uploadResult.storageKey,
      provider: uploadResult.provider,
      mimeType: uploadResult.mimeType,
      size: uploadResult.size,
    };
    document.updatedBy = this._toObjectId(actorUserId, 'actorUserId');
    if (!document.createdBy) {
      document.createdBy = this._toObjectId(actorUserId, 'actorUserId');
    }

    await document.save();

    if (previousStorageKey && previousStorageKey !== uploadResult.storageKey) {
      await storageService.deleteFile(previousStorageKey);
    }

    return {
      url: uploadResult.url,
      storageKey: uploadResult.storageKey,
      provider: uploadResult.provider,
      mimeType: uploadResult.mimeType,
      size: uploadResult.size,
    };
  }

  async deleteHeroImage(actorUserId) {
    const document = await this._ensureDocument();
    const previousStorageKey = document?.heroImage?.storageKey || null;

    if (previousStorageKey) {
      await storageService.deleteFile(previousStorageKey);
    }

    document.heroImage = undefined;
    document.updatedBy = this._toObjectId(actorUserId, 'actorUserId');
    if (!document.createdBy) {
      document.createdBy = this._toObjectId(actorUserId, 'actorUserId');
    }

    await document.save();

    return null;
  }
}

module.exports = new LandingContentService();
