const mongoose = require('mongoose');

const buildCursorQuery = (cursor, sort = 'createdAt', order = 'desc') => {
  if (!cursor) return {};

  const operator = order === 'desc' ? '$lt' : '$gt';

  if (sort === 'createdAt' || sort === 'updatedAt' || sort === 'birthDate') {
    return { [sort]: { [operator]: new Date(cursor) } };
  }

  if (mongoose.Types.ObjectId.isValid(cursor)) {
    return { _id: { [operator]: new mongoose.Types.ObjectId(cursor) } };
  }

  return { [sort]: { [operator]: cursor } };
};

const buildPaginationMeta = (items, limit, sort = 'createdAt') => {
  const hasMore = items.length === limit;
  let nextCursor = null;

  if (hasMore && items.length > 0) {
    const lastItem = items[items.length - 1];
    if (sort === 'createdAt' || sort === 'updatedAt' || sort === 'birthDate') {
      nextCursor = lastItem[sort] ? new Date(lastItem[sort]).toISOString() : null;
    } else {
      nextCursor = lastItem._id ? String(lastItem._id) : null;
    }
  }

  return {
    limit,
    hasMore,
    nextCursor,
    count: items.length,
  };
};

module.exports = { buildCursorQuery, buildPaginationMeta };
