const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'نظام إدارة الكنيسة - API',
      version: '1.0.0',
      description: 'التوثيق الكامل لواجهة برمجة التطبيقات لنظام إدارة الكنيسة. جميع الاستجابات والرسائل باللغة العربية.',
      contact: {
        name: 'فريق التطوير',
      },
    },
    servers: [
      {
        url: '/api',
        description: 'الخادم الرئيسي',
      },
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'أدخل رمز الوصول (Access Token) بدون كلمة Bearer',
        },
      },
      schemas: {
        SuccessResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            message: { type: 'string', example: 'تمت العملية بنجاح' },
            data: { type: 'object', nullable: true },
            meta: {
              type: 'object',
              nullable: true,
              properties: {
                limit: { type: 'integer' },
                hasMore: { type: 'boolean' },
                nextCursor: { type: 'string', nullable: true },
                count: { type: 'integer' },
              },
            },
            requestId: { type: 'string', format: 'uuid' },
            timestamp: { type: 'string', format: 'date-time' },
          },
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            message: { type: 'string', example: 'خطأ في البيانات المدخلة' },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'VALIDATION_ERROR' },
                details: {
                  type: 'array',
                  nullable: true,
                  items: {
                    type: 'object',
                    properties: {
                      field: { type: 'string' },
                      message: { type: 'string' },
                    },
                  },
                },
              },
            },
            requestId: { type: 'string', format: 'uuid' },
            timestamp: { type: 'string', format: 'date-time' },
          },
        },
        UserBasic: {
          type: 'object',
          properties: {
            _id: { type: 'string', description: 'معرّف المستخدم' },
            fullName: { type: 'string', description: 'الاسم الكامل' },
            gender: { type: 'string', enum: ['male', 'female', 'other'], description: 'الجنس' },
            birthDate: { type: 'string', format: 'date', description: 'تاريخ الميلاد' },
            ageGroup: { type: 'string', description: 'الفئة العمرية (محسوبة تلقائياً)' },
            phonePrimary: { type: 'string', description: 'رقم الهاتف الأساسي' },
            email: { type: 'string', description: 'البريد الإلكتروني' },
            role: { type: 'string', enum: ['SUPER_ADMIN', 'ADMIN', 'USER'], description: 'الدور' },
            avatar: {
              type: 'object',
              nullable: true,
              properties: {
                url: { type: 'string' },
                publicId: { type: 'string' },
              },
            },
            tags: { type: 'array', items: { type: 'string' }, description: 'الوسوم' },
            isLocked: { type: 'boolean', description: 'هل الحساب مغلق' },
            hasLogin: { type: 'boolean', description: 'هل يملك صلاحية دخول' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        Address: {
          type: 'object',
          properties: {
            governorate: { type: 'string', description: 'المحافظة' },
            city: { type: 'string', description: 'المدينة' },
            street: { type: 'string', description: 'الشارع' },
            details: { type: 'string', description: 'تفاصيل إضافية' },
          },
        },
        FamilyMember: {
          type: 'object',
          properties: {
            userId: { type: 'string', nullable: true, description: 'معرّف المستخدم إن وُجد' },
            name: { type: 'string', description: 'اسم الشخص' },
            relationRole: { type: 'string', description: 'صلة القرابة (مثل: أب، أم، زوج)' },
            notes: { type: 'string', nullable: true, description: 'ملاحظات' },
          },
          required: ['relationRole'],
        },
      },
    },
    paths: {
      /* ══════════════════ المصادقة ══════════════════ */
      '/auth/register': {
        post: {
          tags: ['المصادقة'],
          summary: 'تسجيل مستخدم جديد',
          description: 'إنشاء حساب جديد مع تسجيل دخول تلقائي. يمكن التسجيل برقم الهاتف أو البريد الإلكتروني.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['fullName', 'phonePrimary', 'password', 'birthDate'],
                  properties: {
                    fullName: { type: 'string', description: 'الاسم الكامل', example: 'يوحنا مرقس' },
                    phonePrimary: { type: 'string', description: 'رقم الهاتف الأساسي', example: '01234567890' },
                    email: { type: 'string', description: 'البريد الإلكتروني (اختياري)', example: 'yohana@example.com' },
                    password: { type: 'string', description: 'كلمة المرور (8 أحرف على الأقل، حرف كبير وصغير ورقم ورمز خاص)', example: 'MyPass@123' },
                    birthDate: { type: 'string', format: 'date', description: 'تاريخ الميلاد', example: '1990-05-15' },
                    gender: { type: 'string', enum: ['male', 'female', 'other'], description: 'الجنس', example: 'male' },
                  },
                },
              },
            },
          },
          responses: {
            201: {
              description: 'تم التسجيل بنجاح',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        properties: {
                          data: {
                            type: 'object',
                            properties: {
                              user: { $ref: '#/components/schemas/UserBasic' },
                              accessToken: { type: 'string', description: 'رمز الوصول' },
                              refreshToken: { type: 'string', description: 'رمز التحديث' },
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            },
            400: { description: 'خطأ في البيانات المدخلة', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            409: { description: 'البيانات مكررة (رقم هاتف أو بريد إلكتروني)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            429: { description: 'تم تجاوز الحد المسموح من الطلبات', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/auth/login': {
        post: {
          tags: ['المصادقة'],
          summary: 'تسجيل الدخول',
          description: 'تسجيل الدخول باستخدام رقم الهاتف أو البريد الإلكتروني مع كلمة المرور.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['identifier', 'password'],
                  properties: {
                    identifier: { type: 'string', description: 'رقم الهاتف أو البريد الإلكتروني', example: '01234567890' },
                    password: { type: 'string', description: 'كلمة المرور', example: 'MyPass@123' },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'تم تسجيل الدخول بنجاح',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        properties: {
                          data: {
                            type: 'object',
                            properties: {
                              user: { $ref: '#/components/schemas/UserBasic' },
                              accessToken: { type: 'string' },
                              refreshToken: { type: 'string' },
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            },
            401: { description: 'بيانات دخول غير صحيحة', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            403: { description: 'الحساب مغلق أو لا يملك صلاحية دخول', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/auth/refresh': {
        post: {
          tags: ['المصادقة'],
          summary: 'تحديث الجلسة',
          description: 'تحديث رمز الوصول باستخدام رمز التحديث. يتم تدوير رمز التحديث (Rotation).',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['refreshToken'],
                  properties: {
                    refreshToken: { type: 'string', description: 'رمز التحديث الحالي' },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'تم تحديث الجلسة بنجاح',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        properties: {
                          data: {
                            type: 'object',
                            properties: {
                              accessToken: { type: 'string', description: 'رمز الوصول الجديد' },
                              refreshToken: { type: 'string', description: 'رمز التحديث الجديد' },
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            },
            401: { description: 'رمز التحديث غير صالح', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/auth/logout': {
        post: {
          tags: ['المصادقة'],
          summary: 'تسجيل الخروج',
          description: 'تسجيل الخروج وإبطال رمز الوصول ورمز التحديث.',
          security: [{ BearerAuth: [] }],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    refreshToken: { type: 'string', description: 'رمز التحديث (اختياري)' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'تم تسجيل الخروج بنجاح', content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } } } },
            401: { description: 'غير مصادق', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/auth/me': {
        get: {
          tags: ['المصادقة'],
          summary: 'جلب بيانات المستخدم الحالي',
          description: 'جلب بيانات المستخدم المسجّل حالياً. تتطلب صلاحية AUTH_VIEW_SELF.',
          security: [{ BearerAuth: [] }],
          responses: {
            200: {
              description: 'تم جلب البيانات بنجاح',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { properties: { data: { $ref: '#/components/schemas/UserBasic' } } },
                    ],
                  },
                },
              },
            },
            401: { description: 'غير مصادق', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/auth/change-password': {
        post: {
          tags: ['المصادقة'],
          summary: 'تغيير كلمة المرور',
          description: 'تغيير كلمة المرور للمستخدم الحالي. تتطلب صلاحية AUTH_CHANGE_PASSWORD.',
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['currentPassword', 'newPassword'],
                  properties: {
                    currentPassword: { type: 'string', description: 'كلمة المرور الحالية' },
                    newPassword: { type: 'string', description: 'كلمة المرور الجديدة (8 أحرف على الأقل، حرف كبير وصغير ورقم ورمز خاص)' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'تم تغيير كلمة المرور بنجاح', content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } } } },
            400: { description: 'كلمة المرور الحالية غير صحيحة', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },

      /* ══════════════════ الافراد ══════════════════ */
      '/users': {
        post: {
          tags: ['الافراد'],
          summary: 'إنشاء مستخدم جديد',
          description: 'إنشاء ملف مستخدم جديد (مع أو بدون تسجيل دخول). تتطلب صلاحية USERS_CREATE.',
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['fullName', 'phonePrimary', 'birthDate'],
                  properties: {
                    fullName: { type: 'string', example: 'مريم يوسف' },
                    gender: { type: 'string', enum: ['male', 'female', 'other'] },
                    birthDate: { type: 'string', format: 'date', example: '2000-01-15' },
                    phonePrimary: { type: 'string', example: '01098765432' },
                    email: { type: 'string', example: 'mariam@example.com' },
                    nationalId: { type: 'string' },
                    notes: { type: 'string' },
                    phoneSecondary: { type: 'string' },
                    whatsappNumber: { type: 'string' },
                    address: { $ref: '#/components/schemas/Address' },
                    tags: { type: 'array', items: { type: 'string' } },
                    familyName: { type: 'string' },
                    role: { type: 'string', enum: ['SUPER_ADMIN', 'ADMIN', 'USER'] },
                    password: { type: 'string', description: 'إذا تم تقديمها يتم إنشاء حساب دخول' },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: 'تم إنشاء المستخدم بنجاح', content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } } } },
            400: { description: 'خطأ في البيانات', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            409: { description: 'بيانات مكررة', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        get: {
          tags: ['الافراد'],
          summary: 'قائمة المستخدمين',
          description: 'جلب قائمة المستخدمين مع ترقيم المؤشر (Cursor Pagination) والفلترة. تتطلب صلاحية USERS_VIEW.',
          security: [{ BearerAuth: [] }],
          parameters: [
            { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'مؤشر الترقيم (قيمة آخر عنصر)' },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, minimum: 1, maximum: 100 }, description: 'عدد النتائج' },
            { name: 'sort', in: 'query', schema: { type: 'string', enum: ['createdAt', 'fullName', 'birthDate'], default: 'createdAt' }, description: 'حقل الترتيب' },
            { name: 'order', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' }, description: 'اتجاه الترتيب' },
            { name: 'fullName', in: 'query', schema: { type: 'string' }, description: 'بحث بالاسم' },
            { name: 'phonePrimary', in: 'query', schema: { type: 'string' }, description: 'بحث برقم الهاتف' },
            { name: 'ageGroup', in: 'query', schema: { type: 'string' }, description: 'الفئة العمرية (طفل، مراهق، شاب، متوسط العمر، كبير سن)' },
            { name: 'tags', in: 'query', schema: { type: 'string' }, description: 'الوسوم (مفصولة بفاصلة)' },
            { name: 'role', in: 'query', schema: { type: 'string', enum: ['SUPER_ADMIN', 'ADMIN', 'USER'] }, description: 'الدور' },
            { name: 'gender', in: 'query', schema: { type: 'string', enum: ['male', 'female', 'other'] }, description: 'الجنس' },
            { name: 'isLocked', in: 'query', schema: { type: 'boolean' }, description: 'حالة القفل' },
          ],
          responses: {
            200: {
              description: 'تم جلب القائمة بنجاح',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        properties: {
                          data: { type: 'array', items: { $ref: '#/components/schemas/UserBasic' } },
                          meta: {
                            type: 'object',
                            properties: {
                              limit: { type: 'integer' },
                              hasMore: { type: 'boolean' },
                              nextCursor: { type: 'string', nullable: true },
                              count: { type: 'integer' },
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
      '/users/{id}': {
        get: {
          tags: ['الافراد'],
          summary: 'جلب مستخدم بالمعرّف',
          description: 'جلب بيانات مستخدم محدد. تتطلب صلاحية USERS_VIEW.',
          security: [{ BearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'معرّف المستخدم' }],
          responses: {
            200: { description: 'تم جلب البيانات بنجاح', content: { 'application/json': { schema: { allOf: [{ $ref: '#/components/schemas/SuccessResponse' }, { properties: { data: { $ref: '#/components/schemas/UserBasic' } } }] } } } },
            404: { description: 'المستخدم غير موجود', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        patch: {
          tags: ['الافراد'],
          summary: 'تحديث بيانات مستخدم',
          description: 'تحديث بيانات مستخدم محدد. تتطلب صلاحية USERS_UPDATE. يتم تسجيل التغييرات في سجل المراجعة.',
          security: [{ BearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'معرّف المستخدم' }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    fullName: { type: 'string' },
                    gender: { type: 'string', enum: ['male', 'female', 'other'] },
                    birthDate: { type: 'string', format: 'date' },
                    phonePrimary: { type: 'string' },
                    email: { type: 'string' },
                    nationalId: { type: 'string' },
                    notes: { type: 'string' },
                    address: { $ref: '#/components/schemas/Address' },
                    tags: { type: 'array', items: { type: 'string' } },
                    role: { type: 'string', enum: ['SUPER_ADMIN', 'ADMIN', 'USER'] },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'تم التحديث بنجاح', content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } } } },
            404: { description: 'المستخدم غير موجود', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        delete: {
          tags: ['الافراد'],
          summary: 'حذف مستخدم (ناعم)',
          description: 'حذف ناعم للمستخدم (يبقى في قاعدة البيانات مع علامة isDeleted). تتطلب صلاحية USERS_DELETE.',
          security: [{ BearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'معرّف المستخدم' }],
          responses: {
            200: { description: 'تم الحذف بنجاح', content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } } } },
            404: { description: 'المستخدم غير موجود', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/users/{id}/avatar': {
        post: {
          tags: ['الافراد'],
          summary: 'رفع صورة شخصية',
          description: 'رفع أو تحديث الصورة الشخصية للمستخدم عبر Cloudinary. الأنواع المسموحة: JPEG, PNG, GIF, WEBP. الحد الأقصى: 5 ميجابايت. تتطلب صلاحية USERS_UPLOAD_AVATAR.',
          security: [{ BearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'معرّف المستخدم' }],
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['avatar'],
                  properties: {
                    avatar: { type: 'string', format: 'binary', description: 'ملف الصورة' },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'تم رفع الصورة بنجاح',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      {
                        properties: {
                          data: {
                            type: 'object',
                            properties: {
                              url: { type: 'string', description: 'رابط الصورة' },
                              publicId: { type: 'string', description: 'معرّف Cloudinary' },
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            },
            400: { description: 'نوع أو حجم الملف غير مسموح', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/users/{id}/lock': {
        post: {
          tags: ['الافراد'],
          summary: 'قفل حساب مستخدم',
          description: 'قفل حساب مستخدم مع تحديد السبب. تتطلب صلاحية USERS_LOCK.',
          security: [{ BearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'معرّف المستخدم' }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['lockReason'],
                  properties: {
                    lockReason: {
                      type: 'string',
                      description: 'سبب القفل',
                      enum: ['قرار إداري', 'اختراق أمني', 'سلوك غير لائق', 'عدم نشاط', 'محاولات دخول فاشلة متعددة', 'مشاكل في سلامة البيانات', 'سبب آخر'],
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'تم قفل الحساب بنجاح', content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } } } },
          },
        },
      },
      '/users/{id}/unlock': {
        post: {
          tags: ['الافراد'],
          summary: 'فتح حساب مستخدم',
          description: 'فتح حساب مستخدم مغلق. تتطلب صلاحية USERS_UNLOCK.',
          security: [{ BearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'معرّف المستخدم' }],
          responses: {
            200: { description: 'تم فتح الحساب بنجاح', content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } } } },
          },
        },
      },
      '/users/{id}/tags': {
        post: {
          tags: ['الافراد'],
          summary: 'إدارة وسوم المستخدم',
          description: 'إضافة أو إزالة وسوم من المستخدم. تتطلب صلاحية USERS_TAGS_MANAGE.',
          security: [{ BearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'معرّف المستخدم' }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    add: { type: 'array', items: { type: 'string' }, description: 'وسوم للإضافة', example: ['خادم', 'شماس'] },
                    remove: { type: 'array', items: { type: 'string' }, description: 'وسوم للإزالة', example: ['زائر'] },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'تم تعديل الوسوم بنجاح',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/SuccessResponse' },
                      { properties: { data: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } } } },
                    ],
                  },
                },
              },
            },
          },
        },
      },
      '/users/{id}/family/link': {
        post: {
          tags: ['الافراد'],
          summary: 'ربط فرد عائلة',
          description: 'ربط فرد عائلة بالمستخدم. يتم البحث عن الشخص المستهدف في قاعدة البيانات بالهاتف أو الرقم القومي أو الاسم+تاريخ الميلاد. إذا وُجد يتم الربط بالمعرّف، وإلا يُخزن الاسم فقط. تتطلب صلاحية USERS_FAMILY_LINK.',
          security: [{ BearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'معرّف المستخدم' }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['relation', 'relationRole'],
                  properties: {
                    relation: { type: 'string', enum: ['father', 'mother', 'spouse', 'sibling', 'child', 'other'], description: 'نوع العلاقة' },
                    targetPhone: { type: 'string', description: 'رقم هاتف الشخص المستهدف للبحث' },
                    targetNationalId: { type: 'string', description: 'الرقم القومي للبحث' },
                    targetFullName: { type: 'string', description: 'اسم الشخص المستهدف' },
                    targetBirthDate: { type: 'string', format: 'date', description: 'تاريخ ميلاد الشخص المستهدف (للبحث مع الاسم)' },
                    name: { type: 'string', description: 'اسم الشخص (إذا لم يكن في النظام)' },
                    relationRole: { type: 'string', description: 'وصف صلة القرابة بالعربي', example: 'أب' },
                    notes: { type: 'string', description: 'ملاحظات' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'تم ربط فرد العائلة بنجاح', content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } } } },
            404: { description: 'المستخدم غير موجود', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
    },
    tags: [
      { name: 'المصادقة', description: 'عمليات تسجيل الدخول والخروج وإدارة الجلسات' },
      { name: 'الافراد', description: 'إدارة المستخدمين: إنشاء، تعديل، حذف، قفل، وسوم، عائلة' },
    ],
  },
  apis: [],
};

const specs = swaggerJsdoc(options);

module.exports = { swaggerUi, specs };
