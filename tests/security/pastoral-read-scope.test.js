/**
 * Read-scope regression suite for the two pastoral modules.
 *
 * Before this change, holding `CONFESSIONS_VIEW` or
 * `PASTORAL_VISITATIONS_VIEW` — both granted to every ADMIN by default —
 * returned every note ever written, plus phone numbers. These tests pin the
 * narrowed behaviour so it cannot silently regress.
 */

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { PERMISSIONS } = require('../../src/constants/permissions');
const { ROLES } = require('../../src/constants/roles');

const confessionsService = require('../../src/modules/confessions/confessions.service');
const visitationsService = require('../../src/modules/visitations/visitations.service');

const RECORDER = 'recorder-1';
const ATTENDEE = 'attendee-1';
const FATHER = 'father-1';
const STRANGER = 'stranger-1';

const NOTE = 'CONFIDENTIAL pastoral note body';

function session({ attendeeFather = FATHER } = {}) {
  return {
    _id: 'session-1',
    attendeeUserId: {
      _id: ATTENDEE,
      fullName: 'Mina Adel',
      phonePrimary: '01000000000',
      avatar: null,
      role: 'USER',
      confessionFatherUserId: attendeeFather,
    },
    sessionTypeId: { _id: 'type-1', name: 'Regular' },
    createdBy: { _id: RECORDER, fullName: 'Fr. Recorder' },
    scheduledAt: new Date('2026-01-01'),
    notes: NOTE,
  };
}

function visitation() {
  return {
    _id: 'visit-1',
    houseName: 'Adel',
    durationMinutes: 30,
    visitedAt: new Date('2026-01-01'),
    notes: NOTE,
    recordedBy: { _id: RECORDER, fullName: 'Fr. Recorder', phonePrimary: '01000000000' },
    createdAt: new Date('2026-01-01'),
  };
}

describe('confession session notes', () => {
  const map = (viewer) => confessionsService._mapSession(session(), viewer);

  it('are visible to the person who recorded the session', () => {
    const result = map({ viewerUserId: RECORDER });
    expect(result.notes).toBe(NOTE);
    expect(result.notesRestricted).toBe(false);
  });

  it('are visible to the attendee themself', () => {
    expect(map({ viewerUserId: ATTENDEE }).notes).toBe(NOTE);
  });

  it("are visible to the attendee's assigned confession father", () => {
    expect(map({ viewerUserId: FATHER }).notes).toBe(NOTE);
  });

  it('are visible to SUPER_ADMIN', () => {
    expect(map({ viewerUserId: STRANGER, viewerRole: ROLES.SUPER_ADMIN }).notes).toBe(NOTE);
  });

  // The core regression: CONFESSIONS_VIEW alone is no longer enough.
  it('are hidden from an unrelated holder of CONFESSIONS_VIEW', () => {
    const result = map({
      viewerUserId: STRANGER,
      viewerRole: ROLES.ADMIN,
      viewerPermissions: [PERMISSIONS.CONFESSIONS_VIEW],
    });

    expect(result.notes).toBe('');
    expect(result.notesRestricted).toBe(true);
    expect(JSON.stringify(result)).not.toContain('CONFIDENTIAL');
  });

  it('are hidden even from a holder of every confession permission', () => {
    const everyConfessionPermission = Object.values(PERMISSIONS)
      .filter((p) => p.startsWith('CONFESSIONS_'));

    const result = map({
      viewerUserId: STRANGER,
      viewerRole: ROLES.ADMIN,
      viewerPermissions: everyConfessionPermission,
    });

    expect(result.notes).toBe('');
    expect(result.notesRestricted).toBe(true);
  });

  it('are hidden when there is no viewer context at all', () => {
    expect(confessionsService._mapSession(session()).notes).toBe('');
    expect(confessionsService._mapSession(session(), {}).notes).toBe('');
  });

  it('does not treat a null confession father as a match for a null viewer', () => {
    const result = confessionsService._mapSession(
      session({ attendeeFather: null }),
      { viewerUserId: null }
    );
    expect(result.notesRestricted).toBe(true);
  });

  it('still returns session metadata to a restricted viewer', () => {
    const result = map({ viewerUserId: STRANGER, viewerPermissions: [PERMISSIONS.CONFESSIONS_VIEW] });
    expect(result.attendee.fullName).toBe('Mina Adel');
    expect(result.sessionType.name).toBe('Regular');
    expect(result.scheduledAt).toBeDefined();
  });
});

describe('confession attendee phone number', () => {
  const map = (viewer) => confessionsService._mapSession(session(), viewer);

  it('is returned to someone who may read the notes', () => {
    expect(map({ viewerUserId: RECORDER }).attendee.phonePrimary).toBe('01000000000');
  });

  it('is returned to a holder of CONFESSIONS_ASSIGN_USER', () => {
    const result = map({
      viewerUserId: STRANGER,
      viewerPermissions: [PERMISSIONS.CONFESSIONS_ASSIGN_USER],
    });
    expect(result.attendee.phonePrimary).toBe('01000000000');
  });

  it('is withheld from a plain CONFESSIONS_VIEW holder', () => {
    const result = map({
      viewerUserId: STRANGER,
      viewerPermissions: [PERMISSIONS.CONFESSIONS_VIEW],
    });
    expect(result.attendee.phonePrimary).toBeNull();
    expect(JSON.stringify(result)).not.toContain('01000000000');
  });
});

describe('visitation notes', () => {
  const map = (viewer) => visitationsService._mapVisitation(visitation(), viewer);

  it('are visible to the recorder', () => {
    const result = map({ viewerUserId: RECORDER });
    expect(result.notes).toBe(NOTE);
    expect(result.notesRestricted).toBe(false);
  });

  it('are visible to SUPER_ADMIN', () => {
    expect(map({ viewerUserId: STRANGER, viewerRole: ROLES.SUPER_ADMIN }).notes).toBe(NOTE);
  });

  it('are hidden from an unrelated PASTORAL_VISITATIONS_VIEW holder', () => {
    const result = map({
      viewerUserId: STRANGER,
      viewerRole: ROLES.ADMIN,
      viewerPermissions: [PERMISSIONS.PASTORAL_VISITATIONS_VIEW],
    });

    expect(result.notes).toBe('');
    expect(result.notesRestricted).toBe(true);
    expect(JSON.stringify(result)).not.toContain('CONFIDENTIAL');
  });

  it('are hidden when there is no viewer context', () => {
    expect(visitationsService._mapVisitation(visitation()).notes).toBe('');
  });

  it('still returns visit metadata to a restricted viewer', () => {
    const result = map({ viewerUserId: STRANGER });
    expect(result.houseName).toBe('Adel');
    expect(result.durationMinutes).toBe(30);
    expect(result.recordedBy.fullName).toBe('Fr. Recorder');
  });
});

describe("visitation recorder's phone number", () => {
  // It is staff personal data with no role in a visitation record, so it is
  // removed unconditionally rather than permission-gated.
  it.each([
    ['the recorder', { viewerUserId: RECORDER }],
    ['a SUPER_ADMIN', { viewerUserId: STRANGER, viewerRole: ROLES.SUPER_ADMIN }],
    ['an unrelated viewer', { viewerUserId: STRANGER }],
  ])('is never returned, not even to %s', (_label, viewer) => {
    const result = visitationsService._mapVisitation(visitation(), viewer);
    expect(result.recordedBy.phonePrimary).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('01000000000');
  });
});

describe('static guarantee: no read path selects the recorder phone', () => {
  const fs = require('fs');
  const path = require('path');

  it('visitations service never populates phonePrimary for the recorder', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/modules/visitations/visitations.service.js'),
      'utf8'
    );
    expect(source).not.toContain("populate('recordedBy', 'fullName phonePrimary')");
  });
});
