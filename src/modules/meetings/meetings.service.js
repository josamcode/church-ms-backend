const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { buildPaginationMeta } = require('../../utils/pagination');
const { PERMISSIONS } = require('../../constants/permissions');
const redisClient = require('../../config/redis');
const { CACHE_KEYS } = require('../../constants/cacheKeys');
const logger = require('../../utils/logger');
const User = require('../users/user.model');
const Sector = require('./sector.model');
const Meeting = require('./meeting.model');
const {
  DEFAULT_MEETING_REMINDER_TEMPLATE,
  DEFAULT_MEETING_REMINDER_LEAD_MINUTES,
} = require('./meeting.model');
const MeetingResponsibility = require('./meetingResponsibility.model');
const MeetingDocumentation = require('./meetingDocumentation.model');
const {
  MEETING_DOCUMENTATION_ASSET_KINDS,
} = require('./meetingDocumentation.model');
const {
  MEETING_DOCUMENTATION_FIELD_TYPES,
  getOrCreateMeetingDocumentationConfig,
} = require('./meetingDocumentationConfig.model');
const platformSettingsService = require('../settings/platformSettings.service');
const {
  validateDocumentationUpload,
  validateImageUpload,
} = require('../../utils/fileUploads');
const storageService = require('../../services/storage/storage.service');
const { normalizeArabicComparison } = require('../../utils/arabicNormalization');

class MeetingsService {
  _toObjectId(id, fieldName = 'id') {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw ApiError.badRequest(`Invalid ${fieldName}`, 'VALIDATION_ERROR');
    }
    return new mongoose.Types.ObjectId(id);
  }

  _toId(value) {
    if (!value) return null;
    if (typeof value === 'string') return value;
    if (value._id) return String(value._id);
    return String(value);
  }

  _normalizeText(value) {
    return String(value || '').trim();
  }

  _normalizeUniqueStrings(values = []) {
    return [...new Set(values.map((entry) => this._normalizeText(entry)).filter(Boolean))];
  }

  _padNumber(value) {
    return String(value).padStart(2, '0');
  }

  _buildLocalDateKey(date = new Date()) {
    return `${date.getFullYear()}-${this._padNumber(date.getMonth() + 1)}-${this._padNumber(date.getDate())}`;
  }

  _normalizeAttendanceDate(value) {
    const normalizedValue = this._normalizeText(value);
    const matched = normalizedValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!matched) {
      throw ApiError.badRequest('Attendance date must be YYYY-MM-DD', 'VALIDATION_ERROR');
    }

    const year = Number(matched[1]);
    const month = Number(matched[2]);
    const day = Number(matched[3]);
    const parsedDate = new Date(Date.UTC(year, month - 1, day));
    const isValid =
      parsedDate.getUTCFullYear() === year &&
      parsedDate.getUTCMonth() + 1 === month &&
      parsedDate.getUTCDate() === day;

    if (!isValid) {
      throw ApiError.badRequest('Attendance date is invalid', 'VALIDATION_ERROR');
    }

    return {
      dateKey: normalizedValue,
      dayOfWeek: parsedDate.getUTCDay(),
    };
  }

  _getWeekdayFromMeetingDay(day) {
    const weekdayMap = {
      Sunday: 0,
      Monday: 1,
      Tuesday: 2,
      Wednesday: 3,
      Thursday: 4,
      Friday: 5,
      Saturday: 6,
    };

    return weekdayMap[this._normalizeText(day)] ?? null;
  }

  _assertPastMeetingDateAllowed(meetingDay, rawDate, label = 'Date') {
    const { dateKey, dayOfWeek } = this._normalizeAttendanceDate(rawDate);
    const meetingWeekday = this._getWeekdayFromMeetingDay(meetingDay);

    if (meetingWeekday == null || meetingWeekday !== dayOfWeek) {
      throw ApiError.badRequest(
        `${label} must match the meeting day`,
        'VALIDATION_ERROR'
      );
    }

    if (dateKey >= this._buildLocalDateKey()) {
      throw ApiError.badRequest(
        `${label} must be a past meeting date`,
        'VALIDATION_ERROR'
      );
    }

    return dateKey;
  }

  _hasPermission(permissions = [], permission) {
    return Array.isArray(permissions) && permissions.includes(permission);
  }

  _hasAnyPermission(permissions = [], requiredPermissions = []) {
    return (requiredPermissions || []).some((permission) => this._hasPermission(permissions, permission));
  }

  _normalizeMeetingReminderSettings(value = {}) {
    return {
      leadMinutes: platformSettingsService.normalizeMeetingReminderLeadMinutes(
        value?.leadMinutes,
        DEFAULT_MEETING_REMINDER_LEAD_MINUTES
      ),
      template: platformSettingsService.normalizeMeetingReminderTemplate(value?.template),
    };
  }

  _mapMeetingReminderSettings(value = {}) {
    const normalized = this._normalizeMeetingReminderSettings(value);

    return {
      leadMinutes: normalized.leadMinutes,
      template: {
        title: {
          ar: normalized.template?.title?.ar || DEFAULT_MEETING_REMINDER_TEMPLATE.title.ar,
          en: normalized.template?.title?.en || normalized.template?.title?.ar || DEFAULT_MEETING_REMINDER_TEMPLATE.title.en,
        },
        message: {
          ar: normalized.template?.message?.ar || DEFAULT_MEETING_REMINDER_TEMPLATE.message.ar,
          en:
            normalized.template?.message?.en
            || normalized.template?.message?.ar
            || DEFAULT_MEETING_REMINDER_TEMPLATE.message.en,
        },
      },
    };
  }

  _canManageMeetingReminderSettings(accessContext) {
    return accessContext?.allowed && accessContext?.accessLevel === 'full';
  }

  async _clearUserCaches(userIds = []) {
    const uniqueUserIds = [...new Set((userIds || []).map((value) => this._toId(value)).filter(Boolean))];
    if (!uniqueUserIds.length) return;

    await Promise.all(
      uniqueUserIds.map(async (userId) => {
        try {
          await redisClient.del(CACHE_KEYS.USER_PROFILE(userId));
          await redisClient.del(CACHE_KEYS.USER_PERMISSIONS(userId));
        } catch (error) {
          logger.warn(`Failed to clear user cache for ${userId}: ${error.message}`);
        }
      })
    );
  }

  _buildOwnMeetingsFilter(actorUserId) {
    const actorObjectId = this._toObjectId(actorUserId, 'actorUserId');
    return {
      $or: [
        { 'serviceSecretary.userId': actorObjectId },
        { 'assistantSecretaries.userId': actorObjectId },
        { 'servants.userId': actorObjectId },
        { servedUserIds: actorObjectId },
        { 'groupAssignments.servedUserIds': actorObjectId },
        { 'servants.servedUserIds': actorObjectId },
        { 'servants.groupAssignments.servedUserIds': actorObjectId },
      ],
    };
  }

  _isMeetingLeadershipUser(meeting, actorUserId) {
    const actorId = this._toId(actorUserId);
    if (!actorId || !meeting) return false;

    const serviceSecretaryUserId = this._toId(meeting.serviceSecretary?.userId);
    if (serviceSecretaryUserId && serviceSecretaryUserId === actorId) {
      return true;
    }

    return (meeting.assistantSecretaries || []).some((assistant) => {
      const assistantUserId = this._toId(assistant?.userId);
      return assistantUserId && assistantUserId === actorId;
    });
  }

  _findMeetingServantEntry(meeting, actorUserId) {
    const actorId = this._toId(actorUserId);
    if (!actorId || !meeting) return null;

    return (
      (meeting.servants || []).find((servant) => {
        const servantUserId = this._toId(servant?.userId);
        return servantUserId && servantUserId === actorId;
      }) || null
    );
  }

  _isMeetingServedUser(meeting, actorUserId) {
    const actorId = this._toId(actorUserId);
    if (!actorId || !meeting) return false;
    return this._collectAllMeetingMemberIds(meeting).has(actorId);
  }

  _collectAllMeetingMemberIds(meeting) {
    if (!meeting) return new Set();

    const ids = new Set();
    const push = (value) => {
      const id = this._toId(value);
      if (id && mongoose.Types.ObjectId.isValid(id)) {
        ids.add(id);
      }
    };

    (meeting.servedUserIds || []).forEach((servedId) => push(servedId));
    (meeting.groupAssignments || []).forEach((assignment) => {
      (assignment.servedUserIds || []).forEach((servedId) => push(servedId));
    });
    (meeting.servants || []).forEach((servant) => {
      (servant.servedUserIds || []).forEach((servedId) => push(servedId));
      (servant.groupAssignments || []).forEach((assignment) => {
        (assignment.servedUserIds || []).forEach((servedId) => push(servedId));
      });
    });

    return ids;
  }

  _getServantScope(meeting, servantEntry) {
    const groupNames = new Set(
      this._normalizeUniqueStrings([
        ...(servantEntry?.groupsManaged || []),
        ...((servantEntry?.groupAssignments || []).map((entry) => entry?.group)),
      ])
    );

    const scopedMemberIds = new Set();
    const push = (value) => {
      const id = this._toId(value);
      if (id && mongoose.Types.ObjectId.isValid(id)) {
        scopedMemberIds.add(id);
      }
    };

    (servantEntry?.servedUserIds || []).forEach((servedId) => push(servedId));
    (servantEntry?.groupAssignments || []).forEach((assignment) => {
      (assignment?.servedUserIds || []).forEach((servedId) => push(servedId));
    });

    if (groupNames.size > 0) {
      (meeting?.groupAssignments || []).forEach((assignment) => {
        if (!groupNames.has(assignment?.group)) return;
        (assignment?.servedUserIds || []).forEach((servedId) => push(servedId));
      });
    }

    return { groupNames, scopedMemberIds };
  }

  _getMemberScope(meeting, actorUserId) {
    const actorId = this._toId(actorUserId);
    const groupNames = new Set();
    const scopedMemberIds = new Set();
    const servantIds = new Set();
    if (!actorId || !meeting) {
      return { groupNames, scopedMemberIds, servantIds };
    }

    const pushMemberId = (value) => {
      const id = this._toId(value);
      if (id && mongoose.Types.ObjectId.isValid(id)) {
        scopedMemberIds.add(id);
      }
    };

    (meeting.groupAssignments || []).forEach((assignment) => {
      const containsViewer = (assignment.servedUserIds || []).some(
        (servedId) => this._toId(servedId) === actorId
      );
      if (containsViewer && assignment.group) {
        groupNames.add(assignment.group);
      }
    });

    (meeting.servants || []).forEach((servant) => {
      (servant.groupAssignments || []).forEach((assignment) => {
        const containsViewer = (assignment.servedUserIds || []).some(
          (servedId) => this._toId(servedId) === actorId
        );
        if (containsViewer && assignment.group) {
          groupNames.add(assignment.group);
        }
      });
    });

    scopedMemberIds.add(actorId);

    if (groupNames.size > 0) {
      (meeting.groupAssignments || []).forEach((assignment) => {
        if (!groupNames.has(assignment.group)) return;
        (assignment.servedUserIds || []).forEach((servedId) => pushMemberId(servedId));
      });

      (meeting.servants || []).forEach((servant) => {
        const servantGroups = new Set(
          this._normalizeUniqueStrings([
            ...(servant.groupsManaged || []),
            ...((servant.groupAssignments || []).map((assignment) => assignment.group)),
          ])
        );
        const intersects = [...groupNames].some((groupName) => servantGroups.has(groupName));
        const servesViewer = (servant.servedUserIds || []).some(
          (servedId) => this._toId(servedId) === actorId
        );

        if (intersects || servesViewer) {
          const servantId = this._toId(servant._id);
          if (servantId) servantIds.add(servantId);
        }

        (servant.groupAssignments || []).forEach((assignment) => {
          if (!groupNames.has(assignment.group)) return;
          (assignment.servedUserIds || []).forEach((servedId) => pushMemberId(servedId));
        });
      });
    }

    return { groupNames, scopedMemberIds, servantIds };
  }

  _resolveMeetingAccess({ meeting, actorUserId, userPermissions = [] }) {
    if (!actorUserId) {
      return {
        allowed: true,
        accessLevel: 'full',
        actorUserId: null,
        isLeadership: true,
        servantEntry: null,
      };
    }

    const canViewAll = this._hasAnyPermission(userPermissions, [
      PERMISSIONS.MEETINGS_VIEW,
      PERMISSIONS.MEETINGS_UPDATE,
      PERMISSIONS.MEETINGS_SERVANTS_MANAGE,
      PERMISSIONS.MEETINGS_COMMITTEES_MANAGE,
      PERMISSIONS.MEETINGS_ACTIVITIES_MANAGE,
    ]);
    if (canViewAll) {
      return {
        allowed: true,
        accessLevel: 'full',
        actorUserId: this._toId(actorUserId),
        isLeadership: true,
        servantEntry: this._findMeetingServantEntry(meeting, actorUserId),
      };
    }

    const canViewOwn =
      this._hasPermission(userPermissions, PERMISSIONS.MEETINGS_VIEW_OWN) ||
      this._hasPermission(userPermissions, PERMISSIONS.MEETINGS_MEMBERS_VIEW) ||
      this._hasPermission(userPermissions, PERMISSIONS.MEETINGS_MEMBERS_NOTES_UPDATE);

    if (!canViewOwn) {
      return { allowed: false };
    }

    const isLeadership = this._isMeetingLeadershipUser(meeting, actorUserId);
    const servantEntry = this._findMeetingServantEntry(meeting, actorUserId);
    const isServedUser = this._isMeetingServedUser(meeting, actorUserId);
    const memberScope = isServedUser ? this._getMemberScope(meeting, actorUserId) : null;

    if (!isLeadership && !servantEntry && !isServedUser) {
      return { allowed: false };
    }

    return {
      allowed: true,
      accessLevel: isLeadership ? 'full' : servantEntry ? 'servant' : 'member',
      actorUserId: this._toId(actorUserId),
      isLeadership,
      servantEntry,
      memberScope,
    };
  }

  _extractPayloadUserIds(payload = {}) {
    const ids = [];

    const pushId = (value) => {
      if (value && mongoose.Types.ObjectId.isValid(value)) {
        ids.push(String(value));
      }
    };

    (payload.officials || []).forEach((official) => pushId(official.userId));
    if (payload.serviceSecretary?.userId) pushId(payload.serviceSecretary.userId);
    (payload.assistantSecretaries || []).forEach((assistant) => pushId(assistant.userId));
    (payload.servants || []).forEach((servant) => {
      pushId(servant.userId);
      (servant.servedUserIds || []).forEach((servedId) => pushId(servedId));
      (servant.groupAssignments || []).forEach((assignment) => {
        (assignment.servedUserIds || []).forEach((servedId) => pushId(servedId));
      });
    });
    (payload.servedUserIds || []).forEach((servedId) => pushId(servedId));
    (payload.groupAssignments || []).forEach((assignment) => {
      (assignment.servedUserIds || []).forEach((servedId) => pushId(servedId));
    });
    (payload.committees || []).forEach((committee) => {
      (committee.memberUserIds || []).forEach((memberId) => pushId(memberId));
    });

    return [...new Set(ids)];
  }

  async _buildUserMap(ids = [], session = null) {
    if (!ids.length) return new Map();
    let query = User.find({ _id: { $in: ids }, isDeleted: { $ne: true } })
      .select('fullName phonePrimary');
    if (session) query = query.session(session);
    const users = await query.lean();
    return new Map(users.map((user) => [String(user._id), user]));
  }

  _hydratePerson(person, userMap) {
    if (!person) return null;
    const personObj = {
      ...(person.userId ? { userId: this._toId(person.userId) } : {}),
      name: this._normalizeText(person.name),
    };

    if (personObj.userId) {
      const user = userMap.get(personObj.userId);
      if (!user && !personObj.name) {
        throw ApiError.badRequest('Linked user was not found', 'USER_NOT_FOUND');
      }
      if (!personObj.name && user?.fullName) {
        personObj.name = user.fullName;
      }
    }

    if (!personObj.name) {
      throw ApiError.badRequest('Person name is required', 'VALIDATION_ERROR');
    }

    return personObj;
  }

  _hydrateOfficials(officials = [], userMap) {
    return (officials || []).map((official) => {
      const hydratedPerson = this._hydratePerson(official, userMap);
      return {
        ...hydratedPerson,
        title: this._normalizeText(official.title) || undefined,
        notes: this._normalizeText(official.notes) || undefined,
      };
    });
  }

  _normalizeServantGroupAssignments(assignments = []) {
    const mergedByGroup = new Map();

    (assignments || []).forEach((assignment) => {
      const groupName = this._normalizeText(assignment?.group);
      if (!groupName) return;

      const servedUserIds = (assignment?.servedUserIds || [])
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => this._toId(id));

      if (!mergedByGroup.has(groupName)) {
        mergedByGroup.set(groupName, new Set(servedUserIds));
        return;
      }

      servedUserIds.forEach((id) => mergedByGroup.get(groupName).add(id));
    });

    return [...mergedByGroup.entries()].map(([group, servedUserIds]) => ({
      group,
      servedUserIds: [...servedUserIds],
    }));
  }

  _hydrateServants(servants = [], userMap) {
    return (servants || []).map((servant) => {
      const hydratedPerson = this._hydratePerson(servant, userMap);
      const directServedUserIds = (servant.servedUserIds || [])
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => this._toId(id));
      const groupAssignments = this._normalizeServantGroupAssignments(servant.groupAssignments || []);
      const groupedServedUserIds = groupAssignments.flatMap((entry) => entry.servedUserIds || []);
      const groupsManaged = this._normalizeUniqueStrings([
        ...(servant.groupsManaged || []),
        ...groupAssignments.map((entry) => entry.group),
      ]);
      const servedUserIds = [...new Set([...directServedUserIds, ...groupedServedUserIds])];

      return {
        ...hydratedPerson,
        responsibility: this._normalizeText(servant.responsibility) || undefined,
        groupsManaged,
        groupAssignments: groupAssignments.filter((entry) => groupsManaged.includes(entry.group)),
        servedUserIds,
        notes: this._normalizeText(servant.notes) || undefined,
      };
    });
  }

  _hydrateCommittees(committees = [], userMap) {
    return (committees || []).map((committee) => ({
      name: this._normalizeText(committee.name),
      memberUserIds: [...new Set((committee.memberUserIds || []).map((id) => this._toId(id)))],
      memberNames: this._normalizeUniqueStrings(committee.memberNames || []),
      details:
        committee.details && typeof committee.details === 'object' && !Array.isArray(committee.details)
          ? committee.details
          : {},
      notes: this._normalizeText(committee.notes) || undefined,
    }));
  }

  _hydrateActivities(activities = []) {
    return (activities || []).map((activity) => ({
      name: this._normalizeText(activity.name),
      type: this._normalizeText(activity.type) || 'other',
      ...(activity.scheduledAt ? { scheduledAt: new Date(activity.scheduledAt) } : {}),
      notes: this._normalizeText(activity.notes) || undefined,
    }));
  }

  _normalizeMeetingGroupAssignments(assignments = []) {
    const mergedByGroup = new Map();

    (assignments || []).forEach((assignment) => {
      const groupName = this._normalizeText(assignment?.group);
      if (!groupName) return;

      const servedUserIds = (assignment?.servedUserIds || [])
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => this._toId(id));

      if (!mergedByGroup.has(groupName)) {
        mergedByGroup.set(groupName, new Set(servedUserIds));
        return;
      }

      servedUserIds.forEach((id) => mergedByGroup.get(groupName).add(id));
    });

    return [...mergedByGroup.entries()].map(([group, servedUserIds]) => ({
      group,
      servedUserIds: [...servedUserIds],
    }));
  }

  _mapLinkedUserFromAny(userLike) {
    if (!userLike) return null;
    const id = this._toId(userLike);
    return {
      id,
      fullName: userLike.fullName || null,
      phonePrimary: userLike.phonePrimary || null,
    };
  }

  _mapPersonWithUser(person) {
    if (!person) return null;
    const linkedUser = person.userId && typeof person.userId === 'object'
      ? this._mapLinkedUserFromAny(person.userId)
      : person.userId
        ? { id: this._toId(person.userId), fullName: null, phonePrimary: null }
        : null;

    return {
      name: person.name,
      user: linkedUser,
    };
  }

  _mapSector(sector) {
    const officials = Array.isArray(sector.officials)
      ? sector.officials.map((official) => {
          const user = official.userId && typeof official.userId === 'object'
            ? this._mapLinkedUserFromAny(official.userId)
            : official.userId
              ? { id: this._toId(official.userId), fullName: null, phonePrimary: null }
              : null;

          return {
            id: this._toId(official._id),
            name: official.name,
            title: official.title || '',
            notes: official.notes || '',
            user,
          };
        })
      : [];

    return {
      id: this._toId(sector._id),
      name: sector.name,
      avatar: sector.avatar || null,
      officials,
      notes: sector.notes || '',
      createdAt: sector.createdAt,
      updatedAt: sector.updatedAt,
    };
  }

  /**
   * Lightweight sector projection for LIST views. Sector lists (management,
   * dashboard, meeting form dropdown) only display the sector identity, avatar,
   * and official names/count — never the linked user contact details. Emitting
   * just those fields lets `listSectors` skip populating `officials.userId`.
   */
  _mapSectorSummary(sector) {
    const officials = Array.isArray(sector.officials) ? sector.officials : [];
    return {
      id: this._toId(sector._id),
      name: sector.name,
      avatar: sector.avatar || null,
      officials: officials.map((official) => ({ name: official.name })),
      officialsCount: officials.length,
      updatedAt: sector.updatedAt,
    };
  }

  _mapMeeting(meeting) {
    const sector = meeting.sectorId && typeof meeting.sectorId === 'object'
      ? {
          id: this._toId(meeting.sectorId._id),
          name: meeting.sectorId.name,
          avatar: meeting.sectorId.avatar || null,
        }
      : meeting.sectorId
        ? { id: this._toId(meeting.sectorId), name: null, avatar: null }
        : null;

    const serviceSecretary = this._mapPersonWithUser(meeting.serviceSecretary);
    const assistantSecretaries = (meeting.assistantSecretaries || []).map((assistant) =>
      this._mapPersonWithUser(assistant)
    );

    const servedUsers = (meeting.servedUserIds || []).map((servedUser) =>
      this._mapLinkedUserFromAny(servedUser)
    );
    const groupAssignments = (meeting.groupAssignments || []).map((assignment) => ({
      group: assignment.group,
      servedUsers: (assignment.servedUserIds || []).map((servedUser) =>
        this._mapLinkedUserFromAny(servedUser)
      ),
    }));

    const servants = (meeting.servants || []).map((servant) => ({
      id: this._toId(servant._id),
      name: servant.name,
      responsibility: servant.responsibility || '',
      groupsManaged: servant.groupsManaged || [],
      groupAssignments: (servant.groupAssignments || []).map((assignment) => ({
        group: assignment.group,
        servedUsers: (assignment.servedUserIds || []).map((servedUser) =>
          this._mapLinkedUserFromAny(servedUser)
        ),
      })),
      notes: servant.notes || '',
      user:
        servant.userId && typeof servant.userId === 'object'
          ? this._mapLinkedUserFromAny(servant.userId)
          : servant.userId
            ? { id: this._toId(servant.userId), fullName: null, phonePrimary: null }
            : null,
      servedUsers: (servant.servedUserIds || []).map((servedUser) =>
        this._mapLinkedUserFromAny(servedUser)
      ),
    }));

    const committees = (meeting.committees || []).map((committee) => ({
      id: this._toId(committee._id),
      name: committee.name,
      details: committee.details || {},
      notes: committee.notes || '',
      memberNames: committee.memberNames || [],
      members: (committee.memberUserIds || []).map((member) => this._mapLinkedUserFromAny(member)),
    }));

    const activities = (meeting.activities || []).map((activity) => ({
      id: this._toId(activity._id),
      name: activity.name,
      type: activity.type,
      scheduledAt: activity.scheduledAt || null,
      notes: activity.notes || '',
    }));

    return {
      id: this._toId(meeting._id),
      sector,
      name: meeting.name,
      day: meeting.day,
      time: meeting.time,
      avatar: meeting.avatar || null,
      serviceSecretary,
      assistantSecretaries,
      servants,
      servedUsers,
      groups: meeting.groups || [],
      groupAssignments,
      committees,
      activities,
      reminderSettings: this._mapMeetingReminderSettings(meeting.reminderSettings),
      notes: meeting.notes || '',
      createdAt: meeting.createdAt,
      updatedAt: meeting.updatedAt,
    };
  }

  _mapMeetingForServant(meeting, servantEntry) {
    const mappedMeeting = this._mapMeeting(meeting);
    const { groupNames, scopedMemberIds } = this._getServantScope(meeting, servantEntry);

    const filterUsers = (users = [], groupName) => {
      if (scopedMemberIds.size === 0) {
        return users;
      }

      const filtered = (users || []).filter((user) => {
        const id = this._toId(user?.id || user?._id);
        return id && scopedMemberIds.has(id);
      });

      if (filtered.length > 0) return filtered;
      if (groupName && groupNames.has(groupName)) return users;
      return [];
    };

    const groupAssignments = (mappedMeeting.groupAssignments || [])
      .map((assignment) => ({
        ...assignment,
        servedUsers: filterUsers(assignment.servedUsers || [], assignment.group),
      }))
      .filter((assignment) => {
        if (groupNames.has(assignment.group)) return true;
        return (assignment.servedUsers || []).length > 0;
      });

    const visibleGroups = this._normalizeUniqueStrings(groupAssignments.map((entry) => entry.group));
    const servantId = this._toId(servantEntry?._id);
    const ownServant =
      (mappedMeeting.servants || []).find((servant) => this._toId(servant.id) === servantId) || null;

    const ownServantAssignments = (ownServant?.groupAssignments || [])
      .map((assignment) => ({
        ...assignment,
        servedUsers: filterUsers(assignment.servedUsers || [], assignment.group),
      }))
      .filter((assignment) => {
        if (groupNames.has(assignment.group)) return true;
        return (assignment.servedUsers || []).length > 0;
      });

    const ownServantGroups = this._normalizeUniqueStrings(
      (ownServant?.groupsManaged || []).filter((groupName) => visibleGroups.includes(groupName))
    );

    const ownServantServedUsers = filterUsers(ownServant?.servedUsers || []);

    return {
      ...mappedMeeting,
      servedUsers: [],
      groups: visibleGroups,
      groupAssignments,
      servants: ownServant
        ? [
            {
              ...ownServant,
              groupsManaged: ownServantGroups,
              groupAssignments: ownServantAssignments,
              servedUsers: ownServantServedUsers,
            },
          ]
        : [],
      committees: [],
      activities: [],
      viewerContext: {
        accessLevel: 'servant',
        canViewAllDetails: false,
        canViewAllServedUsers: false,
        canViewLeadership: false,
        canViewServants: false,
        canViewCommittees: false,
        canViewActivities: false,
        canManageReminderSettings: false,
        canManageDocumentationSettings: false,
      },
    };
  }

  _mapMeetingForMember(meeting, actorUserId, memberScope) {
    const mappedMeeting = this._mapMeeting(meeting);
    const groupNames = memberScope?.groupNames || new Set();
    const scopedMemberIds = memberScope?.scopedMemberIds || new Set();
    const scopedServantIds = memberScope?.servantIds || new Set();

    const filterUsers = (users = []) =>
      (users || []).filter((user) => {
        const id = this._toId(user?.id || user?._id);
        if (!id) return false;
        if (scopedMemberIds.size === 0) {
          return id === this._toId(actorUserId);
        }
        return scopedMemberIds.has(id);
      });

    const groupAssignments = (mappedMeeting.groupAssignments || [])
      .map((assignment) => ({
        ...assignment,
        servedUsers: filterUsers(assignment.servedUsers || []),
      }))
      .filter((assignment) => groupNames.has(assignment.group));

    const visibleGroups = this._normalizeUniqueStrings(groupAssignments.map((entry) => entry.group));

    const servants = (mappedMeeting.servants || [])
      .filter((servant) => {
        const servantId = this._toId(servant.id);
        const servantGroups = new Set(
          this._normalizeUniqueStrings([
            ...(servant.groupsManaged || []),
            ...((servant.groupAssignments || []).map((entry) => entry.group)),
          ])
        );
        const handlesScopedMembers = (servant.servedUsers || []).some((user) => {
          const id = this._toId(user?.id || user?._id);
          return id && scopedMemberIds.has(id);
        });

        return (
          (servantId && scopedServantIds.has(servantId)) ||
          [...visibleGroups].some((groupName) => servantGroups.has(groupName)) ||
          handlesScopedMembers
        );
      })
      .map((servant) => {
        const servantGroups = this._normalizeUniqueStrings(
          (servant.groupsManaged || []).filter((groupName) => visibleGroups.includes(groupName))
        );
        const servantGroupAssignments = (servant.groupAssignments || [])
          .map((assignment) => ({
            ...assignment,
            servedUsers: filterUsers(assignment.servedUsers || []),
          }))
          .filter((assignment) => visibleGroups.includes(assignment.group));

        const servantServedUsers = filterUsers(servant.servedUsers || []);

        return {
          ...servant,
          groupsManaged: servantGroups,
          groupAssignments: servantGroupAssignments,
          servedUsers: servantServedUsers,
        };
      });

    return {
      ...mappedMeeting,
      servedUsers: [],
      groups: visibleGroups,
      groupAssignments,
      servants,
      viewerContext: {
        accessLevel: 'member',
        canViewAllDetails: false,
        canViewAllServedUsers: false,
        canViewLeadership: true,
        canViewServants: true,
        canViewCommittees: true,
        canViewActivities: true,
        canManageReminderSettings: false,
        canManageDocumentationSettings: false,
      },
    };
  }

  _mapMeetingByAccess(meeting, accessContext) {
    if (accessContext?.accessLevel === 'servant') {
      return this._mapMeetingForServant(meeting, accessContext.servantEntry);
    }
    if (accessContext?.accessLevel === 'member') {
      return this._mapMeetingForMember(meeting, accessContext.actorUserId, accessContext.memberScope);
    }

    const mappedMeeting = this._mapMeeting(meeting);
    return {
      ...mappedMeeting,
      viewerContext: {
        accessLevel: 'full',
        canViewAllDetails: true,
        canViewAllServedUsers: true,
        canViewLeadership: true,
        canViewServants: true,
        canViewCommittees: true,
        canViewActivities: true,
        canManageReminderSettings: this._canManageMeetingReminderSettings(accessContext),
        canManageDocumentationSettings: this._canManageMeetingDocumentationSettings(accessContext),
      },
    };
  }

  /**
   * Project a fully-mapped meeting down to the lightweight summary used by LIST
   * and DASHBOARD views. These only need identity + collection *counts* (never
   * the served-user / servant / committee contents). No served-user id array is
   * emitted — the dashboard's unique served-user total is aggregated server-side
   * into the list response `meta` (see `listMeetings`).
   */
  _toMeetingSummary(mapped) {
    if (!mapped) return null;
    return {
      id: mapped.id,
      name: mapped.name,
      day: mapped.day,
      time: mapped.time,
      avatar: mapped.avatar || null,
      sector: mapped.sector || null,
      groupsCount: (mapped.groups || []).length,
      assistantsCount: (mapped.assistantSecretaries || []).length,
      servantsCount: (mapped.servants || []).length,
      committeesCount: (mapped.committees || []).length,
      activitiesCount: (mapped.activities || []).length,
      servedUsersCount: (mapped.servedUsers || []).length,
      createdAt: mapped.createdAt,
      updatedAt: mapped.updatedAt,
      viewerContext: mapped.viewerContext,
    };
  }

  /**
   * Project a fully-mapped meeting down to the OVERVIEW shape used by the meeting
   * details page. Leadership and group members keep their contact details (they
   * are displayed), but the top-level served-user list, per-servant served-user
   * lists, and committee members are collapsed to counts because the page only
   * renders their sizes.
   */
  _toMeetingOverview(mapped) {
    if (!mapped) return null;
    return {
      ...mapped,
      servedUsers: undefined,
      servedUsersCount: (mapped.servedUsers || []).length,
      servants: (mapped.servants || []).map((servant) => ({
        id: servant.id,
        name: servant.name,
        responsibility: servant.responsibility,
        groupsManaged: servant.groupsManaged,
        notes: servant.notes,
        servedUsersCount: (servant.servedUsers || []).length,
      })),
      committees: (mapped.committees || []).map((committee) => ({
        id: committee.id,
        name: committee.name,
        notes: committee.notes,
        memberNames: committee.memberNames,
        membersCount: (committee.members || []).length,
      })),
    };
  }

  _extractLinkedUserIdsFromMeeting(meeting) {
    if (!meeting) return [];

    const ids = new Set();
    const push = (value) => {
      const id = this._toId(value);
      if (id && mongoose.Types.ObjectId.isValid(id)) ids.add(id);
    };

    push(meeting.serviceSecretary?.userId);
    (meeting.assistantSecretaries || []).forEach((assistant) => push(assistant.userId));
    (meeting.servedUserIds || []).forEach((servedId) => push(servedId));
    (meeting.groupAssignments || []).forEach((assignment) => {
      (assignment.servedUserIds || []).forEach((servedId) => push(servedId));
    });

    (meeting.servants || []).forEach((servant) => {
      push(servant.userId);
      (servant.servedUserIds || []).forEach((servedId) => push(servedId));
      (servant.groupAssignments || []).forEach((assignment) => {
        (assignment.servedUserIds || []).forEach((servedId) => push(servedId));
      });
    });

    (meeting.committees || []).forEach((committee) => {
      (committee.memberUserIds || []).forEach((memberId) => push(memberId));
    });

    return [...ids];
  }

  async _syncMeetingLinks(meetingId, previousMeetingDoc, nextMeetingDoc, { session = null } = {}) {
    const previousIds = new Set(this._extractLinkedUserIdsFromMeeting(previousMeetingDoc));
    const nextIds = new Set(this._extractLinkedUserIdsFromMeeting(nextMeetingDoc));

    const idsToAdd = [...nextIds].filter((id) => !previousIds.has(id));
    const idsToRemove = [...previousIds].filter((id) => !nextIds.has(id));

    const operations = [];
    if (idsToAdd.length) {
      operations.push(
        User.updateMany(
          { _id: { $in: idsToAdd }, isDeleted: { $ne: true } },
          { $addToSet: { meetingIds: this._toObjectId(meetingId) } },
          { session }
        )
      );
    }

    if (idsToRemove.length) {
      operations.push(
        User.updateMany(
          { _id: { $in: idsToRemove }, isDeleted: { $ne: true } },
          { $pull: { meetingIds: this._toObjectId(meetingId) } },
          { session }
        )
      );
    }

    if (operations.length) {
      await Promise.all(operations);
    }
  }

  async _upsertResponsibilitiesFromServants(servants = []) {
    const labels = this._normalizeUniqueStrings(
      servants.map((servant) => servant?.responsibility).filter(Boolean)
    );

    if (!labels.length) return;

    const now = new Date();
    await Promise.all(
      labels.map((label) => {
        const normalizedLabel = label.toLowerCase();
        return MeetingResponsibility.findOneAndUpdate(
          { normalizedLabel },
          {
            $set: {
              label,
              lastUsedAt: now,
            },
            $inc: {
              usageCount: 1,
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
      })
    );
  }

  async _assertSectorExists(sectorId) {
    const sector = await Sector.findOne({ _id: this._toObjectId(sectorId), isDeleted: { $ne: true } })
      .select('_id name')
      .lean();

    if (!sector) {
      throw ApiError.notFound('Sector was not found', 'RESOURCE_NOT_FOUND');
    }

    return sector;
  }

  _assertSectionPermissions({ permissions = [], payload = {} }) {
    const requiredPermissionBySection = [
      {
        condition: Array.isArray(payload.servants) && payload.servants.length > 0,
        permission: 'MEETINGS_SERVANTS_MANAGE',
      },
      {
        condition: Array.isArray(payload.committees) && payload.committees.length > 0,
        permission: 'MEETINGS_COMMITTEES_MANAGE',
      },
      {
        condition: Array.isArray(payload.activities) && payload.activities.length > 0,
        permission: 'MEETINGS_ACTIVITIES_MANAGE',
      },
    ];

    requiredPermissionBySection.forEach((entry) => {
      if (entry.condition && !permissions.includes(entry.permission)) {
        throw ApiError.forbidden('Missing permission for this process', 'PERMISSION_DENIED');
      }
    });
  }

  async uploadImageToStorage(file) {
    const fileDetails = validateImageUpload(file, { emptyLabel: 'image' });

    const result = await storageService.uploadFile(file, {
      prefix: 'meetings/avatars',
      fileDetails,
      failureMessage: 'Failed to upload image',
    });

    return {
      url: result.url,
      storageKey: result.storageKey,
      provider: result.provider,
      mimeType: result.mimeType,
      size: result.size,
    };
  }

  _resolveDocumentationAssetUploadConfig(fileDetails, meetingId, documentationDate) {
    if (fileDetails.kind === 'image') {
      return {
        kind: 'image',
        resourceType: 'image',
        folder: `church/meeting-documentation/${String(meetingId)}/${documentationDate}/images`,
      };
    }

    if (fileDetails.kind === 'video') {
      return {
        kind: 'video',
        resourceType: 'video',
        folder: `church/meeting-documentation/${String(meetingId)}/${documentationDate}/videos`,
      };
    }

    return {
      kind: 'document',
      resourceType: 'raw',
      folder: `church/meeting-documentation/${String(meetingId)}/${documentationDate}/documents`,
    };
  }

  async _assertDocumentationUploadAllowed(
    meetingId,
    documentationDate,
    { actorUserId, userPermissions = [] } = {}
  ) {
    if (!this._canManageMeetingDocumentation(userPermissions)) {
      throw ApiError.forbidden('Missing permission for this process', 'PERMISSION_DENIED');
    }

    const meeting = await this._getMeetingForAttendance(meetingId);
    const accessContext = this._resolveMeetingAccess({
      meeting,
      actorUserId,
      userPermissions,
    });

    if (!accessContext.allowed || accessContext.accessLevel === 'member') {
      throw ApiError.forbidden(
        'You are not allowed to upload documentation assets for this meeting',
        'PERMISSION_DENIED'
      );
    }

    return this._assertPastMeetingDateAllowed(
      meeting.day,
      documentationDate,
      'Documentation date'
    );
  }

  async uploadDocumentationAssetToStorage(
    file,
    { meetingId, documentationDate, actorUserId, userPermissions = [] } = {}
  ) {
    const normalizedDocumentationDate = await this._assertDocumentationUploadAllowed(
      meetingId,
      documentationDate,
      { actorUserId, userPermissions }
    );
    const fileDetails = validateDocumentationUpload(file, { emptyLabel: 'file' });
    const uploadConfig = this._resolveDocumentationAssetUploadConfig(
      fileDetails,
      meetingId,
      normalizedDocumentationDate
    );

    const result = await storageService.uploadFile(file, {
      prefix: uploadConfig.folder,
      fileDetails,
      failureMessage: 'Failed to upload documentation file',
    });

    return {
      url: result.url,
      storageKey: result.storageKey,
      provider: result.provider,
      originalName: fileDetails.originalName || '',
      mimeType: fileDetails.mimeType || '',
      kind: uploadConfig.kind,
      resourceType: uploadConfig.resourceType,
      bytes: fileDetails.size || 0,
      size: fileDetails.size || 0,
    };
  }

  async createSector(payload, actorUserId) {
    const userIds = this._extractPayloadUserIds(payload);
    const userMap = await this._buildUserMap(userIds);

    const sector = await Sector.create({
      name: payload.name,
      avatar: payload.avatar,
      officials: this._hydrateOfficials(payload.officials || [], userMap),
      notes: this._normalizeText(payload.notes) || undefined,
      createdBy: actorUserId,
      updatedBy: actorUserId,
    });

    const populated = await Sector.findById(sector._id)
      .populate('officials.userId', 'fullName phonePrimary')
      .lean();

    return this._mapSector(populated);
  }

  async listSectors({ cursor, limit = 20, order = 'asc', search }) {
    const query = {
      isDeleted: { $ne: true },
    };

    if (search) {
      query.name = { $regex: this._normalizeText(search), $options: 'i' };
    }

    if (cursor) {
      const cursorDate = new Date(cursor);
      if (!Number.isNaN(cursorDate.getTime())) {
        query.createdAt = {
          [order === 'desc' ? '$lt' : '$gt']: cursorDate,
        };
      }
    }

    const sortDirection = order === 'desc' ? -1 : 1;
    // Lean list: sector lists only show identity/avatar/official names + counts,
    // so we skip populating `officials.userId` (contact details) entirely.
    const sectors = await Sector.find(query)
      .sort({ createdAt: sortDirection, _id: sortDirection })
      .limit(limit)
      .select('name avatar officials updatedAt createdAt')
      .lean();

    return {
      sectors: sectors.map((sector) => this._mapSectorSummary(sector)),
      meta: buildPaginationMeta(sectors, limit, 'createdAt'),
    };
  }

  async getSectorById(id) {
    const sector = await Sector.findOne({ _id: this._toObjectId(id), isDeleted: { $ne: true } })
      .populate('officials.userId', 'fullName phonePrimary')
      .lean();

    if (!sector) {
      throw ApiError.notFound('Sector was not found', 'RESOURCE_NOT_FOUND');
    }

    return this._mapSector(sector);
  }

  async updateSector(id, payload, actorUserId) {
    const sector = await Sector.findOne({ _id: this._toObjectId(id), isDeleted: { $ne: true } });
    if (!sector) {
      throw ApiError.notFound('Sector was not found', 'RESOURCE_NOT_FOUND');
    }

    const userIds = this._extractPayloadUserIds(payload);
    const userMap = await this._buildUserMap(userIds);
    const previousAvatarStorageKey = sector.avatar?.storageKey || '';

    if (payload.name !== undefined) sector.name = payload.name;
    if (payload.avatar !== undefined) sector.avatar = payload.avatar || undefined;
    if (payload.officials !== undefined) sector.officials = this._hydrateOfficials(payload.officials, userMap);
    if (payload.notes !== undefined) sector.notes = this._normalizeText(payload.notes) || undefined;

    sector.updatedBy = actorUserId;
    await sector.save();

    if (
      payload.avatar !== undefined &&
      previousAvatarStorageKey &&
      previousAvatarStorageKey !== sector.avatar?.storageKey
    ) {
      await storageService.deleteFile(previousAvatarStorageKey);
    }

    const populated = await Sector.findById(sector._id)
      .populate('officials.userId', 'fullName phonePrimary')
      .lean();

    return this._mapSector(populated);
  }

  async deleteSector(id, actorUserId) {
    const sector = await Sector.findOne({ _id: this._toObjectId(id), isDeleted: { $ne: true } });
    if (!sector) {
      throw ApiError.notFound('Sector was not found', 'RESOURCE_NOT_FOUND');
    }

    sector.isDeleted = true;
    sector.deletedAt = new Date();
    sector.deletedBy = actorUserId;
    sector.updatedBy = actorUserId;
    await sector.save();
    if (sector.avatar?.storageKey) {
      await storageService.deleteFile(sector.avatar.storageKey);
    }

    const meetings = await Meeting.find({ sectorId: sector._id, isDeleted: { $ne: true } }).select('_id').lean();
    const meetingIds = meetings.map((meeting) => meeting._id);

    if (meetingIds.length) {
      await Meeting.updateMany(
        { _id: { $in: meetingIds } },
        {
          $set: {
            isDeleted: true,
            deletedAt: new Date(),
            deletedBy: actorUserId,
            updatedBy: actorUserId,
          },
        }
      );

      await User.updateMany(
        { meetingIds: { $in: meetingIds }, isDeleted: { $ne: true } },
        { $pull: { meetingIds: { $in: meetingIds } } }
      );
    }
  }

  async createMeeting(payload, actorUserId, userPermissions = []) {
    this._assertSectionPermissions({ permissions: userPermissions, payload });

    await this._assertSectorExists(payload.sectorId);

    const userIds = this._extractPayloadUserIds(payload);
    const userMap = await this._buildUserMap(userIds);
    const groupAssignments = this._normalizeMeetingGroupAssignments(payload.groupAssignments || []);
    const groups = this._normalizeUniqueStrings([
      ...(payload.groups || []),
      ...groupAssignments.map((entry) => entry.group),
    ]);
    const groupedServedUserIds = [...new Set(groupAssignments.flatMap((entry) => entry.servedUserIds || []))];

    const meeting = await Meeting.create({
      sectorId: payload.sectorId,
      name: payload.name,
      day: payload.day,
      time: payload.time,
      avatar: payload.avatar,
      serviceSecretary: payload.serviceSecretary
        ? this._hydratePerson(payload.serviceSecretary, userMap)
        : undefined,
      assistantSecretaries: (payload.assistantSecretaries || []).map((assistant) =>
        this._hydratePerson(assistant, userMap)
      ),
      servants: this._hydrateServants(payload.servants || [], userMap),
      servedUserIds: [
        ...new Set([
          ...(payload.servedUserIds || []).map((id) => this._toId(id)),
          ...groupedServedUserIds,
        ]),
      ],
      groups,
      groupAssignments,
      committees: this._hydrateCommittees(payload.committees || [], userMap),
      activities: this._hydrateActivities(payload.activities || []),
      notes: this._normalizeText(payload.notes) || undefined,
      createdBy: actorUserId,
      updatedBy: actorUserId,
    });

    await this._upsertResponsibilitiesFromServants(meeting.servants || []);
    await this._syncMeetingLinks(meeting._id, null, meeting.toObject());

    return this.getMeetingById(meeting._id);
  }

  /**
   * FAST PATH for `listMeetings({ summary: true })` when the actor sees every
   * meeting in full (no per-document scoping).
   *
   * Why this exists: the summary shape is nothing but identity + collection
   * *counts*, yet fetching whole documents to compute those counts in Node moved
   * ~446 KB over the wire for 17 meetings. `servants` (69%), `groupAssignments`
   * (14%) and `servedUserIds` (13%) are raw ObjectId arrays that the summary
   * never reads — it only needs their `.length`. Measured against Atlas the
   * transfer, not the query, was the cost (server `executionTimeMillis` was 0
   * while the driver spent ~4.9s); throughput is the binding constraint, so the
   * fix is to count inside MongoDB and ship integers.
   *
   * SAFETY — this must stay equivalent to the generic path, which maps each
   * document through `_resolveMeetingAccess` + `_mapMeetingByAccess`:
   *   - It runs ONLY when access resolves to `full` for every document (viewer
   *     has a full-view permission, or there is no actor at all). In that branch
   *     `_resolveMeetingAccess` short-circuits to `allowed: true` before reading
   *     any document field, so no meeting can be filtered out and the counts are
   *     taken straight off the raw arrays.
   *   - `servant` / `member` viewers are deliberately EXCLUDED: their mappers
   *     ({@link _mapMeetingForServant}, {@link _mapMeetingForMember}) filter
   *     `servants`/`groups` and blank `servedUsers`, so a raw `$size` would
   *     over-count and leak collection sizes. Those viewers keep the generic
   *     path, and `_buildOwnMeetingsFilter` already narrows them to few docs.
   *   - `viewerContext` is constant here: both `canManage*` flags are defined as
   *     `allowed && accessLevel === 'full'`, and neither reads `servantEntry`.
   *
   * `_mapMeeting` maps these arrays 1:1 (`.map`, never `.filter`), so `$size`
   * equals the mapped `.length` exactly. Covered by tests that diff this output
   * against the original mapper.
   */
  async _listMeetingsSummaryAggregate({ query, sortDirection, limit }) {
    const [result] = await Meeting.aggregate([
      { $match: query },
      { $sort: { createdAt: sortDirection, _id: sortDirection } },
      { $limit: limit },
      {
        $facet: {
          // The page itself: identity fields + counts, never the id arrays.
          rows: [
            {
              $project: {
                name: 1,
                day: 1,
                time: 1,
                avatar: 1,
                createdAt: 1,
                updatedAt: 1,
                sectorId: 1,
                groupsCount: { $size: { $ifNull: ['$groups', []] } },
                assistantsCount: { $size: { $ifNull: ['$assistantSecretaries', []] } },
                servantsCount: { $size: { $ifNull: ['$servants', []] } },
                committeesCount: { $size: { $ifNull: ['$committees', []] } },
                activitiesCount: { $size: { $ifNull: ['$activities', []] } },
                servedUsersCount: { $size: { $ifNull: ['$servedUserIds', []] } },
              },
            },
            {
              $lookup: {
                from: 'sectors',
                localField: 'sectorId',
                foreignField: '_id',
                as: 'sectorDoc',
              },
            },
          ],
          // Distinct served users across the page. Mirrors the Node original,
          // which skipped falsy ids before adding them to the Set.
          servedUsersUnique: [
            { $project: { servedUserIds: { $ifNull: ['$servedUserIds', []] } } },
            { $unwind: '$servedUserIds' },
            { $match: { servedUserIds: { $ne: null } } },
            { $group: { _id: null, ids: { $addToSet: '$servedUserIds' } } },
            { $project: { _id: 0, count: { $size: '$ids' } } },
          ],
        },
      },
    ]);

    const rows = result?.rows || [];
    const meetings = rows.map((row) => {
      // Match `_mapMeeting`'s sector shape: a populated sector keeps its fields,
      // a dangling reference becomes null (mongoose `populate` nulls those too).
      const sectorDoc = (row.sectorDoc || [])[0] || null;
      const sector = sectorDoc
        ? {
            id: this._toId(sectorDoc._id),
            name: sectorDoc.name,
            avatar: sectorDoc.avatar || null,
          }
        : null;

      return {
        id: this._toId(row._id),
        name: row.name,
        day: row.day,
        time: row.time,
        avatar: row.avatar || null,
        sector,
        groupsCount: row.groupsCount,
        assistantsCount: row.assistantsCount,
        servantsCount: row.servantsCount,
        committeesCount: row.committeesCount,
        activitiesCount: row.activitiesCount,
        servedUsersCount: row.servedUsersCount,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        viewerContext: {
          accessLevel: 'full',
          canViewAllDetails: true,
          canViewAllServedUsers: true,
          canViewLeadership: true,
          canViewServants: true,
          canViewCommittees: true,
          canViewActivities: true,
          canManageReminderSettings: true,
          canManageDocumentationSettings: true,
        },
      };
    });

    return {
      meetings,
      servedUsersUnique: result?.servedUsersUnique?.[0]?.count || 0,
    };
  }

  async listMeetings({
    cursor,
    limit = 20,
    order = 'desc',
    filters = {},
    actorUserId = null,
    userPermissions = [],
    summary = false,
  }) {
    const query = {
      isDeleted: { $ne: true },
    };

    const hasFullViewPermission = this._hasAnyPermission(userPermissions, [
      PERMISSIONS.MEETINGS_VIEW,
      PERMISSIONS.MEETINGS_UPDATE,
      PERMISSIONS.MEETINGS_SERVANTS_MANAGE,
      PERMISSIONS.MEETINGS_COMMITTEES_MANAGE,
      PERMISSIONS.MEETINGS_ACTIVITIES_MANAGE,
    ]);
    if (actorUserId && !hasFullViewPermission) {
      Object.assign(query, this._buildOwnMeetingsFilter(actorUserId));
    }

    if (filters.sectorId) {
      query.sectorId = this._toObjectId(filters.sectorId, 'sectorId');
    }

    if (filters.day) {
      query.day = { $regex: `^${this._normalizeText(filters.day)}$`, $options: 'i' };
    }

    if (filters.search) {
      query.name = { $regex: this._normalizeText(filters.search), $options: 'i' };
    }

    if (cursor) {
      const cursorDate = new Date(cursor);
      if (!Number.isNaN(cursorDate.getTime())) {
        query.createdAt = {
          [order === 'desc' ? '$lt' : '$gt']: cursorDate,
        };
      }
    }

    const sortDirection = order === 'desc' ? -1 : 1;

    // Summary + unscoped viewer => count inside MongoDB instead of shipping the
    // served-user / servant id arrays to Node. See `_listMeetingsSummaryAggregate`
    // for why scoped viewers must NOT take this path.
    if (summary && (!actorUserId || hasFullViewPermission)) {
      const { meetings: summaryMeetings, servedUsersUnique } =
        await this._listMeetingsSummaryAggregate({ query, sortDirection, limit });

      const meta = buildPaginationMeta(summaryMeetings, limit, 'createdAt');
      meta.servedUsersUnique = servedUsersUnique;

      return { meetings: summaryMeetings, meta };
    }

    // Summary mode (list + dashboard) needs only counts, so we skip the heavy
    // served-user / servant / committee-member populates and keep just the
    // sector. Access resolution + scoping operate on raw ids, so they still work
    // without the populated user documents.
    let dbQuery = Meeting.find(query)
      .sort({ createdAt: sortDirection, _id: sortDirection })
      .limit(limit)
      // Never load the unbounded attendance/notes/documentation history — these
      // arrays grow with every check-in, so they are excluded to bound the worst
      // case. The list/mapping never reads them (dedicated endpoints fetch them
      // separately). NOTE: on current data these fields are nearly empty and this
      // exclusion saves <1% of the payload — the bulk lives in the servant /
      // served-user id arrays below, which scoped viewers genuinely need. Summary
      // requests from unscoped viewers skip this query entirely; see
      // `_listMeetingsSummaryAggregate`.
      .select('-attendanceRecords -attendanceAuditLog -memberNotes -documentationSettings')
      .populate('sectorId', 'name avatar');

    if (!summary) {
      dbQuery = dbQuery
        .populate('serviceSecretary.userId', 'fullName phonePrimary')
        .populate('assistantSecretaries.userId', 'fullName phonePrimary')
        .populate('servants.userId', 'fullName phonePrimary')
        .populate('servants.servedUserIds', 'fullName phonePrimary')
        .populate('servants.groupAssignments.servedUserIds', 'fullName phonePrimary')
        .populate('servedUserIds', 'fullName phonePrimary')
        .populate('groupAssignments.servedUserIds', 'fullName phonePrimary')
        .populate('committees.memberUserIds', 'fullName phonePrimary');
    }

    const meetings = await dbQuery.lean();

    // In summary mode we still need the distinct served-user total for the
    // dashboard, but we do NOT ship per-meeting id arrays. Aggregate the unique
    // ids here (respecting access scoping) and expose only the size via `meta`.
    const uniqueServedUserIds = summary ? new Set() : null;
    const mappedMeetings = meetings
      .map((meeting) => {
        const accessContext = this._resolveMeetingAccess({
          meeting,
          actorUserId,
          userPermissions,
        });
        if (!accessContext.allowed) return null;
        const mapped = this._mapMeetingByAccess(meeting, accessContext);
        if (!summary) return mapped;
        (mapped.servedUsers || []).forEach((user) => {
          if (user?.id) uniqueServedUserIds.add(String(user.id));
        });
        return this._toMeetingSummary(mapped);
      })
      .filter(Boolean);

    const meta = buildPaginationMeta(mappedMeetings, limit, 'createdAt');
    if (summary) {
      meta.servedUsersUnique = uniqueServedUserIds.size;
    }

    return {
      meetings: mappedMeetings,
      meta,
    };
  }

  async getMeetingById(id, { actorUserId = null, userPermissions = [], overview = false } = {}) {
    // Overview mode (meeting details page) keeps leadership + group members —
    // whose contact details are displayed — but skips the served-user, servant
    // served-user, and committee-member populates that the page only shows counts
    // for. Access scoping still works: it operates on raw ids, not populated docs.
    let dbQuery = Meeting.findOne({ _id: this._toObjectId(id), isDeleted: { $ne: true } })
      // Exclude the unbounded attendance/notes/documentation history: the detail
      // and edit views never read it (dedicated endpoints load it separately),
      // and it can dominate the document size.
      .select('-attendanceRecords -attendanceAuditLog -memberNotes -documentationSettings')
      .populate('sectorId', 'name avatar')
      .populate('serviceSecretary.userId', 'fullName phonePrimary')
      .populate('assistantSecretaries.userId', 'fullName phonePrimary')
      .populate('groupAssignments.servedUserIds', 'fullName phonePrimary');

    if (!overview) {
      dbQuery = dbQuery
        .populate('servants.userId', 'fullName phonePrimary')
        .populate('servants.servedUserIds', 'fullName phonePrimary')
        .populate('servants.groupAssignments.servedUserIds', 'fullName phonePrimary')
        .populate('servedUserIds', 'fullName phonePrimary')
        .populate('committees.memberUserIds', 'fullName phonePrimary');
    }

    const meeting = await dbQuery.lean();

    if (!meeting) {
      throw ApiError.notFound('Meeting was not found', 'RESOURCE_NOT_FOUND');
    }

    const accessContext = this._resolveMeetingAccess({
      meeting,
      actorUserId,
      userPermissions,
    });
    if (!accessContext.allowed) {
      throw ApiError.forbidden('You are not allowed to access this meeting', 'PERMISSION_DENIED');
    }

    const mapped = this._mapMeetingByAccess(meeting, accessContext);
    return overview ? this._toMeetingOverview(mapped) : mapped;
  }

  async listMeetingReminderSettings() {
    const meetings = await Meeting.find({ isDeleted: { $ne: true } })
      .sort({ day: 1, time: 1, name: 1, _id: 1 })
      .select('_id name day time sectorId reminderSettings updatedAt createdAt')
      .populate('sectorId', 'name avatar')
      .lean();

    return meetings.map((meeting) => ({
      id: this._toId(meeting._id),
      name: meeting.name,
      day: meeting.day,
      time: meeting.time,
      sector: meeting.sectorId
        ? {
            id: this._toId(meeting.sectorId._id || meeting.sectorId),
            name: meeting.sectorId.name || null,
            avatar: meeting.sectorId.avatar || null,
          }
        : null,
      reminderSettings: this._mapMeetingReminderSettings(meeting.reminderSettings),
      createdAt: meeting.createdAt || null,
      updatedAt: meeting.updatedAt || null,
    }));
  }

  async updateMeetingReminderSettings(
    id,
    payload,
    { actorUserId = null, userPermissions = [] } = {}
  ) {
    const meeting = await Meeting.findOne({ _id: this._toObjectId(id), isDeleted: { $ne: true } });
    if (!meeting) {
      throw ApiError.notFound('Meeting was not found', 'RESOURCE_NOT_FOUND');
    }

    const accessContext = this._resolveMeetingAccess({
      meeting,
      actorUserId,
      userPermissions,
    });
    if (!this._canManageMeetingReminderSettings(accessContext)) {
      throw ApiError.forbidden(
        'You are not allowed to update this meeting reminder settings',
        'PERMISSION_DENIED'
      );
    }

    meeting.reminderSettings = this._normalizeMeetingReminderSettings(payload);
    meeting.updatedBy = actorUserId;
    await meeting.save();

    return this.getMeetingById(meeting._id, {
      actorUserId,
      userPermissions,
    });
  }

  _mapMeetingMember({
    user,
    meetingId,
    meetingName,
    groupNames = [],
    noteHistory = [],
    canEditNote = false,
  }) {
    const latestNote = (noteHistory || [])[0] || null;
    return {
      id: this._toId(user._id),
      fullName: user.fullName || '',
      phonePrimary: user.phonePrimary || '',
      note: latestNote?.note || '',
      noteMeta: latestNote
        ? {
            id: latestNote.id,
            addedBy: latestNote.addedBy?.id || null,
            updatedBy: latestNote.updatedBy?.id || latestNote.addedBy?.id || null,
            updatedAt: latestNote.updatedAt || null,
          }
        : null,
      notes: noteHistory || [],
      groups: this._normalizeUniqueStrings(groupNames),
      meeting: {
        id: this._toId(meetingId),
        name: meetingName || '',
      },
      canEditNote: Boolean(canEditNote),
    };
  }

  async _getMeetingForMemberAccess(meetingId, { lean = true } = {}) {
    let query = Meeting.findOne({ _id: this._toObjectId(meetingId), isDeleted: { $ne: true } }).select(
      'name serviceSecretary assistantSecretaries servants servedUserIds groupAssignments memberNotes updatedBy'
    );
    if (lean) query = query.lean();

    const meeting = await query;

    if (!meeting) {
      throw ApiError.notFound('Meeting was not found', 'RESOURCE_NOT_FOUND');
    }

    return meeting;
  }

  async _getMeetingForAttendance(meetingId, { lean = true } = {}) {
    let query = Meeting.findOne({
      _id: this._toObjectId(meetingId),
      isDeleted: { $ne: true },
    }).select(
      'name day time createdAt groups serviceSecretary assistantSecretaries servants servedUserIds groupAssignments attendanceRecords attendanceAuditLog documentationSettings updatedBy'
    );
    if (lean) query = query.lean();

    const meeting = await query;

    if (!meeting) {
      throw ApiError.notFound('Meeting was not found', 'RESOURCE_NOT_FOUND');
    }

    return meeting;
  }

  _resolveScopedMemberIds(meeting, accessContext) {
    if (accessContext?.accessLevel === 'servant') {
      return this._getServantScope(meeting, accessContext.servantEntry).scopedMemberIds;
    }
    if (accessContext?.accessLevel === 'member') {
      return accessContext.memberScope?.scopedMemberIds || new Set();
    }
    return this._collectAllMeetingMemberIds(meeting);
  }

  _resolveMemberGroups(meeting, memberId, accessContext) {
    const normalizedMemberId = this._toId(memberId);
    if (!normalizedMemberId) return [];

    const allowedGroupNames =
      accessContext?.accessLevel === 'servant'
        ? this._getServantScope(meeting, accessContext.servantEntry).groupNames
        : accessContext?.accessLevel === 'member'
          ? accessContext.memberScope?.groupNames || new Set()
          : null;

    const groups = new Set();

    (meeting.groupAssignments || []).forEach((assignment) => {
      const inGroup = (assignment.servedUserIds || []).some(
        (servedId) => this._toId(servedId) === normalizedMemberId
      );
      if (!inGroup) return;
      if (allowedGroupNames && !allowedGroupNames.has(assignment.group)) return;
      groups.add(assignment.group);
    });

    (meeting.servants || []).forEach((servant) => {
      (servant.groupAssignments || []).forEach((assignment) => {
        const inGroup = (assignment.servedUserIds || []).some(
          (servedId) => this._toId(servedId) === normalizedMemberId
        );
        if (!inGroup) return;
        if (allowedGroupNames && !allowedGroupNames.has(assignment.group)) return;
        groups.add(assignment.group);
      });
    });

    return this._normalizeUniqueStrings([...groups]);
  }

  _canUpdateMeetingMemberNote(userPermissions = []) {
    return (
      this._hasPermission(userPermissions, PERMISSIONS.MEETINGS_MEMBERS_NOTES_UPDATE) ||
      this._hasPermission(userPermissions, PERMISSIONS.MEETINGS_UPDATE) ||
      this._hasPermission(userPermissions, PERMISSIONS.MEETINGS_SERVANTS_MANAGE)
    );
  }

  _canManageMeetingAttendance(userPermissions = []) {
    return (
      this._hasPermission(userPermissions, PERMISSIONS.MEETINGS_ATTENDANCE_MANAGE) ||
      this._hasPermission(userPermissions, PERMISSIONS.MEETINGS_UPDATE) ||
      this._hasPermission(userPermissions, PERMISSIONS.MEETINGS_SERVANTS_MANAGE)
    );
  }

  _canManageMeetingDocumentation(userPermissions = []) {
    return (
      this._hasPermission(userPermissions, PERMISSIONS.MEETINGS_DOCUMENTATION_MANAGE) ||
      this._hasPermission(userPermissions, PERMISSIONS.MEETINGS_UPDATE) ||
      this._hasPermission(userPermissions, PERMISSIONS.MEETINGS_SERVANTS_MANAGE)
    );
  }

  _canManageMeetingDocumentationSettings(accessContext) {
    return accessContext?.allowed && accessContext?.accessLevel === 'full';
  }

  _extractMeetingMemberNotes(meeting, memberId) {
    const normalizedMemberId = this._toId(memberId);
    if (!normalizedMemberId) return [];

    return (meeting?.memberNotes || [])
      .filter((entry) => this._toId(entry?.memberUserId) === normalizedMemberId)
      .sort((a, b) => {
        const aTime = new Date(a?.updatedAt || 0).getTime();
        const bTime = new Date(b?.updatedAt || 0).getTime();
        return bTime - aTime;
      });
  }

  async _buildMeetingNoteUsersMap(noteEntries = []) {
    const userIds = [...new Set(
      (noteEntries || [])
        .flatMap((entry) => [entry?.addedBy, entry?.updatedBy])
        .map((value) => this._toId(value))
        .filter(Boolean)
    )];

    if (!userIds.length) return new Map();

    const users = await User.find({
      _id: { $in: userIds },
      isDeleted: { $ne: true },
    })
      .select('fullName')
      .lean();

    return new Map(users.map((user) => [this._toId(user._id), user]));
  }

  _mapMeetingMemberNotes(noteEntries = [], noteUsersMap = new Map()) {
    return (noteEntries || []).map((entry) => {
      const addedById = this._toId(entry?.addedBy);
      const updatedById = this._toId(entry?.updatedBy || entry?.addedBy);
      const addedByUser = addedById ? noteUsersMap.get(addedById) : null;
      const updatedByUser = updatedById ? noteUsersMap.get(updatedById) : null;

      return {
        id: this._toId(entry?._id),
        note: entry?.note || '',
        addedBy: addedById
          ? {
              id: addedById,
              fullName: addedByUser?.fullName || '',
            }
          : null,
        updatedBy: updatedById
          ? {
              id: updatedById,
              fullName: updatedByUser?.fullName || '',
            }
          : null,
        updatedAt: entry?.updatedAt || null,
      };
    });
  }

  _extractMeetingAttendanceRecord(meeting, attendanceDate) {
    const targetDateKey = this._normalizeText(attendanceDate);
    if (!targetDateKey) return null;

    return (
      (meeting?.attendanceRecords || []).find(
        (entry) => this._normalizeText(entry?.attendanceDate) === targetDateKey
      ) || null
    );
  }

  _extractMeetingAttendanceAuditEntries(meeting, attendanceDate) {
    const targetDateKey = this._normalizeText(attendanceDate);
    if (!targetDateKey) return [];

    return (meeting?.attendanceAuditLog || [])
      .filter((entry) => this._normalizeText(entry?.attendanceDate) === targetDateKey)
      .sort((a, b) => {
        const aTime = new Date(a?.createdAt || 0).getTime();
        const bTime = new Date(b?.createdAt || 0).getTime();
        return bTime - aTime;
      });
  }

  _extractViewerAttendanceAuditEntry(meeting, attendanceDate, actorUserId) {
    const normalizedActorId = this._toId(actorUserId);
    if (!normalizedActorId) return null;

    return (
      this._extractMeetingAttendanceAuditEntries(meeting, attendanceDate).find(
        (entry) => this._toId(entry?.actorUserId) === normalizedActorId
      ) || null
    );
  }

  _resolveAttendanceAuditGroupNames(meeting, accessContext) {
    if (accessContext?.accessLevel === 'servant') {
      return [...(this._getServantScope(meeting, accessContext.servantEntry).groupNames || new Set())];
    }

    return this._normalizeUniqueStrings([
      ...(meeting?.groups || []),
      ...((meeting?.groupAssignments || []).map((assignment) => assignment?.group)),
      ...(meeting?.servants || []).flatMap((servant) =>
        (servant?.groupAssignments || []).map((assignment) => assignment?.group)
      ),
    ]);
  }

  async _mapMeetingAttendanceRecord(
    record,
    attendanceDate,
    scopedMemberIds = new Set(),
    viewerAuditEntry = null
  ) {
    const updatedById = this._toId(record?.updatedBy || record?.recordedBy);
    const viewerUpdatedById = this._toId(viewerAuditEntry?.actorUserId);
    const userIdsToLoad = [...new Set([updatedById, viewerUpdatedById].filter(Boolean))];
    const usersMap = userIdsToLoad.length > 0 ? await this._buildUserMap(userIdsToLoad) : new Map();
    const updatedByUser = updatedById ? usersMap.get(updatedById) : null;
    const viewerUpdatedByUser = viewerUpdatedById ? usersMap.get(viewerUpdatedById) : null;

    return {
      attendanceDate,
      attendedMemberUserIds: [...new Set(
        (record?.attendedMemberUserIds || [])
          .map((value) => this._toId(value))
          .filter((id) => id && (!scopedMemberIds.size || scopedMemberIds.has(id)))
      )],
      recordUpdatedAt: record?.updatedAt || null,
      recordUpdatedBy: updatedById
        ? {
            id: updatedById,
            fullName: updatedByUser?.fullName || '',
          }
        : null,
      updatedAt: record?.updatedAt || null,
      updatedBy: updatedById
        ? {
            id: updatedById,
            fullName: updatedByUser?.fullName || '',
          }
        : null,
      viewerUpdatedAt: viewerAuditEntry?.createdAt || null,
      viewerUpdatedBy: viewerUpdatedById
        ? {
            id: viewerUpdatedById,
            fullName: viewerUpdatedByUser?.fullName || '',
          }
        : null,
      canManageAttendance: true,
    };
  }

  _mapMeetingDocumentationAsset(asset) {
    if (!asset) return null;

    return {
      url: asset.url || '',
      storageKey: asset.storageKey || '',
      provider: asset.provider || 'r2',
      originalName: asset.originalName || '',
      mimeType: asset.mimeType || '',
      kind: asset.kind || '',
      resourceType: asset.resourceType || '',
      bytes: Number(asset.bytes) || 0,
      size: Number(asset.size || asset.bytes) || 0,
    };
  }

  _mapMeetingDocumentationFieldResponse(response) {
    if (!response) return null;

    return {
      fieldId: this._toId(response.fieldId),
      fieldLabel: response.fieldLabel || '',
      fieldType: response.fieldType || 'text',
      textValue: response.textValue || '',
      numberValue:
        typeof response.numberValue === 'number' && Number.isFinite(response.numberValue)
          ? response.numberValue
          : null,
      assets: (response.assets || [])
        .map((asset) => this._mapMeetingDocumentationAsset(asset))
        .filter(Boolean),
    };
  }

  _mapMeetingDocumentationSettingsField(field) {
    return {
      id: this._toId(field?._id),
      label: field?.label || '',
      type: field?.type || 'text',
      required: Boolean(field?.required),
      placeholder: field?.placeholder || '',
      helpText: field?.helpText || '',
      isActive: field?.isActive !== false,
      sortOrder: Number.isFinite(field?.sortOrder) ? field.sortOrder : 0,
    };
  }

  _normalizeMeetingDocumentationSettingsFields(fields = []) {
    return (fields || []).map((field, index) => {
      const label = this._normalizeText(field?.label);
      if (!label) {
        throw ApiError.badRequest('Documentation field label is required', 'VALIDATION_ERROR');
      }

      const type = this._normalizeText(field?.type);
      if (!MEETING_DOCUMENTATION_FIELD_TYPES.includes(type)) {
        throw ApiError.badRequest('Documentation field type is invalid', 'VALIDATION_ERROR');
      }

      return {
        _id:
          field?.id && mongoose.Types.ObjectId.isValid(field.id)
            ? this._toObjectId(field.id, 'fieldId')
            : new mongoose.Types.ObjectId(),
        label,
        type,
        required: Boolean(field?.required),
        placeholder: this._normalizeText(field?.placeholder) || undefined,
        helpText: this._normalizeText(field?.helpText) || undefined,
        isActive: field?.isActive !== false,
        sortOrder: index,
      };
    });
  }

  async _resolveMeetingDocumentationSettingsSource(meeting) {
    const hasMeetingCustomization =
      meeting?.documentationSettings?.isCustomized === true ||
      Array.isArray(meeting?.documentationSettings?.fields) && meeting.documentationSettings.fields.length > 0;

    if (hasMeetingCustomization) {
      return {
        fields: meeting?.documentationSettings?.fields || [],
        updatedAt: meeting?.documentationSettings?.updatedAt || null,
        updatedBy: this._toId(meeting?.documentationSettings?.updatedBy),
        isCustomized: true,
      };
    }

    const config = await getOrCreateMeetingDocumentationConfig();
    return {
      fields: config?.fields || [],
      updatedAt: config?.updatedAt || null,
      updatedBy: this._toId(config?.updatedBy),
      isCustomized: false,
    };
  }

  _normalizeMeetingDocumentationAssets(assets = [], expectedKind = null) {
    return [...new Map(
      (assets || []).map((asset) => {
        const url = this._normalizeText(asset?.url);
        const storageKey = this._normalizeText(asset?.storageKey);
        const provider = this._normalizeText(asset?.provider) || 'r2';
        const originalName = this._normalizeText(asset?.originalName);
        const mimeType = this._normalizeText(asset?.mimeType);
        const kind = this._normalizeText(asset?.kind);
        const resourceType = this._normalizeText(asset?.resourceType);
        const bytes = Number(asset?.bytes || asset?.size) || 0;

        if (!url) {
          throw ApiError.badRequest('Documentation asset URL is required', 'VALIDATION_ERROR');
        }
        if (!MEETING_DOCUMENTATION_ASSET_KINDS.includes(kind)) {
          throw ApiError.badRequest('Documentation asset type is invalid', 'VALIDATION_ERROR');
        }
        if (expectedKind && kind !== expectedKind) {
          throw ApiError.badRequest(
            `Documentation field expects ${expectedKind} files only`,
            'VALIDATION_ERROR'
          );
        }
        if (!['image', 'video', 'raw'].includes(resourceType)) {
          throw ApiError.badRequest('Documentation asset resource type is invalid', 'VALIDATION_ERROR');
        }

        const normalizedAsset = {
          url,
          storageKey: storageKey || undefined,
          provider,
          originalName: originalName || undefined,
          mimeType: mimeType || undefined,
          kind,
          resourceType,
          bytes,
          size: bytes,
        };

        return [storageKey || url, normalizedAsset];
      })
    ).values()];
  }

  _collectMeetingDocumentationStorageKeysFromAssets(assets = []) {
    return (assets || [])
      .map((asset) => this._normalizeText(asset?.storageKey))
      .filter(Boolean);
  }

  _collectMeetingDocumentationStorageKeys(recordLike = {}) {
    const keys = [
      ...this._collectMeetingDocumentationStorageKeysFromAssets(recordLike?.attachments || []),
    ];

    (recordLike?.fieldResponses || []).forEach((response) => {
      keys.push(...this._collectMeetingDocumentationStorageKeysFromAssets(response?.assets || []));
    });

    return keys;
  }

  _normalizeMeetingDocumentationFieldResponse(response, fieldConfig) {
    const fieldType = fieldConfig?.type;
    const fieldLabel = fieldConfig?.label || '';
    const fieldId = this._toId(fieldConfig?._id);
    const textValue = this._normalizeText(response?.textValue);
    const numberInput =
      response?.numberValue === '' || response?.numberValue == null ? null : Number(response.numberValue);
    const expectedAssetKindByType = {
      image: 'image',
      video: 'video',
      document: 'document',
    };
    const expectedAssetKind = expectedAssetKindByType[fieldType] || null;
    const assets = expectedAssetKind
      ? this._normalizeMeetingDocumentationAssets(response?.assets || [], expectedAssetKind)
      : [];

    if (fieldType === 'text') {
      if (!textValue) return null;
      return {
        fieldId: this._toObjectId(fieldId, 'fieldId'),
        fieldLabel,
        fieldType,
        textValue,
      };
    }

    if (fieldType === 'number') {
      if (numberInput == null) return null;
      if (!Number.isFinite(numberInput)) {
        throw ApiError.badRequest(`${fieldLabel} must be a valid number`, 'VALIDATION_ERROR');
      }
      return {
        fieldId: this._toObjectId(fieldId, 'fieldId'),
        fieldLabel,
        fieldType,
        numberValue: numberInput,
      };
    }

    if (assets.length === 0) return null;
    return {
      fieldId: this._toObjectId(fieldId, 'fieldId'),
      fieldLabel,
      fieldType,
      assets,
    };
  }

  async _mapMeetingDocumentationRecord(record) {
    const updatedById = this._toId(record?.updatedBy || record?.createdBy);
    const usersMap = updatedById ? await this._buildUserMap([updatedById]) : new Map();
    const updatedByUser = updatedById ? usersMap.get(updatedById) : null;

    return {
      documentationDate: record?.documentationDate || null,
      notes: record?.notes || '',
      attachments: (record?.attachments || [])
        .map((asset) => this._mapMeetingDocumentationAsset(asset))
        .filter(Boolean),
      fieldResponses: (record?.fieldResponses || [])
        .map((response) => this._mapMeetingDocumentationFieldResponse(response))
        .filter(Boolean),
      updatedAt: record?.updatedAt || null,
      updatedBy: updatedById
        ? {
            id: updatedById,
            fullName: updatedByUser?.fullName || '',
          }
        : null,
      // `history` grows a full snapshot (notes + attachments + fieldResponses) on
      // every edit, and only its size is ever exposed. Readers that never need the
      // snapshots leave it in MongoDB and pass `historyCount` instead; writers,
      // which already hold the saved document in memory, fall back to `.length`.
      historyCount: Number.isInteger(record?.historyCount)
        ? record.historyCount
        : Array.isArray(record?.history)
          ? record.history.length
          : 0,
      canManageDocumentation: true,
    };
  }

  async getMeetingDocumentationSettings(
    meetingId,
    { actorUserId, userPermissions = [], includeInactive = true } = {}
  ) {
    const meeting = await this._getMeetingForAttendance(meetingId);
    const accessContext = this._resolveMeetingAccess({
      meeting,
      actorUserId,
      userPermissions,
    });

    if (!accessContext.allowed) {
      throw ApiError.forbidden('You are not allowed to access this meeting', 'PERMISSION_DENIED');
    }
    if (!this._canManageMeetingDocumentationSettings(accessContext)) {
      throw ApiError.forbidden(
        'You are not allowed to manage meeting documentation settings',
        'PERMISSION_DENIED'
      );
    }

    const settingsSource = await this._resolveMeetingDocumentationSettingsSource(meeting);
    const updatedById = this._toId(settingsSource?.updatedBy);
    const usersMap = updatedById ? await this._buildUserMap([updatedById]) : new Map();
    const updatedByUser = updatedById ? usersMap.get(updatedById) : null;
    const fields = (settingsSource.fields || [])
      .map((field) => this._mapMeetingDocumentationSettingsField(field))
      .filter((field) => includeInactive || field.isActive)
      .sort((a, b) => a.sortOrder - b.sortOrder || String(a.label).localeCompare(String(b.label)));

    return {
      fields,
      updatedAt: settingsSource.updatedAt || null,
      updatedBy: updatedById
        ? {
            id: updatedById,
            fullName: updatedByUser?.fullName || '',
          }
        : null,
      isCustomized: settingsSource.isCustomized === true,
    };
  }

  async updateMeetingDocumentationSettings(
    meetingId,
    fields = [],
    { actorUserId, userPermissions = [] } = {}
  ) {
    const meeting = await this._getMeetingForAttendance(meetingId, { lean: false });
    const accessContext = this._resolveMeetingAccess({
      meeting,
      actorUserId,
      userPermissions,
    });

    if (!accessContext.allowed) {
      throw ApiError.forbidden('You are not allowed to access this meeting', 'PERMISSION_DENIED');
    }
    if (!this._canManageMeetingDocumentationSettings(accessContext)) {
      throw ApiError.forbidden(
        'You are not allowed to manage meeting documentation settings',
        'PERMISSION_DENIED'
      );
    }

    const actorObjectId = this._toObjectId(actorUserId, 'actorUserId');
    meeting.documentationSettings = {
      isCustomized: true,
      fields: this._normalizeMeetingDocumentationSettingsFields(fields),
      updatedAt: new Date(),
      updatedBy: actorObjectId,
    };
    meeting.updatedBy = actorObjectId;
    await meeting.save();

    return this.getMeetingDocumentationSettings(meetingId, {
      actorUserId,
      userPermissions,
      includeInactive: true,
    });
  }

  async getMeetingDocumentation(
    meetingId,
    documentationDate,
    { actorUserId, userPermissions = [] } = {}
  ) {
    if (!this._canManageMeetingDocumentation(userPermissions)) {
      throw ApiError.forbidden('Missing permission for this process', 'PERMISSION_DENIED');
    }

    const meeting = await this._getMeetingForAttendance(meetingId);
    const accessContext = this._resolveMeetingAccess({
      meeting,
      actorUserId,
      userPermissions,
    });

    if (!accessContext.allowed) {
      throw ApiError.forbidden('You are not allowed to access this meeting', 'PERMISSION_DENIED');
    }
    if (accessContext.accessLevel === 'member') {
      throw ApiError.forbidden(
        'You are not allowed to document this meeting',
        'PERMISSION_DENIED'
      );
    }

    const normalizedDocumentationDate = this._assertPastMeetingDateAllowed(
      meeting.day,
      documentationDate,
      'Documentation date'
    );
    // Read path: size `history` in MongoDB and leave the snapshots there.
    const [record] = await MeetingDocumentation.aggregate([
      {
        $match: {
          meetingId: this._toObjectId(meetingId, 'meetingId'),
          documentationDate: normalizedDocumentationDate,
        },
      },
      { $limit: 1 },
      { $addFields: { historyCount: { $size: { $ifNull: ['$history', []] } } } },
      { $project: { history: 0 } },
    ]);

    if (!record) {
      return {
        documentationDate: normalizedDocumentationDate,
        notes: '',
        attachments: [],
        fieldResponses: [],
        updatedAt: null,
        updatedBy: null,
        historyCount: 0,
        canManageDocumentation: true,
      };
    }

    return this._mapMeetingDocumentationRecord(record);
  }

  async updateMeetingDocumentation(
    meetingId,
    { documentationDate, notes, attachments = [], fieldResponses = [] } = {},
    { actorUserId, userPermissions = [] } = {}
  ) {
    if (!this._canManageMeetingDocumentation(userPermissions)) {
      throw ApiError.forbidden('Missing permission for this process', 'PERMISSION_DENIED');
    }

    const meeting = await this._getMeetingForAttendance(meetingId);
    const accessContext = this._resolveMeetingAccess({
      meeting,
      actorUserId,
      userPermissions,
    });

    if (!accessContext.allowed) {
      throw ApiError.forbidden('You are not allowed to access this meeting', 'PERMISSION_DENIED');
    }
    if (accessContext.accessLevel === 'member') {
      throw ApiError.forbidden(
        'You are not allowed to document this meeting',
        'PERMISSION_DENIED'
      );
    }

    const normalizedDocumentationDate = this._assertPastMeetingDateAllowed(
      meeting.day,
      documentationDate,
      'Documentation date'
    );
    const normalizedNotes = this._normalizeText(notes);
    const normalizedAttachments = this._normalizeMeetingDocumentationAssets(attachments || []);
    const documentationSettings = await this._resolveMeetingDocumentationSettingsSource(meeting);
    const activeFields = (documentationSettings.fields || [])
      .filter((field) => field?.isActive !== false)
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    const activeFieldMap = new Map(activeFields.map((field) => [this._toId(field._id), field]));
    const normalizedFieldResponseMap = new Map();

    (fieldResponses || []).forEach((response) => {
      const fieldId = this._toId(response?.fieldId);
      if (!fieldId || !activeFieldMap.has(fieldId)) {
        throw ApiError.badRequest('Documentation field is invalid', 'VALIDATION_ERROR');
      }

      const normalizedResponse = this._normalizeMeetingDocumentationFieldResponse(
        response,
        activeFieldMap.get(fieldId)
      );
      if (normalizedResponse) {
        normalizedFieldResponseMap.set(fieldId, normalizedResponse);
      } else {
        normalizedFieldResponseMap.delete(fieldId);
      }
    });

    activeFields.forEach((field) => {
      const fieldId = this._toId(field._id);
      if (field.required && !normalizedFieldResponseMap.has(fieldId)) {
        throw ApiError.badRequest(
          `${field.label} is required for daily documentation`,
          'VALIDATION_ERROR'
        );
      }
    });

    const normalizedFieldResponses = activeFields
      .map((field) => normalizedFieldResponseMap.get(this._toId(field._id)) || null)
      .filter(Boolean);

    const actorObjectId = this._toObjectId(actorUserId, 'actorUserId');
    const meetingObjectId = this._toObjectId(meetingId, 'meetingId');
    const now = new Date();
    let record = await MeetingDocumentation.findOne({
      meetingId: meetingObjectId,
      documentationDate: normalizedDocumentationDate,
    });
    const previousStorageKeys = record
      ? this._collectMeetingDocumentationStorageKeys(record.toObject ? record.toObject() : record)
      : [];

    if (!record) {
      record = new MeetingDocumentation({
        meetingId: meetingObjectId,
        documentationDate: normalizedDocumentationDate,
        createdBy: actorObjectId,
      });
    }

    record.notes = normalizedNotes || undefined;
    record.attachments = normalizedAttachments;
    record.fieldResponses = normalizedFieldResponses;
    record.updatedBy = actorObjectId;
    record.history = record.history || [];
    record.history.push({
      actorUserId: actorObjectId,
      accessLevel: accessContext.accessLevel,
      notes: normalizedNotes || undefined,
      attachments: normalizedAttachments,
      fieldResponses: normalizedFieldResponses,
      action: 'documentation_saved',
      createdAt: now,
    });
    await record.save();

    const nextStorageKeys = this._collectMeetingDocumentationStorageKeys(record.toObject());
    const removedStorageKeys = previousStorageKeys.filter((key) => !nextStorageKeys.includes(key));
    await storageService.deleteFiles(removedStorageKeys);

    return this._mapMeetingDocumentationRecord(record.toObject());
  }

  async getMeetingMemberById(meetingId, memberId, { actorUserId, userPermissions = [] } = {}) {
    const meeting = await this._getMeetingForMemberAccess(meetingId);
    const accessContext = this._resolveMeetingAccess({
      meeting,
      actorUserId,
      userPermissions,
    });

    if (!accessContext.allowed) {
      throw ApiError.forbidden('You are not allowed to access this meeting', 'PERMISSION_DENIED');
    }
    if (accessContext.accessLevel === 'member') {
      throw ApiError.forbidden('You are not allowed to access meeting members', 'PERMISSION_DENIED');
    }

    const scopedMemberIds = this._resolveScopedMemberIds(meeting, accessContext);
    const normalizedMemberId = this._toId(memberId);
    if (!normalizedMemberId || !scopedMemberIds.has(normalizedMemberId)) {
      throw ApiError.forbidden('You are not allowed to access this member', 'PERMISSION_DENIED');
    }

    const user = await User.findOne({
      _id: this._toObjectId(memberId, 'memberId'),
      isDeleted: { $ne: true },
    })
      .select('fullName phonePrimary')
      .lean();

    if (!user) {
      throw ApiError.notFound('Meeting member was not found', 'RESOURCE_NOT_FOUND');
    }

    const noteEntries = this._extractMeetingMemberNotes(meeting, memberId);
    const noteUsersMap = await this._buildMeetingNoteUsersMap(noteEntries);
    const noteHistory = this._mapMeetingMemberNotes(noteEntries, noteUsersMap);

    return this._mapMeetingMember({
      user,
      meetingId: meeting._id,
      meetingName: meeting.name,
      groupNames: this._resolveMemberGroups(meeting, memberId, accessContext),
      noteHistory,
      canEditNote:
        this._canUpdateMeetingMemberNote(userPermissions) && accessContext.accessLevel !== 'member',
    });
  }

  async updateMeetingMemberNotes(
    meetingId,
    memberId,
    note,
    { actorUserId, userPermissions = [] } = {}
  ) {
    if (!this._canUpdateMeetingMemberNote(userPermissions)) {
      throw ApiError.forbidden('Missing permission for this process', 'PERMISSION_DENIED');
    }

    const meeting = await this._getMeetingForMemberAccess(meetingId, { lean: false });
    const accessContext = this._resolveMeetingAccess({
      meeting,
      actorUserId,
      userPermissions,
    });

    if (!accessContext.allowed) {
      throw ApiError.forbidden('You are not allowed to access this meeting', 'PERMISSION_DENIED');
    }
    if (accessContext.accessLevel === 'member') {
      throw ApiError.forbidden('You are not allowed to update meeting member note', 'PERMISSION_DENIED');
    }

    const scopedMemberIds = this._resolveScopedMemberIds(meeting, accessContext);
    const normalizedMemberId = this._toId(memberId);
    if (!normalizedMemberId || !scopedMemberIds.has(normalizedMemberId)) {
      throw ApiError.forbidden('You are not allowed to update this member', 'PERMISSION_DENIED');
    }

    const user = await User.findOne({
      _id: this._toObjectId(memberId, 'memberId'),
      isDeleted: { $ne: true },
    })
      .select('fullName phonePrimary')
      .lean();

    if (!user) {
      throw ApiError.notFound('Meeting member was not found', 'RESOURCE_NOT_FOUND');
    }

    const nextNote = this._normalizeText(note);
    if (!nextNote) {
      throw ApiError.badRequest('Note is required', 'VALIDATION_ERROR');
    }
    const actorId = this._toObjectId(actorUserId, 'actorUserId');
    meeting.memberNotes.push({
      memberUserId: this._toObjectId(memberId, 'memberId'),
      note: nextNote,
      addedBy: actorId,
      updatedBy: actorId,
      updatedAt: new Date(),
    });

    meeting.updatedBy = actorId;
    await meeting.save();

    const updatedMeeting = await this._getMeetingForMemberAccess(meetingId);
    const noteEntries = this._extractMeetingMemberNotes(updatedMeeting, memberId);
    const noteUsersMap = await this._buildMeetingNoteUsersMap(noteEntries);
    const noteHistory = this._mapMeetingMemberNotes(noteEntries, noteUsersMap);

    return this._mapMeetingMember({
      user,
      meetingId: updatedMeeting._id,
      meetingName: updatedMeeting.name,
      groupNames: this._resolveMemberGroups(updatedMeeting, memberId, accessContext),
      noteHistory,
      canEditNote: true,
    });
  }

  async getMeetingAttendance(
    meetingId,
    attendanceDate,
    { actorUserId, userPermissions = [] } = {}
  ) {
    if (!this._canManageMeetingAttendance(userPermissions)) {
      throw ApiError.forbidden('Missing permission for this process', 'PERMISSION_DENIED');
    }

    const meeting = await this._getMeetingForAttendance(meetingId);
    const accessContext = this._resolveMeetingAccess({
      meeting,
      actorUserId,
      userPermissions,
    });

    if (!accessContext.allowed) {
      throw ApiError.forbidden('You are not allowed to access this meeting', 'PERMISSION_DENIED');
    }
    if (accessContext.accessLevel === 'member') {
      throw ApiError.forbidden(
        'You are not allowed to access meeting attendance',
        'PERMISSION_DENIED'
      );
    }

    const normalizedAttendanceDate = this._assertPastMeetingDateAllowed(
      meeting.day,
      attendanceDate,
      'Attendance date'
    );
    const scopedMemberIds = this._resolveScopedMemberIds(meeting, accessContext);
    const record = this._extractMeetingAttendanceRecord(meeting, normalizedAttendanceDate);
    const viewerAuditEntry = this._extractViewerAttendanceAuditEntry(
      meeting,
      normalizedAttendanceDate,
      actorUserId
    );

    return this._mapMeetingAttendanceRecord(
      record,
      normalizedAttendanceDate,
      scopedMemberIds,
      viewerAuditEntry
    );
  }

  async updateMeetingAttendance(
    meetingId,
    attendanceDate,
    attendedMemberUserIds = [],
    { actorUserId, userPermissions = [] } = {}
  ) {
    if (!this._canManageMeetingAttendance(userPermissions)) {
      throw ApiError.forbidden('Missing permission for this process', 'PERMISSION_DENIED');
    }

    const meeting = await this._getMeetingForAttendance(meetingId, { lean: false });
    // Capture updatedAt at load time for optimistic concurrency.
    // If another request modifies this meeting between load and save,
    // the conditional findOneAndUpdate returns null → 409 Conflict.
    const expectedUpdatedAt = meeting.updatedAt;
    const accessContext = this._resolveMeetingAccess({
      meeting,
      actorUserId,
      userPermissions,
    });

    if (!accessContext.allowed) {
      throw ApiError.forbidden('You are not allowed to access this meeting', 'PERMISSION_DENIED');
    }
    if (accessContext.accessLevel === 'member') {
      throw ApiError.forbidden(
        'You are not allowed to update meeting attendance',
        'PERMISSION_DENIED'
      );
    }

    const normalizedAttendanceDate = this._assertPastMeetingDateAllowed(
      meeting.day,
      attendanceDate,
      'Attendance date'
    );
    const scopedMemberIds = this._resolveScopedMemberIds(meeting, accessContext);
    const scopedMemberIdsList = [...scopedMemberIds];
    const selectedScopedMemberIds = [...new Set(
      (attendedMemberUserIds || [])
        .map((value) => this._toId(value))
        .filter(Boolean)
    )];

    const hasOutOfScopeSelection = selectedScopedMemberIds.some((memberId) => !scopedMemberIds.has(memberId));
    if (hasOutOfScopeSelection) {
      throw ApiError.forbidden(
        'You are not allowed to update attendance for this member',
        'PERMISSION_DENIED'
      );
    }

    const actorObjectId = this._toObjectId(actorUserId, 'actorUserId');
    const meetingObjectId = this._toObjectId(meetingId, 'meetingId');
    const now = new Date();
    const recordIndex = (meeting.attendanceRecords || []).findIndex(
      (entry) => this._normalizeText(entry?.attendanceDate) === normalizedAttendanceDate
    );
    const existingRecord = recordIndex >= 0 ? meeting.attendanceRecords[recordIndex] : null;
    const mergedAttendeeIds = new Set(
      (existingRecord?.attendedMemberUserIds || []).map((value) => this._toId(value)).filter(Boolean)
    );
    const previousScopedAttendedMemberIds = [...new Set(
      (existingRecord?.attendedMemberUserIds || [])
        .map((value) => this._toId(value))
        .filter((memberId) => memberId && scopedMemberIds.has(memberId))
    )];

    scopedMemberIdsList.forEach((memberId) => mergedAttendeeIds.delete(memberId));
    selectedScopedMemberIds.forEach((memberId) => mergedAttendeeIds.add(memberId));

    if (mergedAttendeeIds.size === 0) {
      if (recordIndex >= 0) {
        meeting.attendanceRecords.splice(recordIndex, 1);
      }
    } else if (recordIndex >= 0) {
      meeting.attendanceRecords[recordIndex].attendanceDate = normalizedAttendanceDate;
      meeting.attendanceRecords[recordIndex].attendedMemberUserIds = [...mergedAttendeeIds].map((memberId) =>
        this._toObjectId(memberId, 'attendedMemberUserIds')
      );
      meeting.attendanceRecords[recordIndex].updatedBy = actorObjectId;
      meeting.attendanceRecords[recordIndex].updatedAt = now;
    } else {
      meeting.attendanceRecords.push({
        attendanceDate: normalizedAttendanceDate,
        attendedMemberUserIds: [...mergedAttendeeIds].map((memberId) =>
          this._toObjectId(memberId, 'attendedMemberUserIds')
        ),
        recordedBy: actorObjectId,
        updatedBy: actorObjectId,
        updatedAt: now,
      });
    }

    meeting.attendanceAuditLog = meeting.attendanceAuditLog || [];
    meeting.attendanceAuditLog.push({
      attendanceDate: normalizedAttendanceDate,
      actorUserId: actorObjectId,
      accessLevel: accessContext.accessLevel,
      scopedMemberUserIds: scopedMemberIdsList.map((memberId) =>
        this._toObjectId(memberId, 'memberId')
      ),
      previousAttendedMemberUserIds: previousScopedAttendedMemberIds.map((memberId) =>
        this._toObjectId(memberId, 'memberId')
      ),
      attendedMemberUserIds: selectedScopedMemberIds.map((memberId) =>
        this._toObjectId(memberId, 'memberId')
      ),
      groupNames: this._resolveAttendanceAuditGroupNames(meeting, accessContext),
      action: 'attendance_check_in_saved',
      createdAt: now,
    });

    // ── Atomic save with optimistic concurrency ──
    // Use findOneAndUpdate conditioned on the meeting's updatedAt at load time.
    // If a concurrent request modified the meeting, the update returns null
    // and we reject with 409 instead of silently overwriting.
    const updatedMeeting = await Meeting.findOneAndUpdate(
      { _id: meeting._id, updatedAt: expectedUpdatedAt },
      {
        $set: {
          attendanceRecords: meeting.attendanceRecords,
          attendanceAuditLog: meeting.attendanceAuditLog,
          updatedBy: actorObjectId,
        },
      },
      { new: true }
    );

    if (!updatedMeeting) {
      throw ApiError.conflict(
        'This meeting attendance was modified by another user. Please refresh and try again.',
        'ATTENDANCE_CONCURRENT_MODIFICATION'
      );
    }

    if (scopedMemberIdsList.length > 0) {
      const scopedMemberObjectIds = scopedMemberIdsList.map((memberId) =>
        this._toObjectId(memberId, 'memberId')
      );

      await User.updateMany(
        {
          _id: { $in: scopedMemberObjectIds },
          isDeleted: { $ne: true },
        },
        {
          $pull: {
            meetingAttendance: {
              meetingId: meetingObjectId,
              attendanceDate: normalizedAttendanceDate,
            },
          },
          $set: {
            updatedBy: actorObjectId,
          },
        }
      );

      if (selectedScopedMemberIds.length > 0) {
        await User.updateMany(
          {
            _id: {
              $in: selectedScopedMemberIds.map((memberId) => this._toObjectId(memberId, 'memberId')),
            },
            isDeleted: { $ne: true },
          },
          {
            $push: {
              meetingAttendance: {
                meetingId: meetingObjectId,
                attendanceDate: normalizedAttendanceDate,
                recordedBy: actorObjectId,
                updatedBy: actorObjectId,
                updatedAt: now,
              },
            },
            $set: {
              updatedBy: actorObjectId,
            },
          }
        );
      }

      await this._clearUserCaches(scopedMemberIdsList);
    }

    const actorUserMap = await this._buildUserMap([actorUserId]);
    const actorUser = actorUserMap.get(this._toId(actorUserId));

    return {
      attendanceDate: normalizedAttendanceDate,
      attendedMemberUserIds: selectedScopedMemberIds,
      recordUpdatedAt: now,
      recordUpdatedBy: {
        id: this._toId(actorUserId),
        fullName: actorUser?.fullName || '',
      },
      updatedAt: now,
      updatedBy: {
        id: this._toId(actorUserId),
        fullName: actorUser?.fullName || '',
      },
      viewerUpdatedAt: now,
      viewerUpdatedBy: {
        id: this._toId(actorUserId),
        fullName: actorUser?.fullName || '',
      },
      canManageAttendance: true,
    };
  }

  async updateMeetingBasic(id, payload, actorUserId) {
    const meeting = await Meeting.findOne({ _id: this._toObjectId(id), isDeleted: { $ne: true } });
    if (!meeting) {
      throw ApiError.notFound('Meeting was not found', 'RESOURCE_NOT_FOUND');
    }

    const previousSnapshot = meeting.toObject();
    const previousAvatarStorageKey = meeting.avatar?.storageKey || '';

    if (payload.sectorId !== undefined) {
      await this._assertSectorExists(payload.sectorId);
      meeting.sectorId = payload.sectorId;
    }

    const userIds = this._extractPayloadUserIds(payload);
    const userMap = await this._buildUserMap(userIds);
    const nextMeetingGroupAssignments = this._normalizeMeetingGroupAssignments(payload.groupAssignments || []);

    if (payload.name !== undefined) meeting.name = payload.name;
    if (payload.day !== undefined) meeting.day = payload.day;
    if (payload.time !== undefined) meeting.time = payload.time;
    if (payload.avatar !== undefined) meeting.avatar = payload.avatar || undefined;

    if (payload.serviceSecretary !== undefined) {
      meeting.serviceSecretary = payload.serviceSecretary
        ? this._hydratePerson(payload.serviceSecretary, userMap)
        : undefined;
    }

    if (payload.assistantSecretaries !== undefined) {
      meeting.assistantSecretaries = payload.assistantSecretaries.map((assistant) =>
        this._hydratePerson(assistant, userMap)
      );
    }

    if (payload.servedUserIds !== undefined) {
      meeting.servedUserIds = [...new Set(payload.servedUserIds.map((value) => this._toId(value)))];
    }

    if (payload.groups !== undefined) {
      meeting.groups = this._normalizeUniqueStrings(payload.groups);
    }

    if (payload.groupAssignments !== undefined) {
      meeting.groupAssignments = nextMeetingGroupAssignments;
      meeting.groups = this._normalizeUniqueStrings([
        ...(meeting.groups || []),
        ...nextMeetingGroupAssignments.map((entry) => entry.group),
      ]);

      const groupedServedUserIds = [
        ...new Set(nextMeetingGroupAssignments.flatMap((entry) => entry.servedUserIds || [])),
      ];
      meeting.servedUserIds = [...new Set([...(meeting.servedUserIds || []), ...groupedServedUserIds])];
    }

    if (payload.notes !== undefined) {
      meeting.notes = this._normalizeText(payload.notes) || undefined;
    }

    meeting.updatedBy = actorUserId;
    await meeting.save();

    await this._syncMeetingLinks(meeting._id, previousSnapshot, meeting.toObject());

    if (
      payload.avatar !== undefined &&
      previousAvatarStorageKey &&
      previousAvatarStorageKey !== meeting.avatar?.storageKey
    ) {
      await storageService.deleteFile(previousAvatarStorageKey);
    }

    return this.getMeetingById(meeting._id);
  }

  async updateMeetingServants(id, servants, actorUserId) {
    const meeting = await Meeting.findOne({ _id: this._toObjectId(id), isDeleted: { $ne: true } });
    if (!meeting) {
      throw ApiError.notFound('Meeting was not found', 'RESOURCE_NOT_FOUND');
    }

    const userIds = this._extractPayloadUserIds({ servants });
    const userMap = await this._buildUserMap(userIds);

    const previousSnapshot = meeting.toObject();
    meeting.servants = this._hydrateServants(servants, userMap);
    meeting.updatedBy = actorUserId;
    await meeting.save();

    await this._upsertResponsibilitiesFromServants(meeting.servants || []);
    await this._syncMeetingLinks(meeting._id, previousSnapshot, meeting.toObject());

    return this.getMeetingById(meeting._id);
  }

  /**
   * Idempotently merges one import group without deleting or moving any existing link.
   * This is intentionally narrow so offline imports reuse the meeting model validation,
   * user-link synchronization, and duplicate/conflict rules in-process.
   */
  async applyChurchServiceImportGroup(
    { meetingId, groupName, servantUserIds = [], memberUserIds = [], actorUserId },
    { session = null } = {}
  ) {
    const meetingObjectId = this._toObjectId(meetingId, 'meetingId');
    const actorObjectId = this._toObjectId(actorUserId, 'actorUserId');
    const normalizedGroupName = normalizeArabicComparison(groupName);
    if (!normalizedGroupName) {
      throw ApiError.badRequest('Group name is required', 'VALIDATION_ERROR');
    }

    const requestedServantIds = [...new Set(servantUserIds.map((id) => this._toId(this._toObjectId(id, 'servantUserId'))))];
    const requestedMemberIds = [...new Set(memberUserIds.map((id) => this._toId(this._toObjectId(id, 'memberUserId'))))];
    const requestedUserIds = [...new Set([...requestedServantIds, ...requestedMemberIds])];
    const [meeting, actor, userMap] = await Promise.all([
      Meeting.findOne({ _id: meetingObjectId, isDeleted: { $ne: true } }).session(session),
      User.findOne({ _id: actorObjectId, isDeleted: { $ne: true } })
        .select('_id role accountStatus isLocked')
        .session(session)
        .lean(),
      this._buildUserMap(requestedUserIds, session),
    ]);
    if (!meeting) throw ApiError.notFound('Meeting was not found', 'RESOURCE_NOT_FOUND');
    if (!actor) throw ApiError.notFound('Actor user was not found', 'USER_NOT_FOUND');
    if (!['ADMIN', 'SUPER_ADMIN'].includes(actor.role) || actor.accountStatus !== 'approved' || actor.isLocked) {
      throw ApiError.forbidden('Apply actor must be an approved, unlocked administrator', 'PERMISSION_DENIED');
    }
    if (userMap.size !== requestedUserIds.length) {
      throw ApiError.badRequest('One or more linked users were not found', 'USER_NOT_FOUND');
    }

    const allGroupNames = this._normalizeUniqueStrings([
      ...(meeting.groups || []),
      ...(meeting.groupAssignments || []).map((entry) => entry.group),
      ...(meeting.servants || []).flatMap((servant) => [
        ...(servant.groupsManaged || []),
        ...(servant.groupAssignments || []).map((entry) => entry.group),
      ]),
    ]);
    const equivalentNames = allGroupNames.filter(
      (name) => normalizeArabicComparison(name) === normalizedGroupName
    );
    if (equivalentNames.length > 1) {
      throw ApiError.conflict('Multiple existing groups match the requested group', 'DUPLICATE_GROUP');
    }
    const targetGroupName = equivalentNames[0] || this._normalizeText(groupName);
    const previousSnapshot = meeting.toObject();

    const existingGroupsByMember = new Map();
    const recordMemberGroups = (assignment) => {
      const assignmentName = this._normalizeText(assignment?.group);
      (assignment?.servedUserIds || []).forEach((memberId) => {
        const id = this._toId(memberId);
        if (!existingGroupsByMember.has(id)) existingGroupsByMember.set(id, new Set());
        existingGroupsByMember.get(id).add(assignmentName);
      });
    };
    (meeting.groupAssignments || []).forEach(recordMemberGroups);
    (meeting.servants || []).forEach((servant) => (servant.groupAssignments || []).forEach(recordMemberGroups));
    for (const memberId of requestedMemberIds) {
      const conflictingGroups = [...(existingGroupsByMember.get(memberId) || [])].filter(
        (name) => normalizeArabicComparison(name) !== normalizedGroupName
      );
      if (conflictingGroups.length) {
        throw ApiError.conflict(
          `User ${memberId} is already assigned to another group in this meeting`,
          'GROUP_MEMBERSHIP_CONFLICT'
        );
      }
    }

    meeting.groups = this._normalizeUniqueStrings([...(meeting.groups || []), targetGroupName]);
    const meetingAssignments = this._normalizeMeetingGroupAssignments(meeting.groupAssignments || []);
    let meetingAssignment = meetingAssignments.find(
      (entry) => normalizeArabicComparison(entry.group) === normalizedGroupName
    );
    if (!meetingAssignment) {
      meetingAssignment = { group: targetGroupName, servedUserIds: [] };
      meetingAssignments.push(meetingAssignment);
    }
    meetingAssignment.servedUserIds = [...new Set([
      ...(meetingAssignment.servedUserIds || []).map((id) => this._toId(id)),
      ...requestedMemberIds,
    ])];
    meeting.groupAssignments = meetingAssignments;
    meeting.servedUserIds = [...new Set([
      ...(meeting.servedUserIds || []).map((id) => this._toId(id)),
      ...requestedMemberIds,
    ])];

    for (const servantId of requestedServantIds) {
      let servant = (meeting.servants || []).find((entry) => this._toId(entry.userId) === servantId);
      if (!servant) {
        const [hydrated] = this._hydrateServants([{ userId: servantId }], userMap);
        meeting.servants.push(hydrated);
        servant = meeting.servants[meeting.servants.length - 1];
      }
      servant.groupsManaged = this._normalizeUniqueStrings([...(servant.groupsManaged || []), targetGroupName]);
      const assignments = this._normalizeServantGroupAssignments(servant.groupAssignments || []);
      let assignment = assignments.find((entry) => normalizeArabicComparison(entry.group) === normalizedGroupName);
      if (!assignment) {
        assignment = { group: targetGroupName, servedUserIds: [] };
        assignments.push(assignment);
      }
      assignment.servedUserIds = [...new Set([
        ...(assignment.servedUserIds || []).map((id) => this._toId(id)),
        ...requestedMemberIds,
      ])];
      servant.groupAssignments = assignments;
      servant.servedUserIds = [...new Set([
        ...(servant.servedUserIds || []).map((id) => this._toId(id)),
        ...requestedMemberIds,
      ])];
    }

    meeting.updatedBy = actorObjectId;
    await meeting.save({ session });
    await this._syncMeetingLinks(meeting._id, previousSnapshot, meeting.toObject(), { session });
    return {
      meetingId: this._toId(meeting._id),
      groupName: targetGroupName,
      servantUserIds: requestedServantIds,
      memberUserIds: requestedMemberIds,
    };
  }

  async updateMeetingCommittees(id, committees, actorUserId) {
    const meeting = await Meeting.findOne({ _id: this._toObjectId(id), isDeleted: { $ne: true } });
    if (!meeting) {
      throw ApiError.notFound('Meeting was not found', 'RESOURCE_NOT_FOUND');
    }

    const userIds = this._extractPayloadUserIds({ committees });
    const userMap = await this._buildUserMap(userIds);

    const previousSnapshot = meeting.toObject();
    meeting.committees = this._hydrateCommittees(committees, userMap);
    meeting.updatedBy = actorUserId;
    await meeting.save();

    await this._syncMeetingLinks(meeting._id, previousSnapshot, meeting.toObject());

    return this.getMeetingById(meeting._id);
  }

  async updateMeetingActivities(id, activities, actorUserId) {
    const meeting = await Meeting.findOne({ _id: this._toObjectId(id), isDeleted: { $ne: true } });
    if (!meeting) {
      throw ApiError.notFound('Meeting was not found', 'RESOURCE_NOT_FOUND');
    }

    meeting.activities = this._hydrateActivities(activities);
    meeting.updatedBy = actorUserId;
    await meeting.save();

    return this.getMeetingById(meeting._id);
  }

  async deleteMeeting(id, actorUserId) {
    const meeting = await Meeting.findOne({ _id: this._toObjectId(id), isDeleted: { $ne: true } });
    if (!meeting) {
      throw ApiError.notFound('Meeting was not found', 'RESOURCE_NOT_FOUND');
    }

    const previousSnapshot = meeting.toObject();
    meeting.isDeleted = true;
    meeting.deletedAt = new Date();
    meeting.deletedBy = actorUserId;
    meeting.updatedBy = actorUserId;

    await meeting.save();
    await this._syncMeetingLinks(meeting._id, previousSnapshot, null);
    if (meeting.avatar?.storageKey) {
      await storageService.deleteFile(meeting.avatar.storageKey);
    }
  }

  async listResponsibilitySuggestions({ search, limit = 30 }) {
    const query = {};
    if (search) {
      query.label = { $regex: this._normalizeText(search), $options: 'i' };
    }

    const docs = await MeetingResponsibility.find(query)
      .sort({ usageCount: -1, lastUsedAt: -1, label: 1 })
      .limit(limit)
      .lean();

    return docs.map((doc) => ({
      id: this._toId(doc._id),
      label: doc.label,
      usageCount: doc.usageCount || 0,
      lastUsedAt: doc.lastUsedAt || null,
    }));
  }

  async getServantHistory({ userId, name, limit = 10 }) {
    const matchCondition = {};

    if (userId) {
      matchCondition['servants.userId'] = this._toObjectId(userId, 'userId');
    }

    const normalizedName = this._normalizeText(name).toLowerCase();
    if (normalizedName) {
      matchCondition['servants.normalizedName'] = normalizedName;
    }

    const meetings = await Meeting.find({
      isDeleted: { $ne: true },
      ...matchCondition,
    })
      .sort({ updatedAt: -1, _id: -1 })
      .limit(limit)
      // Project down to the servant fields this actually reads. Without it every
      // matched meeting arrives whole — attendance history, member notes and each
      // servant's `servedUserIds` / `groupAssignments` — none of which is used
      // below. Subfield projection preserves array order, so the filter and the
      // `matchingServants` mapping are unaffected.
      .select(
        'name day time updatedAt sectorId'
        + ' servants.userId servants.normalizedName servants.name'
        + ' servants.responsibility servants.groupsManaged servants.notes'
      )
      .populate('sectorId', 'name')
      .lean();

    const history = meetings.map((meeting) => {
      const matchingServants = (meeting.servants || []).filter((servant) => {
        if (userId && servant.userId && this._toId(servant.userId) === this._toId(userId)) return true;
        if (normalizedName && servant.normalizedName === normalizedName) return true;
        return false;
      });

      return {
        meeting: {
          id: this._toId(meeting._id),
          name: meeting.name,
          day: meeting.day,
          time: meeting.time,
          sector: meeting.sectorId
            ? {
                id: this._toId(meeting.sectorId._id || meeting.sectorId),
                name: meeting.sectorId.name || null,
              }
            : null,
        },
        servantEntries: matchingServants.map((servant) => ({
          name: servant.name,
          responsibility: servant.responsibility || '',
          groupsManaged: servant.groupsManaged || [],
          notes: servant.notes || '',
        })),
        updatedAt: meeting.updatedAt,
      };
    });

    const responsibilities = this._normalizeUniqueStrings(
      history.flatMap((entry) => entry.servantEntries.map((servant) => servant.responsibility))
    );

    return {
      history,
      responsibilities,
    };
  }

  // ---------------------------------------------------------------------------
  // PUBLIC (no-login) read-only projections.
  // SECURITY: These methods MUST return only safe, non-personal fields via an
  // explicit `.select(...).lean()` whitelist and explicit field mapping. Never
  // return the raw document, never spread it, and never expose servants,
  // committees, notes, attendance, officials, or any user references.
  // ---------------------------------------------------------------------------

  _mapPublicMeeting(meeting) {
    if (!meeting) return null;
    return {
      _id: this._toId(meeting._id),
      name: meeting.name || '',
      day: meeting.day || '',
      time: meeting.time || '',
      sector: meeting.sectorId
        ? {
            _id: this._toId(meeting.sectorId._id || meeting.sectorId),
            name: meeting.sectorId.name || '',
          }
        : null,
    };
  }

  _mapPublicSector(sector) {
    if (!sector) return null;
    return {
      _id: this._toId(sector._id),
      name: sector.name || '',
    };
  }

  async getPublicMeetings() {
    const meetings = await Meeting.find({ isDeleted: { $ne: true } })
      .select('_id name day time sectorId')
      .populate({ path: 'sectorId', select: '_id name', match: { isDeleted: { $ne: true } } })
      .sort({ day: 1, time: 1, name: 1 })
      .lean();

    return meetings.map((meeting) => this._mapPublicMeeting(meeting));
  }

  async getPublicMeetingById(id) {
    const meetingId = this._toObjectId(id, 'meeting id');
    const meeting = await Meeting.findOne({ _id: meetingId, isDeleted: { $ne: true } })
      .select('_id name day time sectorId')
      .populate({ path: 'sectorId', select: '_id name', match: { isDeleted: { $ne: true } } })
      .lean();

    if (!meeting) {
      throw ApiError.notFound('Meeting not found', 'MEETING_NOT_FOUND');
    }

    return this._mapPublicMeeting(meeting);
  }

  async getPublicSectors() {
    const sectors = await Sector.find({ isDeleted: { $ne: true } })
      .select('_id name')
      .sort({ name: 1 })
      .lean();

    return sectors.map((sector) => this._mapPublicSector(sector));
  }

  async getPublicSectorById(id) {
    const sectorId = this._toObjectId(id, 'sector id');
    const sector = await Sector.findOne({ _id: sectorId, isDeleted: { $ne: true } })
      .select('_id name')
      .lean();

    if (!sector) {
      throw ApiError.notFound('Sector not found', 'SECTOR_NOT_FOUND');
    }

    const meetings = await Meeting.find({ sectorId, isDeleted: { $ne: true } })
      .select('_id name day time')
      .sort({ day: 1, time: 1, name: 1 })
      .lean();

    return {
      ...this._mapPublicSector(sector),
      meetings: meetings.map((meeting) => ({
        _id: this._toId(meeting._id),
        name: meeting.name || '',
        day: meeting.day || '',
        time: meeting.time || '',
      })),
    };
  }
}

module.exports = new MeetingsService();
