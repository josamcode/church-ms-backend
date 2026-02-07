/**
 * seed.js — إدراج بيانات تجريبية لنظام إدارة الكنيسة
 * يشغل من مجلد backend: node scripts/seed.js
 * متغير بيئة اختياري: SEED_CLEAR=1 لمسح المستخدمين الحاليين قبل الإدراج
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const config = require('../src/config/env');
const User = require('../src/modules/users/user.model');
const { ROLES } = require('../src/constants/roles');
const { LOCK_REASONS } = require('../src/constants/lockReasons');

const SEED_PASSWORD = 'Test123!@#'; // كلمة مرور موحدة لجميع الحسابات التجريبية
const CLEAR_FIRST = process.env.SEED_CLEAR === '1';

function dateYearsAgo(years) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d;
}

const seedUsers = [
  // ─────────────── مدير نظام (دخول بالبريد) ───────────────
  {
    fullName: 'مدير النظام',
    gender: 'male',
    birthDate: dateYearsAgo(35),
    phonePrimary: '01000000001',
    phoneSecondary: '01000000002',
    email: 'super@church.test',
    nationalId: '29901011234567',
    address: {
      governorate: 'المنيا',
      city: 'مطاي',
      street: 'قرية القطوشة',
      details: 'كنيسة الملاك ميخائيل',
    },
    hasLogin: true,
    loginIdentifierType: 'email',
    passwordHash: SEED_PASSWORD,
    role: ROLES.SUPER_ADMIN,
    notes: 'حساب تجريبي لمدير النظام',
    tags: ['تجريبي', 'إدارة'],
  },
  // ─────────────── مسؤول (دخول بالهاتف) ───────────────
  {
    fullName: 'أمين الخدمة',
    gender: 'male',
    birthDate: dateYearsAgo(42),
    phonePrimary: '01000000003',
    email: 'admin@church.test',
    nationalId: '28205051234567',
    address: {
      governorate: 'المنيا',
      city: 'مطاي',
      street: 'قرية القطوشة',
    },
    hasLogin: true,
    loginIdentifierType: 'phone',
    passwordHash: SEED_PASSWORD,
    role: ROLES.ADMIN,
    notes: 'حساب تجريبي لمسؤول الخدمة',
    tags: ['تجريبي', 'خدمة'],
  },
  // ─────────────── مستخدم عادي (شاب) ───────────────
  {
    fullName: 'مينا رامز',
    gender: 'male',
    birthDate: dateYearsAgo(28),
    phonePrimary: '01000000004',
    email: 'mina@church.test',
    nationalId: '29608081234567',
    address: {
      governorate: 'المنيا',
      city: 'مطاي',
      street: 'شارع الكنيسة',
      details: 'بجوار المدرسة',
    },
    familyName: 'عائلة رامز',
    hasLogin: true,
    loginIdentifierType: 'email',
    passwordHash: SEED_PASSWORD,
    role: ROLES.USER,
    tags: ['شباب', 'خورس'],
  },
  // ─────────────── مستخدمة (متوسطة العمر) ───────────────
  {
    fullName: 'سميرة يوسف',
    gender: 'female',
    birthDate: dateYearsAgo(45),
    phonePrimary: '01000000005',
    phoneSecondary: '01200000005',
    email: 'samira@church.test',
    address: {
      governorate: 'المنيا',
      city: 'مطاي',
      street: 'حي الشرق',
    },
    hasLogin: true,
    loginIdentifierType: 'phone',
    passwordHash: SEED_PASSWORD,
    role: ROLES.USER,
    tags: ['أمهات', 'اجتماعات'],
  },
  // ─────────────── مستخدم كبير سن ───────────────
  {
    fullName: 'أنطون صليب',
    gender: 'male',
    birthDate: dateYearsAgo(65),
    phonePrimary: '01000000006',
    email: 'anton@church.test',
    address: {
      governorate: 'المنيا',
      city: 'مطاي',
      street: 'قرية القطوشة',
    },
    hasLogin: true,
    loginIdentifierType: 'email',
    passwordHash: SEED_PASSWORD,
    role: ROLES.USER,
    tags: ['كبار السن', 'مجلس إدارة'],
  },
  // ─────────────── مراهق (بدون دخول) ───────────────
  {
    fullName: 'كيرلس مينا',
    gender: 'male',
    birthDate: dateYearsAgo(16),
    phonePrimary: '01000000007',
    email: 'kyrillos@church.test',
    familyName: 'عائلة مينا',
    hasLogin: false,
    role: ROLES.USER,
    tags: ['مراهقين', 'أحد النور'],
  },
  // ─────────────── طفل ───────────────
  {
    fullName: 'ماريام رامز',
    gender: 'female',
    birthDate: dateYearsAgo(10),
    phonePrimary: '01000000008',
    familyName: 'عائلة رامز',
    hasLogin: false,
    role: ROLES.USER,
    tags: ['أطفال', 'مدرسة الأحد'],
  },
  // ─────────────── حساب مقفل (لاختبار واجهة القفل) ───────────────
  {
    fullName: 'مستخدم مقفل',
    gender: 'male',
    birthDate: dateYearsAgo(30),
    phonePrimary: '01000000009',
    email: 'locked@church.test',
    hasLogin: true,
    loginIdentifierType: 'email',
    passwordHash: SEED_PASSWORD,
    role: ROLES.USER,
    isLocked: true,
    lockReason: LOCK_REASONS.INACTIVE,
    lockedAt: new Date(),
    tags: ['تجريبي', 'مقفل'],
  },
  // ─────────────── مستخدم إضافي للقائمة والفلترة ───────────────
  {
    fullName: 'تادرس فهمي',
    gender: 'male',
    birthDate: dateYearsAgo(22),
    phonePrimary: '01000000010',
    email: 'tadros@church.test',
    hasLogin: true,
    loginIdentifierType: 'phone',
    passwordHash: SEED_PASSWORD,
    role: ROLES.USER,
    tags: ['شباب'],
  },
  {
    fullName: 'دينا مكرم',
    gender: 'female',
    birthDate: dateYearsAgo(19),
    phonePrimary: '01000000011',
    email: 'dina@church.test',
    hasLogin: true,
    loginIdentifierType: 'email',
    passwordHash: SEED_PASSWORD,
    role: ROLES.USER,
    tags: ['شباب', 'خورس'],
  },
];

async function runSeed() {
  try {
    await mongoose.connect(config.mongo.uri);
    console.log('تم الاتصال بقاعدة البيانات');

    if (CLEAR_FIRST) {
      const deleted = await User.deleteMany({});
      console.log(`تم مسح ${deleted.deletedCount} مستخدم (إن وجد).`);
    }

    const created = [];
    const skipped = [];

    for (const u of seedUsers) {
      const exists = await User.findOne({
        $or: [
          { phonePrimary: u.phonePrimary },
          ...(u.email ? [{ email: u.email }] : []),
        ],
      });
      if (exists) {
        skipped.push(u.fullName);
        continue;
      }
      const user = await User.create(u);
      created.push({ name: user.fullName, id: user._id.toString(), role: user.role });
    }

    console.log('\n── الحسابات المُنشأة ──');
    created.forEach((c) => console.log(`  ${c.role}: ${c.name} (${c.id})`));
    if (skipped.length) {
      console.log('\n── تم تخطيهم (موجودون مسبقاً) ──');
      skipped.forEach((s) => console.log(`  ${s}`));
    }

    console.log('\nكلمة المرور لجميع الحسابات التجريبية: ' + SEED_PASSWORD);
    console.log('\nأمثلة دخول:');
    console.log('  مدير نظام: super@church.test أو 01000000001');
    console.log('  مسؤول: admin@church.test أو 01000000003');
    console.log('  مستخدم: mina@church.test أو 01000000004');
    console.log('  حساب مقفل: locked@church.test');
  } catch (err) {
    console.error('خطأ أثناء التنفيذ:', err.message);
    if (err.code === 11000) {
      console.error('تكرر في حقل فريد (هاتف/بريد/رقم قومي). استخدم SEED_CLEAR=1 لمسح ثم إعادة الإدراج.');
    }
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log('\nتم قطع الاتصال بقاعدة البيانات.');
    process.exit(process.exitCode || 0);
  }
}

runSeed();
