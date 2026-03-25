const ACCOUNT_STATUSES = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
});

const ACCOUNT_STATUSES_ARRAY = Object.freeze(Object.values(ACCOUNT_STATUSES));

module.exports = {
  ACCOUNT_STATUSES,
  ACCOUNT_STATUSES_ARRAY,
};
