const AGE_GROUPS = Object.freeze({
  CHILD: 'طفل',
  TEENAGER: 'مراهق',
  YOUNG: 'شاب',
  MIDDLE_AGE: 'متوسط العمر',
  SENIOR: 'كبير سن',
});

const AGE_GROUPS_ARRAY = Object.values(AGE_GROUPS);

const AGE_GROUP_RANGES = Object.freeze({
  [AGE_GROUPS.CHILD]: { min: 0, max: 12 },
  [AGE_GROUPS.TEENAGER]: { min: 13, max: 18 },
  [AGE_GROUPS.YOUNG]: { min: 19, max: 39 },
  [AGE_GROUPS.MIDDLE_AGE]: { min: 40, max: 59 },
  [AGE_GROUPS.SENIOR]: { min: 60, max: Infinity },
});

const getAgeGroup = (birthDate) => {
  if (!birthDate) return null;

  const today = new Date();
  const birth = new Date(birthDate);
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();

  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
    age--;
  }

  if (age < 0) return null;
  if (age <= 12) return AGE_GROUPS.CHILD;
  if (age <= 18) return AGE_GROUPS.TEENAGER;
  if (age <= 39) return AGE_GROUPS.YOUNG;
  if (age <= 59) return AGE_GROUPS.MIDDLE_AGE;
  return AGE_GROUPS.SENIOR;
};

module.exports = { AGE_GROUPS, AGE_GROUPS_ARRAY, AGE_GROUP_RANGES, getAgeGroup };
