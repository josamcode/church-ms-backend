const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { PERMISSIONS } = require('../../constants/permissions');
const ArchiveContent = require('./archive.model');
const {
  uploadBufferToCloudinary,
  validateImageUpload,
} = require('../../utils/fileUploads');
const {
  ARCHIVE_DOCUMENT_KEY,
  ARCHIVE_STATUSES,
} = require('./archive.constants');

class ArchiveService {
  _canViewDraftContent(actorPermissions = []) {
    return [
      PERMISSIONS.ARCHIVE_COLLECTIONS_MANAGE,
      PERMISSIONS.ARCHIVE_STORIES_MANAGE,
      PERMISSIONS.ARCHIVE_HONOREES_MANAGE,
      PERMISSIONS.ARCHIVE_PUBLISH,
    ].some((permission) =>
      Array.isArray(actorPermissions) && actorPermissions.includes(permission)
    );
  }

  _normalizeText(value, maxLength = 500) {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, maxLength);
  }

  _requireText(value, fieldLabel, maxLength = 160) {
    const normalized = this._normalizeText(value, maxLength);
    if (!normalized) {
      throw ApiError.badRequest(`${fieldLabel} is required`, 'VALIDATION_ERROR');
    }
    return normalized;
  }

  _slugify(value) {
    const normalized = this._normalizeText(value, 200)
      .toLowerCase()
      .replace(/['"]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    return normalized || `entry-${Date.now()}`;
  }

  _toId(value) {
    if (!value) return null;
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (typeof value === 'object') {
      if (value._id != null) return String(value._id);
      if (value.id != null) return String(value.id);
    }
    return String(value);
  }

  _toObjectId(value, fieldName = 'id') {
    const id = this._toId(value);
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      throw ApiError.badRequest(`Invalid ${fieldName}`, 'VALIDATION_ERROR');
    }
    return new mongoose.Types.ObjectId(id);
  }

  _normalizeStatus(value) {
    return value === ARCHIVE_STATUSES.PUBLISHED
      ? ARCHIVE_STATUSES.PUBLISHED
      : ARCHIVE_STATUSES.DRAFT;
  }

  _normalizePhotos(photos = []) {
    const normalized = [];
    const seen = new Set();

    (Array.isArray(photos) ? photos : []).forEach((entry) => {
      const url = this._normalizeText(entry?.url, 2000);
      if (!url) return;

      const publicId = this._normalizeText(entry?.publicId, 400) || null;
      const dedupeKey = publicId || url;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);

      normalized.push({
        url,
        publicId,
        caption: this._normalizeText(entry?.caption, 240),
      });
    });

    return normalized;
  }

  _normalizeOptionalDate(value, fieldName) {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;

    const nextDate = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(nextDate.getTime())) {
      throw ApiError.badRequest(`Invalid ${fieldName}`, 'VALIDATION_ERROR');
    }

    return nextDate;
  }

  _ensureUniqueSlug(entries = [], desiredSlug, currentId = null) {
    const baseSlug = this._slugify(desiredSlug);
    const currentIdValue = this._toId(currentId);
    const existingSlugs = new Set(
      (entries || [])
        .filter((entry) => this._toId(entry?._id) !== currentIdValue)
        .map((entry) => this._normalizeText(entry?.slug, 200).toLowerCase())
        .filter(Boolean)
    );

    let candidate = baseSlug;
    let suffix = 2;

    while (existingSlugs.has(candidate)) {
      candidate = `${baseSlug}-${suffix}`;
      suffix += 1;
    }

    return candidate;
  }

  _formatDate(value) {
    if (!value) return null;
    const nextDate = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(nextDate.getTime())) return null;
    return nextDate.toISOString().slice(0, 10);
  }

  _collectPhotoPublicIds(photos = []) {
    return (Array.isArray(photos) ? photos : [])
      .map((entry) => this._normalizeText(entry?.publicId, 400))
      .filter(Boolean);
  }

  _collectRemovedPhotoPublicIds(currentPhotos = [], nextPhotos = []) {
    const nextIds = new Set(this._collectPhotoPublicIds(nextPhotos));
    return this._collectPhotoPublicIds(currentPhotos).filter((publicId) => !nextIds.has(publicId));
  }

  async _destroyAssets(publicIds = []) {
    const uniqueIds = [...new Set((publicIds || []).filter(Boolean))];
    if (!uniqueIds.length) return;

    await Promise.allSettled(
      uniqueIds.map(async (publicId) => {
        try {
          await cloudinary.uploader.destroy(publicId);
        } catch (error) {
          logger.warn(`Archive asset cleanup failed for ${publicId}: ${error.message}`);
        }
      })
    );
  }

  _assertPublishPermission(actorPermissions = []) {
    if (!Array.isArray(actorPermissions) || !actorPermissions.includes(PERMISSIONS.ARCHIVE_PUBLISH)) {
      throw ApiError.forbidden(
        'Archive publish permission is required for published content',
        'PERMISSION_DENIED'
      );
    }
  }

  _assertStatusAllowed(status, actorPermissions = []) {
    if (status === ARCHIVE_STATUSES.PUBLISHED) {
      this._assertPublishPermission(actorPermissions);
    }
  }

  _assertItemMutationAllowed(item, actorPermissions = []) {
    if (item?.status === ARCHIVE_STATUSES.PUBLISHED) {
      this._assertPublishPermission(actorPermissions);
    }
  }

  _prepareDocumentAudit(document, actorObjectId) {
    document.updatedBy = actorObjectId;
    if (!document.createdBy) {
      document.createdBy = actorObjectId;
    }
  }

  async _ensureDocument() {
    let document = await ArchiveContent.findOne({ key: ARCHIVE_DOCUMENT_KEY });
    if (!document) {
      document = await ArchiveContent.create({ key: ARCHIVE_DOCUMENT_KEY });
    }
    return document;
  }

  _resolveCollectionId(document, collectionId, { optional = true } = {}) {
    if (collectionId === undefined) {
      return undefined;
    }

    if (collectionId === null || collectionId === '') {
      if (optional) return null;
      throw ApiError.badRequest('Archive collection is required', 'VALIDATION_ERROR');
    }

    const id = this._toId(collectionId);
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      throw ApiError.badRequest('Invalid archive collection id', 'VALIDATION_ERROR');
    }

    const collection = document.collections.id(id);
    if (!collection) {
      throw ApiError.notFound('Archive collection not found', 'RESOURCE_NOT_FOUND');
    }

    return collection._id;
  }

  _buildCollectionCounts(items = []) {
    const counts = new Map();

    (items || []).forEach((item) => {
      const collectionId = this._toId(item?.collectionId);
      if (!collectionId) return;
      counts.set(collectionId, (counts.get(collectionId) || 0) + 1);
    });

    return counts;
  }

  _mapPhotos(photos = []) {
    return this._normalizePhotos(photos);
  }

  _mapCollection(collection, storyCounts, honoreeCounts) {
    const id = this._toId(collection?._id);

    return {
      id,
      title: collection?.title || '',
      slug: collection?.slug || '',
      description: collection?.description || '',
      narrative: collection?.narrative || '',
      photos: this._mapPhotos(collection?.photos),
      status: collection?.status || ARCHIVE_STATUSES.DRAFT,
      storyCount: storyCounts.get(id) || 0,
      honoreeCount: honoreeCounts.get(id) || 0,
      createdAt: collection?.createdAt || null,
      updatedAt: collection?.updatedAt || null,
    };
  }

  _mapStory(story, collectionMap) {
    const collectionId = this._toId(story?.collectionId);
    const collection = collectionId ? collectionMap.get(collectionId) : null;

    return {
      id: this._toId(story?._id),
      title: story?.title || '',
      slug: story?.slug || '',
      summary: story?.summary || '',
      narrative: story?.narrative || '',
      collectionId,
      collectionTitle: collection?.title || null,
      photos: this._mapPhotos(story?.photos),
      eventDate: this._formatDate(story?.eventDate),
      status: story?.status || ARCHIVE_STATUSES.DRAFT,
      createdAt: story?.createdAt || null,
      updatedAt: story?.updatedAt || null,
    };
  }

  _mapHonoree(honoree, collectionMap) {
    const collectionId = this._toId(honoree?.collectionId);
    const collection = collectionId ? collectionMap.get(collectionId) : null;

    return {
      id: this._toId(honoree?._id),
      fullName: honoree?.fullName || '',
      honorTitle: honoree?.honorTitle || '',
      summary: honoree?.summary || '',
      narrative: honoree?.narrative || '',
      collectionId,
      collectionTitle: collection?.title || null,
      photos: this._mapPhotos(honoree?.photos),
      honorDate: this._formatDate(honoree?.honorDate),
      status: honoree?.status || ARCHIVE_STATUSES.DRAFT,
      createdAt: honoree?.createdAt || null,
      updatedAt: honoree?.updatedAt || null,
    };
  }

  _sortCollections(collections = []) {
    return [...collections].sort((a, b) => {
      const dateDiff =
        new Date(b?.updatedAt || b?.createdAt || 0).getTime() -
        new Date(a?.updatedAt || a?.createdAt || 0).getTime();
      if (dateDiff !== 0) return dateDiff;
      return String(a?.title || '').localeCompare(String(b?.title || ''));
    });
  }

  _sortStories(stories = []) {
    return [...stories].sort((a, b) => {
      const dateDiff =
        new Date(b?.eventDate || b?.updatedAt || b?.createdAt || 0).getTime() -
        new Date(a?.eventDate || a?.updatedAt || a?.createdAt || 0).getTime();
      if (dateDiff !== 0) return dateDiff;
      return String(a?.title || '').localeCompare(String(b?.title || ''));
    });
  }

  _sortHonorees(honorees = []) {
    return [...honorees].sort((a, b) => {
      const dateDiff =
        new Date(b?.honorDate || b?.updatedAt || b?.createdAt || 0).getTime() -
        new Date(a?.honorDate || a?.updatedAt || a?.createdAt || 0).getTime();
      if (dateDiff !== 0) return dateDiff;
      return String(a?.fullName || '').localeCompare(String(b?.fullName || ''));
    });
  }

  _buildPayload(document, { publicOnly = false } = {}) {
    const collectionsSource = publicOnly
      ? document.collections.filter((entry) => entry.status === ARCHIVE_STATUSES.PUBLISHED)
      : document.collections;
    const storiesSource = publicOnly
      ? document.stories.filter((entry) => entry.status === ARCHIVE_STATUSES.PUBLISHED)
      : document.stories;
    const honoreesSource = publicOnly
      ? document.honorees.filter((entry) => entry.status === ARCHIVE_STATUSES.PUBLISHED)
      : document.honorees;

    const storyCounts = this._buildCollectionCounts(storiesSource);
    const honoreeCounts = this._buildCollectionCounts(honoreesSource);
    const collectionMap = new Map(
      collectionsSource.map((entry) => [this._toId(entry?._id), entry])
    );

    const collections = this._sortCollections(
      collectionsSource.map((entry) => this._mapCollection(entry, storyCounts, honoreeCounts))
    );
    const stories = this._sortStories(
      storiesSource.map((entry) => this._mapStory(entry, collectionMap))
    );
    const honorees = this._sortHonorees(
      honoreesSource.map((entry) => this._mapHonoree(entry, collectionMap))
    );

    return {
      collections,
      stories,
      honorees,
      counts: {
        collections: collections.length,
        stories: stories.length,
        honorees: honorees.length,
        publishedCollections: collections.filter((entry) => entry.status === ARCHIVE_STATUSES.PUBLISHED).length,
        publishedStories: stories.filter((entry) => entry.status === ARCHIVE_STATUSES.PUBLISHED).length,
        publishedHonorees: honorees.filter((entry) => entry.status === ARCHIVE_STATUSES.PUBLISHED).length,
      },
      updatedAt: document?.updatedAt || null,
      createdAt: document?.createdAt || null,
    };
  }

  async getPublicContent() {
    const document = await this._ensureDocument();
    return this._buildPayload(document, { publicOnly: true });
  }

  async getManageContent(actorPermissions = []) {
    const document = await this._ensureDocument();
    return this._buildPayload(document, {
      publicOnly: !this._canViewDraftContent(actorPermissions),
    });
  }

  async uploadImage(file) {
    validateImageUpload(file, { emptyLabel: 'image' });

    const uploadResult = await uploadBufferToCloudinary(
      file,
      {
        folder: 'church/archive/images',
        resource_type: 'image',
      },
      'Failed to upload archive image'
    );

    return {
      url: uploadResult.secure_url,
      publicId: uploadResult.public_id,
      caption: '',
    };
  }

  async createCollection(payload = {}, actorUserId, actorPermissions = []) {
    const document = await this._ensureDocument();
    const actorObjectId = this._toObjectId(actorUserId, 'actorUserId');
    const status = this._normalizeStatus(payload?.status);

    this._assertStatusAllowed(status, actorPermissions);

    document.collections.push({
      title: this._requireText(payload?.title, 'Collection title', 160),
      slug: this._ensureUniqueSlug(document.collections, payload?.slug || payload?.title),
      description: this._normalizeText(payload?.description, 500),
      narrative: this._normalizeText(payload?.narrative, 10000),
      photos: this._normalizePhotos(payload?.photos),
      status,
      createdBy: actorObjectId,
      updatedBy: actorObjectId,
    });

    this._prepareDocumentAudit(document, actorObjectId);
    await document.save();

    return this._buildPayload(document);
  }

  async updateCollection(collectionId, payload = {}, actorUserId, actorPermissions = []) {
    const document = await this._ensureDocument();
    const collection = document.collections.id(collectionId);

    if (!collection) {
      throw ApiError.notFound('Archive collection not found', 'RESOURCE_NOT_FOUND');
    }

    this._assertItemMutationAllowed(collection, actorPermissions);

    const actorObjectId = this._toObjectId(actorUserId, 'actorUserId');
    const nextStatus =
      payload?.status !== undefined ? this._normalizeStatus(payload.status) : collection.status;

    this._assertStatusAllowed(nextStatus, actorPermissions);

    const currentPhotos = this._mapPhotos(collection.photos);

    if (payload?.title !== undefined) {
      collection.title = this._requireText(payload.title, 'Collection title', 160);
    }
    if (payload?.slug !== undefined) {
      collection.slug = this._ensureUniqueSlug(
        document.collections,
        payload.slug || collection.title,
        collection._id
      );
    }
    if (payload?.description !== undefined) {
      collection.description = this._normalizeText(payload.description, 500);
    }
    if (payload?.narrative !== undefined) {
      collection.narrative = this._normalizeText(payload.narrative, 10000);
    }
    if (payload?.photos !== undefined) {
      collection.photos = this._normalizePhotos(payload.photos);
    }

    collection.status = nextStatus;
    collection.updatedBy = actorObjectId;

    this._prepareDocumentAudit(document, actorObjectId);
    await document.save();

    if (payload?.photos !== undefined) {
      await this._destroyAssets(
        this._collectRemovedPhotoPublicIds(currentPhotos, collection.photos)
      );
    }

    return this._buildPayload(document);
  }

  async deleteCollection(collectionId, actorUserId, actorPermissions = []) {
    const document = await this._ensureDocument();
    const collection = document.collections.id(collectionId);

    if (!collection) {
      throw ApiError.notFound('Archive collection not found', 'RESOURCE_NOT_FOUND');
    }

    this._assertItemMutationAllowed(collection, actorPermissions);

    const relatedPublishedItems =
      document.stories.some(
        (entry) =>
          this._toId(entry?.collectionId) === collectionId &&
          entry?.status === ARCHIVE_STATUSES.PUBLISHED
      ) ||
      document.honorees.some(
        (entry) =>
          this._toId(entry?.collectionId) === collectionId &&
          entry?.status === ARCHIVE_STATUSES.PUBLISHED
      );

    if (relatedPublishedItems) {
      this._assertPublishPermission(actorPermissions);
    }

    const actorObjectId = this._toObjectId(actorUserId, 'actorUserId');
    const photoPublicIds = this._collectPhotoPublicIds(collection.photos);

    document.stories.forEach((entry) => {
      if (this._toId(entry?.collectionId) === collectionId) {
        entry.collectionId = null;
        entry.updatedBy = actorObjectId;
      }
    });

    document.honorees.forEach((entry) => {
      if (this._toId(entry?.collectionId) === collectionId) {
        entry.collectionId = null;
        entry.updatedBy = actorObjectId;
      }
    });

    collection.deleteOne();

    this._prepareDocumentAudit(document, actorObjectId);
    await document.save();
    await this._destroyAssets(photoPublicIds);

    return this._buildPayload(document);
  }

  async createStory(payload = {}, actorUserId, actorPermissions = []) {
    const document = await this._ensureDocument();
    const actorObjectId = this._toObjectId(actorUserId, 'actorUserId');
    const status = this._normalizeStatus(payload?.status);

    this._assertStatusAllowed(status, actorPermissions);

    document.stories.push({
      title: this._requireText(payload?.title, 'Story title', 160),
      slug: this._ensureUniqueSlug(document.stories, payload?.slug || payload?.title),
      summary: this._normalizeText(payload?.summary, 500),
      narrative: this._normalizeText(payload?.narrative, 10000),
      collectionId: this._resolveCollectionId(document, payload?.collectionId),
      photos: this._normalizePhotos(payload?.photos),
      eventDate: this._normalizeOptionalDate(payload?.eventDate, 'eventDate') ?? null,
      status,
      createdBy: actorObjectId,
      updatedBy: actorObjectId,
    });

    this._prepareDocumentAudit(document, actorObjectId);
    await document.save();

    return this._buildPayload(document);
  }

  async updateStory(storyId, payload = {}, actorUserId, actorPermissions = []) {
    const document = await this._ensureDocument();
    const story = document.stories.id(storyId);

    if (!story) {
      throw ApiError.notFound('Archive story not found', 'RESOURCE_NOT_FOUND');
    }

    this._assertItemMutationAllowed(story, actorPermissions);

    const actorObjectId = this._toObjectId(actorUserId, 'actorUserId');
    const nextStatus =
      payload?.status !== undefined ? this._normalizeStatus(payload.status) : story.status;

    this._assertStatusAllowed(nextStatus, actorPermissions);

    const currentPhotos = this._mapPhotos(story.photos);

    if (payload?.title !== undefined) {
      story.title = this._requireText(payload.title, 'Story title', 160);
    }
    if (payload?.slug !== undefined) {
      story.slug = this._ensureUniqueSlug(document.stories, payload.slug || story.title, story._id);
    }
    if (payload?.summary !== undefined) {
      story.summary = this._normalizeText(payload.summary, 500);
    }
    if (payload?.narrative !== undefined) {
      story.narrative = this._normalizeText(payload.narrative, 10000);
    }
    if (payload?.collectionId !== undefined) {
      story.collectionId = this._resolveCollectionId(document, payload.collectionId);
    }
    if (payload?.photos !== undefined) {
      story.photos = this._normalizePhotos(payload.photos);
    }
    if (payload?.eventDate !== undefined) {
      story.eventDate = this._normalizeOptionalDate(payload.eventDate, 'eventDate');
    }

    story.status = nextStatus;
    story.updatedBy = actorObjectId;

    this._prepareDocumentAudit(document, actorObjectId);
    await document.save();

    if (payload?.photos !== undefined) {
      await this._destroyAssets(this._collectRemovedPhotoPublicIds(currentPhotos, story.photos));
    }

    return this._buildPayload(document);
  }

  async deleteStory(storyId, actorUserId, actorPermissions = []) {
    const document = await this._ensureDocument();
    const story = document.stories.id(storyId);

    if (!story) {
      throw ApiError.notFound('Archive story not found', 'RESOURCE_NOT_FOUND');
    }

    this._assertItemMutationAllowed(story, actorPermissions);

    const actorObjectId = this._toObjectId(actorUserId, 'actorUserId');
    const photoPublicIds = this._collectPhotoPublicIds(story.photos);

    story.deleteOne();

    this._prepareDocumentAudit(document, actorObjectId);
    await document.save();
    await this._destroyAssets(photoPublicIds);

    return this._buildPayload(document);
  }

  async createHonoree(payload = {}, actorUserId, actorPermissions = []) {
    const document = await this._ensureDocument();
    const actorObjectId = this._toObjectId(actorUserId, 'actorUserId');
    const status = this._normalizeStatus(payload?.status);

    this._assertStatusAllowed(status, actorPermissions);

    document.honorees.push({
      fullName: this._requireText(payload?.fullName, 'Honoree name', 160),
      honorTitle: this._normalizeText(payload?.honorTitle, 200),
      summary: this._normalizeText(payload?.summary, 500),
      narrative: this._normalizeText(payload?.narrative, 10000),
      collectionId: this._resolveCollectionId(document, payload?.collectionId),
      photos: this._normalizePhotos(payload?.photos),
      honorDate: this._normalizeOptionalDate(payload?.honorDate, 'honorDate') ?? null,
      status,
      createdBy: actorObjectId,
      updatedBy: actorObjectId,
    });

    this._prepareDocumentAudit(document, actorObjectId);
    await document.save();

    return this._buildPayload(document);
  }

  async updateHonoree(honoreeId, payload = {}, actorUserId, actorPermissions = []) {
    const document = await this._ensureDocument();
    const honoree = document.honorees.id(honoreeId);

    if (!honoree) {
      throw ApiError.notFound('Honoree entry not found', 'RESOURCE_NOT_FOUND');
    }

    this._assertItemMutationAllowed(honoree, actorPermissions);

    const actorObjectId = this._toObjectId(actorUserId, 'actorUserId');
    const nextStatus =
      payload?.status !== undefined ? this._normalizeStatus(payload.status) : honoree.status;

    this._assertStatusAllowed(nextStatus, actorPermissions);

    const currentPhotos = this._mapPhotos(honoree.photos);

    if (payload?.fullName !== undefined) {
      honoree.fullName = this._requireText(payload.fullName, 'Honoree name', 160);
    }
    if (payload?.honorTitle !== undefined) {
      honoree.honorTitle = this._normalizeText(payload.honorTitle, 200);
    }
    if (payload?.summary !== undefined) {
      honoree.summary = this._normalizeText(payload.summary, 500);
    }
    if (payload?.narrative !== undefined) {
      honoree.narrative = this._normalizeText(payload.narrative, 10000);
    }
    if (payload?.collectionId !== undefined) {
      honoree.collectionId = this._resolveCollectionId(document, payload.collectionId);
    }
    if (payload?.photos !== undefined) {
      honoree.photos = this._normalizePhotos(payload.photos);
    }
    if (payload?.honorDate !== undefined) {
      honoree.honorDate = this._normalizeOptionalDate(payload.honorDate, 'honorDate');
    }

    honoree.status = nextStatus;
    honoree.updatedBy = actorObjectId;

    this._prepareDocumentAudit(document, actorObjectId);
    await document.save();

    if (payload?.photos !== undefined) {
      await this._destroyAssets(this._collectRemovedPhotoPublicIds(currentPhotos, honoree.photos));
    }

    return this._buildPayload(document);
  }

  async deleteHonoree(honoreeId, actorUserId, actorPermissions = []) {
    const document = await this._ensureDocument();
    const honoree = document.honorees.id(honoreeId);

    if (!honoree) {
      throw ApiError.notFound('Honoree entry not found', 'RESOURCE_NOT_FOUND');
    }

    this._assertItemMutationAllowed(honoree, actorPermissions);

    const actorObjectId = this._toObjectId(actorUserId, 'actorUserId');
    const photoPublicIds = this._collectPhotoPublicIds(honoree.photos);

    honoree.deleteOne();

    this._prepareDocumentAudit(document, actorObjectId);
    await document.save();
    await this._destroyAssets(photoPublicIds);

    return this._buildPayload(document);
  }
}

module.exports = new ArchiveService();
