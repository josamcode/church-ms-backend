const mongoose = require('mongoose');

const avatarSchema = new mongoose.Schema(
  {
    url: { type: String, trim: true },
    publicId: { type: String, trim: true },
  },
  { _id: false }
);

const personRefSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
  },
  { _id: false }
);

const servantGroupAssignmentSchema = new mongoose.Schema(
  {
    group: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    servedUserIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'User',
      default: [],
    },
  },
  { _id: false }
);

const meetingGroupAssignmentSchema = new mongoose.Schema(
  {
    group: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    servedUserIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'User',
      default: [],
    },
  },
  { _id: false }
);

const servantSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    normalizedName: {
      type: String,
      select: false,
      index: true,
    },
    responsibility: {
      type: String,
      trim: true,
      maxlength: 160,
    },
    groupsManaged: {
      type: [String],
      default: [],
    },
    groupAssignments: {
      type: [servantGroupAssignmentSchema],
      default: [],
    },
    servedUserIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'User',
      default: [],
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 1000,
    },
  },
  { _id: true }
);

const committeeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    memberUserIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'User',
      default: [],
    },
    memberNames: {
      type: [String],
      default: [],
    },
    details: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 1000,
    },
  },
  { _id: true }
);

const ACTIVITY_TYPES = ['trip', 'conference', 'activity', 'other'];

const meetingActivitySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    type: {
      type: String,
      enum: ACTIVITY_TYPES,
      default: 'other',
    },
    scheduledAt: {
      type: Date,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 1000,
    },
  },
  { _id: true }
);

const meetingSchema = new mongoose.Schema(
  {
    sectorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Sector',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    normalizedName: {
      type: String,
      required: true,
      select: false,
      index: true,
    },
    day: {
      type: String,
      required: true,
      trim: true,
      maxlength: 32,
      index: true,
    },
    time: {
      type: String,
      required: true,
      trim: true,
      maxlength: 10,
    },
    avatar: {
      type: avatarSchema,
      default: undefined,
    },
    serviceSecretary: {
      type: personRefSchema,
      default: undefined,
    },
    assistantSecretaries: {
      type: [personRefSchema],
      default: [],
    },
    servants: {
      type: [servantSchema],
      default: [],
    },
    servedUserIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'User',
      default: [],
    },
    groups: {
      type: [String],
      default: [],
    },
    groupAssignments: {
      type: [meetingGroupAssignmentSchema],
      default: [],
    },
    committees: {
      type: [committeeSchema],
      default: [],
    },
    activities: {
      type: [meetingActivitySchema],
      default: [],
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 3000,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
    deletedAt: {
      type: Date,
    },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

meetingSchema.pre('validate', function (next) {
  if (typeof this.name === 'string') {
    this.name = this.name.trim();
    this.normalizedName = this.name.toLowerCase();
  }

  if (typeof this.day === 'string') {
    this.day = this.day.trim();
  }

  if (Array.isArray(this.groups)) {
    this.groups = [...new Set(this.groups.map((entry) => String(entry || '').trim()).filter(Boolean))];
  }

  if (Array.isArray(this.groupAssignments)) {
    const mergedByGroup = new Map();

    this.groupAssignments.forEach((assignment) => {
      const groupName = String(assignment?.group || '').trim();
      if (!groupName) return;
      const ids = (assignment?.servedUserIds || []).map((entry) => String(entry || '').trim()).filter(Boolean);

      if (!mergedByGroup.has(groupName)) {
        mergedByGroup.set(groupName, new Set(ids));
        return;
      }

      ids.forEach((id) => mergedByGroup.get(groupName).add(id));
    });

    this.groupAssignments = [...mergedByGroup.entries()].map(([group, ids]) => ({
      group,
      servedUserIds: [...ids],
    }));

    const assignmentGroups = this.groupAssignments.map((entry) => entry.group);
    this.groups = [...new Set([...(this.groups || []), ...assignmentGroups])];
  }

  if (Array.isArray(this.servants)) {
    this.servants = this.servants.map((servant) => {
      if (typeof servant?.name === 'string') {
        servant.name = servant.name.trim();
        servant.normalizedName = servant.name.toLowerCase();
      }
      if (typeof servant?.responsibility === 'string') {
        servant.responsibility = servant.responsibility.trim();
      }
      if (Array.isArray(servant?.groupsManaged)) {
        servant.groupsManaged = [
          ...new Set(servant.groupsManaged.map((entry) => String(entry || '').trim()).filter(Boolean)),
        ];
      }

      if (Array.isArray(servant?.groupAssignments)) {
        const mergedByGroup = new Map();

        servant.groupAssignments.forEach((assignment) => {
          const groupName = String(assignment?.group || '').trim();
          if (!groupName) return;
          const ids = (assignment?.servedUserIds || [])
            .map((entry) => String(entry || '').trim())
            .filter(Boolean);

          if (!mergedByGroup.has(groupName)) {
            mergedByGroup.set(groupName, new Set(ids));
            return;
          }

          ids.forEach((id) => mergedByGroup.get(groupName).add(id));
        });

        servant.groupAssignments = [...mergedByGroup.entries()].map(([group, ids]) => ({
          group,
          servedUserIds: [...ids],
        }));

        const assignmentGroups = servant.groupAssignments.map((entry) => entry.group);
        servant.groupsManaged = [...new Set([...(servant.groupsManaged || []), ...assignmentGroups])];
      }
      return servant;
    });
  }

  if (Array.isArray(this.assistantSecretaries)) {
    this.assistantSecretaries = this.assistantSecretaries
      .map((assistant) => ({
        ...assistant,
        name: String(assistant?.name || '').trim(),
      }))
      .filter((assistant) => assistant.name);
  }

  if (this.serviceSecretary && typeof this.serviceSecretary.name === 'string') {
    this.serviceSecretary.name = this.serviceSecretary.name.trim();
  }

  next();
});

meetingSchema.index({ isDeleted: 1, sectorId: 1, day: 1, time: 1, name: 1 });
meetingSchema.index({ isDeleted: 1, createdAt: -1 });
meetingSchema.index({ 'servants.userId': 1, createdAt: -1 });
meetingSchema.index({ 'servants.normalizedName': 1, createdAt: -1 });

const Meeting = mongoose.model('Meeting', meetingSchema);

module.exports = Meeting;
module.exports.ACTIVITY_TYPES = ACTIVITY_TYPES;
