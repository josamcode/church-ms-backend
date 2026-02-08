const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { ROLES, ROLES_ARRAY } = require('../../constants/roles');
const { PERMISSIONS_ARRAY } = require('../../constants/permissions');
const { AGE_GROUPS_ARRAY, getAgeGroup } = require('../../constants/ageGroups');
const { LOCK_REASONS_ARRAY } = require('../../constants/lockReasons');

/* ──────────────── Sub-schemas ──────────────── */

const addressSchema = new mongoose.Schema(
  {
    governorate: { type: String, trim: true },
    city: { type: String, trim: true },
    street: { type: String, trim: true },
    details: { type: String, trim: true },
  },
  { _id: false }
);

const familyMemberSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    name: { type: String, trim: true },
    relationRole: {
      type: String,
      required: [true, 'صلة القرابة مطلوبة'],
      trim: true,
    },
    notes: { type: String, trim: true },
  },
  { _id: true, timestamps: false }
);

const changeLogEntrySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    action: { type: String, required: true },
    changes: [
      {
        field: { type: String },
        from: { type: mongoose.Schema.Types.Mixed },
        to: { type: mongoose.Schema.Types.Mixed },
      },
    ],
  },
  { _id: true, timestamps: false }
);

/* ──────────────── Main User Schema ──────────────── */

const userSchema = new mongoose.Schema(
  {
    // ═══════ A) معلومات أساسية ═══════
    fullName: {
      type: String,
      required: [true, 'الاسم الكامل مطلوب'],
      trim: true,
      minlength: [2, 'الاسم يجب أن يكون حرفين على الأقل'],
      maxlength: [100, 'الاسم يجب ألا يتجاوز 100 حرف'],
    },
    gender: {
      type: String,
      enum: {
        values: ['male', 'female', 'other'],
        message: 'الجنس يجب أن يكون ذكر أو أنثى أو آخر',
      },
    },
    birthDate: {
      type: Date,
      required: [true, 'تاريخ الميلاد مطلوب'],
    },
    avatar: {
      url: { type: String },
      publicId: { type: String },
    },
    nationalId: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [1000, 'الملاحظات يجب ألا تتجاوز 1000 حرف'],
    },
    phonePrimary: {
      type: String,
      required: [true, 'رقم الهاتف الأساسي مطلوب'],
      unique: true,
      trim: true,
    },
    phoneSecondary: {
      type: String,
      trim: true,
    },
    whatsappNumber: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
    },
    address: addressSchema,
    tags: [{ type: String, trim: true }],
    /** تفاصيل مخصصة (مفتاح - قيمة) يضيفها المستخدم */
    customDetails: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },

    // ═══════ B) الحالة المشتقة ═══════
    ageGroup: {
      type: String,
      enum: AGE_GROUPS_ARRAY,
    },

    // ═══════ C) بيانات العائلة ═══════
    familyName: { type: String, trim: true },
    father: familyMemberSchema,
    mother: familyMemberSchema,
    spouse: familyMemberSchema,
    siblings: [familyMemberSchema],
    children: [familyMemberSchema],
    familyMembers: [familyMemberSchema],

    // ═══════ D) صلاحيات الدخول ═══════
    hasLogin: {
      type: Boolean,
      default: false,
    },
    loginIdentifierType: {
      type: String,
      enum: {
        values: ['phone', 'email'],
        message: 'نوع معرف الدخول يجب أن يكون هاتف أو بريد إلكتروني',
      },
    },
    passwordHash: {
      type: String,
      select: false,
    },
    lastLoginAt: { type: Date },
    isLocked: {
      type: Boolean,
      default: false,
    },
    lockReason: {
      type: String,
      enum: LOCK_REASONS_ARRAY,
    },
    lockedAt: { type: Date },

    // ═══════ E) الأدوار والصلاحيات ═══════
    role: {
      type: String,
      enum: {
        values: ROLES_ARRAY,
        message: 'الدور غير صالح',
      },
      default: ROLES.USER,
    },
    extraPermissions: [
      {
        type: String,
        enum: PERMISSIONS_ARRAY,
      },
    ],
    deniedPermissions: [
      {
        type: String,
        enum: PERMISSIONS_ARRAY,
      },
    ],

    // ═══════ F) حقول الاعتراف والاجتماعات (مستقبلية) ═══════
    confessionFatherName: { type: String, trim: true },
    confessionFatherUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    confessionSessionIds: [
      { type: mongoose.Schema.Types.ObjectId, ref: 'ConfessionSession' },
    ],
    meetingIds: [
      { type: mongoose.Schema.Types.ObjectId, ref: 'Meeting' },
    ],

    // ═══════ G) الحوكمة والمراجعة ═══════
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    changeLog: [changeLogEntrySchema],

    // ═══════ الحذف الناعم ═══════
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        delete ret.passwordHash;
        delete ret.__v;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

/* ──────────────── Indexes ──────────────── */
// Note: phonePrimary, email, nationalId already have indexes via unique:true in schema

userSchema.index({ fullName: 'text' });
userSchema.index({ tags: 1 });
userSchema.index({ ageGroup: 1 });
userSchema.index({ role: 1 });
userSchema.index({ isDeleted: 1, createdAt: -1 });
userSchema.index({ isDeleted: 1, fullName: 1 });
userSchema.index({ isDeleted: 1, ageGroup: 1 });
userSchema.index({ isDeleted: 1, tags: 1 });
userSchema.index({ isDeleted: 1, role: 1 });
userSchema.index({ 'father.userId': 1 }, { sparse: true });
userSchema.index({ 'mother.userId': 1 }, { sparse: true });
userSchema.index({ 'spouse.userId': 1 }, { sparse: true });
userSchema.index({ 'familyMembers.userId': 1 }, { sparse: true });

/* ──────────────── Virtuals ──────────────── */

userSchema.virtual('computedAgeGroup').get(function () {
  return getAgeGroup(this.birthDate);
});

userSchema.virtual('genderArabic').get(function () {
  const map = { male: 'ذكر', female: 'أنثى', other: 'آخر' };
  return map[this.gender] || '';
});

/* ──────────────── Pre-save Hooks ──────────────── */

userSchema.pre('save', async function (next) {
  // Hash password if modified
  if (this.isModified('passwordHash') && this.passwordHash && !this.passwordHash.startsWith('$2')) {
    const salt = await bcrypt.genSalt(12);
    this.passwordHash = await bcrypt.hash(this.passwordHash, salt);
  }

  // Compute ageGroup from birthDate
  if (this.isModified('birthDate')) {
    this.ageGroup = getAgeGroup(this.birthDate);
  }

  // Set whatsapp default to phonePrimary
  if (!this.whatsappNumber && this.phonePrimary) {
    this.whatsappNumber = this.phonePrimary;
  }

  next();
});

// Exclude soft-deleted users from find queries by default
userSchema.pre(/^find/, function (next) {
  const filter = this.getFilter();
  if (filter.includeDeleted !== true && filter.isDeleted === undefined) {
    this.where({ isDeleted: { $ne: true } });
  }
  if (filter.includeDeleted !== undefined) {
    delete filter.includeDeleted;
  }
  next();
});

/* ──────────────── Instance Methods ──────────────── */

userSchema.methods.comparePassword = async function (candidatePassword) {
  if (!this.passwordHash) return false;
  return bcrypt.compare(candidatePassword, this.passwordHash);
};

userSchema.methods.toSafeObject = function () {
  const obj = this.toObject();
  delete obj.passwordHash;
  delete obj.changeLog;
  delete obj.__v;
  return obj;
};

/* ──────────────── Static Methods ──────────────── */

userSchema.statics.findByIdentifier = function (identifier) {
  return this.findOne({
    $or: [{ phonePrimary: identifier }, { email: identifier }],
  });
};

const User = mongoose.model('User', userSchema);

module.exports = User;
