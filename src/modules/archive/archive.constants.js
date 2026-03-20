const ARCHIVE_DOCUMENT_KEY = 'archive-content';

const ARCHIVE_STATUSES = Object.freeze({
  DRAFT: 'draft',
  PUBLISHED: 'published',
});

const ARCHIVE_STATUSES_ARRAY = Object.freeze(Object.values(ARCHIVE_STATUSES));

module.exports = {
  ARCHIVE_DOCUMENT_KEY,
  ARCHIVE_STATUSES,
  ARCHIVE_STATUSES_ARRAY,
};
