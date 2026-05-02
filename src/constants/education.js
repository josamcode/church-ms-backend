const EDUCATION_STAGE_DEFINITIONS = Object.freeze([
  { value: 'kindergarten_unspecified_year', group: 'kindergarten', context: 'kindergarten' },
  { value: 'kindergarten_kg1', group: 'kindergarten', context: 'kindergarten' },
  { value: 'kindergarten_kg2', group: 'kindergarten', context: 'kindergarten' },
  { value: 'primary_unspecified_year', group: 'primary', context: 'school' },
  { value: 'primary_grade_1', group: 'primary', context: 'school' },
  { value: 'primary_grade_2', group: 'primary', context: 'school' },
  { value: 'primary_grade_3', group: 'primary', context: 'school' },
  { value: 'primary_grade_4', group: 'primary', context: 'school' },
  { value: 'primary_grade_5', group: 'primary', context: 'school' },
  { value: 'primary_grade_6', group: 'primary', context: 'school' },
  { value: 'preparatory_unspecified_year', group: 'preparatory', context: 'school' },
  { value: 'preparatory_grade_1', group: 'preparatory', context: 'school' },
  { value: 'preparatory_grade_2', group: 'preparatory', context: 'school' },
  { value: 'preparatory_grade_3', group: 'preparatory', context: 'school' },
  { value: 'secondary_unspecified_year', group: 'secondary_general', context: 'school' },
  { value: 'secondary_general_year_1', group: 'secondary_general', context: 'school' },
  { value: 'secondary_general_year_2', group: 'secondary_general', context: 'school' },
  { value: 'secondary_general_year_3', group: 'secondary_general', context: 'school' },
  { value: 'secondary_technical_agriculture_year_1', group: 'secondary_technical', context: 'school' },
  { value: 'secondary_technical_agriculture_year_2', group: 'secondary_technical', context: 'school' },
  { value: 'secondary_technical_agriculture_year_3', group: 'secondary_technical', context: 'school' },
  { value: 'secondary_technical_industrial_year_1', group: 'secondary_technical', context: 'school' },
  { value: 'secondary_technical_industrial_year_2', group: 'secondary_technical', context: 'school' },
  { value: 'secondary_technical_industrial_year_3', group: 'secondary_technical', context: 'school' },
  { value: 'secondary_technical_commercial_year_1', group: 'secondary_technical', context: 'school' },
  { value: 'secondary_technical_commercial_year_2', group: 'secondary_technical', context: 'school' },
  { value: 'secondary_technical_commercial_year_3', group: 'secondary_technical', context: 'school' },
  { value: 'secondary_technical_technical_arts_year_1', group: 'secondary_technical', context: 'school' },
  { value: 'secondary_technical_technical_arts_year_2', group: 'secondary_technical', context: 'school' },
  { value: 'secondary_technical_technical_arts_year_3', group: 'secondary_technical', context: 'school' },
  { value: 'finished_education', group: 'finished', context: 'finished' },
  { value: 'university_unspecified_year', group: 'university', context: 'university' },
  { value: 'university_year_1', group: 'university', context: 'university' },
  { value: 'university_year_2', group: 'university', context: 'university' },
  { value: 'university_year_3', group: 'university', context: 'university' },
  { value: 'university_year_4', group: 'university', context: 'university' },
  { value: 'university_year_5', group: 'university', context: 'university' },
  { value: 'university_graduate', group: 'university', context: 'university' },
  { value: 'uneducated', group: 'other', context: 'other' },
  { value: 'literacy', group: 'other', context: 'other' },
  { value: 'student', group: 'other', context: 'other' },
]);

const EDUCATION_STAGE_VALUES = EDUCATION_STAGE_DEFINITIONS.map((definition) => definition.value);
const EDUCATION_STAGE_GROUP_VALUES = Object.freeze([
  'kindergarten',
  'primary',
  'preparatory',
  'secondary_general',
  'secondary_technical',
  'finished',
  'university',
  'other',
]);
const EDUCATION_STAGE_FILTER_VALUES = Object.freeze([
  ...new Set([...EDUCATION_STAGE_VALUES, ...EDUCATION_STAGE_GROUP_VALUES]),
]);

function getEducationStageDefinition(stage) {
  return EDUCATION_STAGE_DEFINITIONS.find((definition) => definition.value === stage) || null;
}

function getEducationStageContext(stage) {
  return getEducationStageDefinition(stage)?.context || null;
}

function getEducationStageGroup(stageOrGroup) {
  if (EDUCATION_STAGE_GROUP_VALUES.includes(stageOrGroup)) return stageOrGroup;
  return getEducationStageDefinition(stageOrGroup)?.group || null;
}

module.exports = {
  EDUCATION_STAGE_DEFINITIONS,
  EDUCATION_STAGE_FILTER_VALUES,
  EDUCATION_STAGE_GROUP_VALUES,
  EDUCATION_STAGE_VALUES,
  getEducationStageContext,
  getEducationStageGroup,
};
