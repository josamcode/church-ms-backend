const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { buildPaginationMeta } = require('../../utils/pagination');
const { PERMISSIONS } = require('../../constants/permissions');
const cloudinary = require('../../config/cloudinary');
const config = require('../../config/env');
const logger = require('../../utils/logger');
const streamifier = require('streamifier');
const User = require('../users/user.model');
const Sector = require('./sector.model');
const Meeting = require('./meeting.model');
const MeetingResponsibility = require('./meetingResponsibility.model');

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

  _hasPermission(permissions = [], permission) {
    return Array.isArray(permissions) && permissions.includes(permission);
  }

  _hasAnyPermission(permissions = [], requiredPermissions = []) {
    return (requiredPermissions || []).some((permission) => this._hasPermission(permissions, permission));
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

  async _buildUserMap(ids = []) {
    if (!ids.length) return new Map();
    const users = await User.find({ _id: { $in: ids }, isDeleted: { $ne: true } })
      .select('fullName phonePrimary')
      .lean();
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
      },
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

  async _syncMeetingLinks(meetingId, previousMeetingDoc, nextMeetingDoc) {
    const previousIds = new Set(this._extractLinkedUserIdsFromMeeting(previousMeetingDoc));
    const nextIds = new Set(this._extractLinkedUserIdsFromMeeting(nextMeetingDoc));

    const idsToAdd = [...nextIds].filter((id) => !previousIds.has(id));
    const idsToRemove = [...previousIds].filter((id) => !nextIds.has(id));

    const operations = [];
    if (idsToAdd.length) {
      operations.push(
        User.updateMany(
          { _id: { $in: idsToAdd }, isDeleted: { $ne: true } },
          { $addToSet: { meetingIds: this._toObjectId(meetingId) } }
        )
      );
    }

    if (idsToRemove.length) {
      operations.push(
        User.updateMany(
          { _id: { $in: idsToRemove }, isDeleted: { $ne: true } },
          { $pull: { meetingIds: this._toObjectId(meetingId) } }
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

  async uploadImageToCloudinary(file) {
    if (!file) {
      throw ApiError.badRequest('Please choose an image', 'UPLOAD_FAILED');
    }

    if (!config.upload.allowedImageTypes.includes(file.mimetype)) {
      throw ApiError.badRequest(
        'Unsupported file type. Allowed: JPEG, PNG, GIF, WEBP',
        'UPLOAD_INVALID_TYPE'
      );
    }

    if (file.size > config.upload.maxFileSize) {
      throw ApiError.badRequest(
        `File exceeds size limit (${Math.round(config.upload.maxFileSize / 1024 / 1024)} MB)`,
        'UPLOAD_FILE_TOO_LARGE'
      );
    }

    const result = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: 'church/meeting-avatars',
          resource_type: 'image',
          transformation: [
            { width: 400, height: 400, crop: 'fill', gravity: 'auto' },
            { quality: 'auto', fetch_format: 'auto' },
          ],
        },
        (error, uploadResult) => {
          if (error) {
            logger.error(`Cloudinary upload error: ${error.message}`);
            reject(ApiError.internal('Failed to upload image'));
            return;
          }

          resolve(uploadResult);
        }
      );

      streamifier.createReadStream(file.buffer).pipe(uploadStream);
    });

    return { url: result.secure_url, publicId: result.public_id };
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
    const sectors = await Sector.find(query)
      .sort({ createdAt: sortDirection, _id: sortDirection })
      .limit(limit)
      .populate('officials.userId', 'fullName phonePrimary')
      .lean();

    return {
      sectors: sectors.map((sector) => this._mapSector(sector)),
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

    if (payload.name !== undefined) sector.name = payload.name;
    if (payload.avatar !== undefined) sector.avatar = payload.avatar || undefined;
    if (payload.officials !== undefined) sector.officials = this._hydrateOfficials(payload.officials, userMap);
    if (payload.notes !== undefined) sector.notes = this._normalizeText(payload.notes) || undefined;

    sector.updatedBy = actorUserId;
    await sector.save();

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

  async listMeetings({
    cursor,
    limit = 20,
    order = 'desc',
    filters = {},
    actorUserId = null,
    userPermissions = [],
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

    const meetings = await Meeting.find(query)
      .sort({ createdAt: sortDirection, _id: sortDirection })
      .limit(limit)
      .populate('sectorId', 'name avatar')
      .populate('serviceSecretary.userId', 'fullName phonePrimary')
      .populate('assistantSecretaries.userId', 'fullName phonePrimary')
      .populate('servants.userId', 'fullName phonePrimary')
      .populate('servants.servedUserIds', 'fullName phonePrimary')
      .populate('servants.groupAssignments.servedUserIds', 'fullName phonePrimary')
      .populate('servedUserIds', 'fullName phonePrimary')
      .populate('groupAssignments.servedUserIds', 'fullName phonePrimary')
      .populate('committees.memberUserIds', 'fullName phonePrimary')
      .lean();

    const mappedMeetings = meetings
      .map((meeting) => {
        const accessContext = this._resolveMeetingAccess({
          meeting,
          actorUserId,
          userPermissions,
        });
        if (!accessContext.allowed) return null;
        return this._mapMeetingByAccess(meeting, accessContext);
      })
      .filter(Boolean);

    return {
      meetings: mappedMeetings,
      meta: buildPaginationMeta(mappedMeetings, limit, 'createdAt'),
    };
  }

  async getMeetingById(id, { actorUserId = null, userPermissions = [] } = {}) {
    const meeting = await Meeting.findOne({ _id: this._toObjectId(id), isDeleted: { $ne: true } })
      .populate('sectorId', 'name avatar')
      .populate('serviceSecretary.userId', 'fullName phonePrimary')
      .populate('assistantSecretaries.userId', 'fullName phonePrimary')
      .populate('servants.userId', 'fullName phonePrimary')
      .populate('servants.servedUserIds', 'fullName phonePrimary')
      .populate('servants.groupAssignments.servedUserIds', 'fullName phonePrimary')
      .populate('servedUserIds', 'fullName phonePrimary')
      .populate('groupAssignments.servedUserIds', 'fullName phonePrimary')
      .populate('committees.memberUserIds', 'fullName phonePrimary')
      .lean();

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

    return this._mapMeetingByAccess(meeting, accessContext);
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

  async updateMeetingBasic(id, payload, actorUserId) {
    const meeting = await Meeting.findOne({ _id: this._toObjectId(id), isDeleted: { $ne: true } });
    if (!meeting) {
      throw ApiError.notFound('Meeting was not found', 'RESOURCE_NOT_FOUND');
    }

    const previousSnapshot = meeting.toObject();

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
}

module.exports = new MeetingsService();
