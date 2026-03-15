const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { ROLES, ROLES_ARRAY } = require('../../constants/roles');
const { PERMISSIONS_ARRAY } = require('../../constants/permissions');
const { AGE_GROUPS_ARRAY, getAgeGroup } = require('../../constants/ageGroups');
const { LOCK_REASONS_ARRAY } = require('../../constants/lockReasons');
const {
  EMPLOYMENT_STATUSES_ARRAY,
  PRESENCE_STATUSES,
  PRESENCE_STATUSES_ARRAY,
} = require('../../constants/householdProfiles');

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

const financialProfileSchema = new mongoose.Schema(
  {
    monthlyIncome: { type: Number, min: 0 },
    currency: { type: String, trim: true, default: 'EGP' },
    source: { type: String, trim: true },
    notes: { type: String, trim: true },
  },
  { _id: false }
);

const employmentProfileSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: EMPLOYMENT_STATUSES_ARRAY,
    },
    jobTitle: { type: String, trim: true },
    employerName: { type: String, trim: true },
    notes: { type: String, trim: true },
  },
  { _id: false }
);

const presenceProfileSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: PRESENCE_STATUSES_ARRAY,
      default: PRESENCE_STATUSES.PRESENT,
    },
    travelDestination: { type: String, trim: true },
    travelReason: { type: String, trim: true },
  },
  { _id: false }
);

const healthConditionSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, required: true },
    chronic: { type: Boolean, default: false },
    notes: { type: String, trim: true },
  },
  { _id: false }
);

const healthProfileSchema = new mongoose.Schema(
  {
    conditions: {
      type: [healthConditionSchema],
      default: [],
    },
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

const meetingAttendanceEntrySchema = new mongoose.Schema(
  {
    meetingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Meeting',
      required: true,
    },
    attendanceDate: {
      type: String,
      required: true,
      trim: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true, timestamps: false }
);

const divineLiturgyAttendanceEntrySchema = new mongoose.Schema(
  {
    entryType: {
      type: String,
      enum: ['recurring', 'exception'],
      required: true,
    },
    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    serviceType: {
      type: String,
      enum: ['DIVINE_LITURGY', 'VESPERS'],
      required: true,
    },
    attendanceDate: {
      type: String,
      required: true,
      trim: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true, timestamps: false }
);

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
    divineLiturgyAttendance: {
      type: [divineLiturgyAttendanceEntrySchema],
      default: [],
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
    financial: financialProfileSchema,
    employment: employmentProfileSchema,
    presence: presenceProfileSchema,
    health: {
      type: healthProfileSchema,
      default: () => ({ conditions: [] }),
    },

    // ═══════ B) الحالة المشتقة ═══════
    ageGroup: {
      type: String,
      enum: AGE_GROUPS_ARRAY,
    },

    // ═══════ C) بيانات العائلة ═══════
    familyName: { type: String, trim: true },
    houseName: { type: String, trim: true },
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
    meetingAttendance: [meetingAttendanceEntrySchema],

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
userSchema.index({ 'employment.status': 1 });
userSchema.index({ 'presence.status': 1 });
userSchema.index({ 'health.conditions.name': 1 });
userSchema.index({ 'meetingAttendance.meetingId': 1, 'meetingAttendance.attendanceDate': -1 });
userSchema.index({
  'divineLiturgyAttendance.serviceId': 1,
  'divineLiturgyAttendance.attendanceDate': -1,
});
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

  if (this.presence && this.presence.status !== PRESENCE_STATUSES.TRAVELING) {
    this.presence.travelDestination = undefined;
    this.presence.travelReason = undefined;
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
