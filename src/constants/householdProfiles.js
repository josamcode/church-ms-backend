const EMPLOYMENT_STATUSES = Object.freeze({
  EMPLOYED: 'employed',
  UNEMPLOYED: 'unemployed',
  STUDENT: 'student',
  RETIRED: 'retired',
  HOMEMAKER: 'homemaker',
  UNABLE_TO_WORK: 'unable_to_work',
});

const PRESENCE_STATUSES = Object.freeze({
  PRESENT: 'present',
  TRAVELING: 'traveling',
});

const EMPLOYMENT_STATUSES_ARRAY = Object.values(EMPLOYMENT_STATUSES);
const PRESENCE_STATUSES_ARRAY = Object.values(PRESENCE_STATUSES);

module.exports = {
  EMPLOYMENT_STATUSES,
  EMPLOYMENT_STATUSES_ARRAY,
  PRESENCE_STATUSES,
  PRESENCE_STATUSES_ARRAY,
};
