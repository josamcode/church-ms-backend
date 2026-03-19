const LANDING_CONTENT_DOCUMENT_KEY = 'landing-page';

const LANDING_STAT_SOURCE_TYPES = Object.freeze({
  MANUAL: 'manual',
  SYSTEM: 'system',
});

const LANDING_SYSTEM_STAT_KEYS = Object.freeze({
  FAMILIES_TOTAL: 'families_total',
  MEMBERS_TOTAL: 'members_total',
  CHURCH_PRIESTS_TOTAL: 'church_priests_total',
  MEETINGS_TOTAL: 'meetings_total',
  DIVINE_LITURGIES_TOTAL: 'divine_liturgies_total',
  VESPERS_TOTAL: 'vespers_total',
  SERVICES_TOTAL: 'services_total',
  SERVANTS_TOTAL: 'servants_total',
});

const LANDING_STAT_ITEM_IDS = Object.freeze(['families', 'members', 'services', 'servants']);

const LANDING_DEFAULT_STAT_ITEMS = Object.freeze({
  families: {
    sourceType: LANDING_STAT_SOURCE_TYPES.SYSTEM,
    sourceKey: LANDING_SYSTEM_STAT_KEYS.FAMILIES_TOTAL,
    manualValue: '',
  },
  members: {
    sourceType: LANDING_STAT_SOURCE_TYPES.SYSTEM,
    sourceKey: LANDING_SYSTEM_STAT_KEYS.MEMBERS_TOTAL,
    manualValue: '',
  },
  services: {
    sourceType: LANDING_STAT_SOURCE_TYPES.SYSTEM,
    sourceKey: LANDING_SYSTEM_STAT_KEYS.SERVICES_TOTAL,
    manualValue: '',
  },
  servants: {
    sourceType: LANDING_STAT_SOURCE_TYPES.SYSTEM,
    sourceKey: LANDING_SYSTEM_STAT_KEYS.SERVANTS_TOTAL,
    manualValue: '',
  },
});

const LANDING_SOCIAL_PLATFORMS = Object.freeze(['facebook', 'instagram', 'youtube', 'twitter']);

module.exports = {
  LANDING_CONTENT_DOCUMENT_KEY,
  LANDING_STAT_SOURCE_TYPES,
  LANDING_SYSTEM_STAT_KEYS,
  LANDING_STAT_ITEM_IDS,
  LANDING_DEFAULT_STAT_ITEMS,
  LANDING_SOCIAL_PLATFORMS,
};

