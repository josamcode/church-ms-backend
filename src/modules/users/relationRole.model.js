const mongoose = require('mongoose');

/** قائمة أوصاف صلة القرابة الموحدة (تُزرع عند أول طلب إن لم توجد) */
const DEFAULT_LABELS = [
  { label: 'الأب', relation: 'father', order: 1 },
  { label: 'الأم', relation: 'mother', order: 2 },
  { label: 'الزوج', relation: 'spouse', order: 3 },
  { label: 'الزوجة', relation: 'spouse', order: 4 },
  { label: 'الأخ', relation: 'sibling', order: 5 },
  { label: 'الأخت', relation: 'sibling', order: 6 },
  { label: 'الابن', relation: 'child', order: 7 },
  { label: 'البنت', relation: 'child', order: 8 },
  { label: 'الجد', relation: 'other', order: 9 },
  { label: 'الجدة', relation: 'other', order: 10 },
  { label: 'الحفيد', relation: 'other', order: 11 },
  { label: 'الحفيدة', relation: 'other', order: 12 },
  { label: 'العم', relation: 'other', order: 13 },
  { label: 'الخال', relation: 'other', order: 14 },
  { label: 'العمة', relation: 'other', order: 15 },
  { label: 'الخالة', relation: 'other', order: 16 },
  { label: 'ابن العم', relation: 'other', order: 17 },
  { label: 'ابنة العم', relation: 'other', order: 18 },
  { label: 'ابن الخال', relation: 'other', order: 19 },
  { label: 'ابنة الخال', relation: 'other', order: 20 },
  { label: 'الوالد', relation: 'other', order: 21 },
  { label: 'الوالدة', relation: 'other', order: 22 },
  { label: 'صديق العائلة', relation: 'other', order: 23 },
  { label: 'جار', relation: 'other', order: 24 },
  { label: 'آخر', relation: 'other', order: 99 },
];

const relationRoleSchema = new mongoose.Schema(
  {
    label: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    /** نظامي = مرتبط بنوع علاقة ثابت (father, mother, ...). غير نظامي = other فقط */
    relation: {
      type: String,
      enum: ['father', 'mother', 'spouse', 'sibling', 'child', 'other'],
      default: 'other',
    },
    order: {
      type: Number,
      default: 99,
    },
  },
  { timestamps: true }
);

relationRoleSchema.index({ order: 1, label: 1 });

const RelationRole = mongoose.model('RelationRole', relationRoleSchema);

const LEGACY_COMBINED_LABELS = ['الزوج/ة', 'أخ/أخت', 'ابن/بنت'];

/**
 * تأكد من وجود القيم الافتراضية (تُزرع الناقصة فقط، وتُزال التسميات المركبة القديمة)
 */
async function seedDefaultRelationRoles() {
  await RelationRole.deleteMany({ label: { $in: LEGACY_COMBINED_LABELS } });
  for (const { label, relation, order } of DEFAULT_LABELS) {
    const exists = await RelationRole.findOne({ label }).lean();
    if (!exists) {
      await RelationRole.create({ label, relation, order });
    }
  }
}

module.exports = RelationRole;
module.exports.seedDefaultRelationRoles = seedDefaultRelationRoles;
module.exports.DEFAULT_LABELS = DEFAULT_LABELS;
