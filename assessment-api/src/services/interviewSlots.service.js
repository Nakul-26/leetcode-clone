import * as slotsRepo from "../repositories/interviewSlots.repo.js";
import * as drivesRepo from "../repositories/drives.repo.js";
import * as candidatesRepo from "../repositories/driveCandidates.repo.js";
import * as notificationService from "./notification.service.js";
import User from "../../models/User.mjs";
import { HttpError } from "../utils/httpError.js";
import { generateAccessToken, hashAccessToken } from "../utils/interviewToken.js";
import { env } from "../config/env.js";

// superadmin operates across colleges; everyone else is scoped to their own.
function collegeScopeFor(user) {
  if (!user || user.role === 'superadmin') return undefined;
  return user.collegeId || undefined;
}

function assertStaff(user) {
  if (!user || user.role === 'student') {
    throw new HttpError(403, "Forbidden");
  }
}

const ACTIVE_STATUSES = ['Scheduled'];

async function loadCandidateAndDriveForStaff(driveCandidateId, user) {
  assertStaff(user);
  const candidate = await candidatesRepo.findById(driveCandidateId, collegeScopeFor(user));
  if (!candidate) throw new HttpError(404, "Candidate not found");
  const drive = await drivesRepo.findById(candidate.driveId, collegeScopeFor(user));
  if (!drive) throw new HttpError(404, "Drive not found");
  return { candidate, drive };
}

function resolveInterviewRound(drive, roundIndex) {
  const round = drive.rounds[roundIndex];
  if (!round) throw new HttpError(400, "Invalid round index for this drive");
  if (round.type !== 'interview') {
    throw new HttpError(400, `Round ${roundIndex + 1} ('${round.name}') is not an interview round`);
  }
  return round;
}

function candidateEmail(candidate) {
  return candidate.studentId?.email;
}

export async function scheduleSlot(driveCandidateId, payload, user) {
  const { candidate, drive } = await loadCandidateAndDriveForStaff(driveCandidateId, user);

  const roundIndex = payload.roundIndex ?? candidate.currentRoundIndex;
  const round = resolveInterviewRound(drive, roundIndex);

  if (!payload.scheduledAt || isNaN(new Date(payload.scheduledAt).getTime())) {
    throw new HttpError(400, "A valid scheduledAt date is required");
  }

  let interviewer = null;
  if (payload.interviewerId) {
    interviewer = await User.findById(payload.interviewerId);
    if (!interviewer || !['admin', 'faculty', 'superadmin'].includes(interviewer.role)) {
      throw new HttpError(400, "interviewerId must reference a staff user");
    }
  } else if (!payload.externalInterviewerEmail) {
    throw new HttpError(400, "Provide either interviewerId or externalInterviewerEmail");
  }

  const data = {
    driveId: drive._id,
    driveCandidateId: candidate._id,
    studentId: candidate.studentId._id || candidate.studentId,
    roundIndex,
    collegeId: candidate.collegeId,
    interviewerId: interviewer ? interviewer._id : undefined,
    externalInterviewerName: interviewer ? undefined : (payload.externalInterviewerName || undefined),
    externalInterviewerEmail: interviewer ? undefined : (payload.externalInterviewerEmail || undefined),
    scheduledAt: new Date(payload.scheduledAt),
    durationMinutes: payload.durationMinutes || 30,
    meetingLink: payload.meetingLink || undefined,
    notes: payload.notes || undefined,
    createdBy: user._id
  };

  let accessToken;
  if (!interviewer) {
    accessToken = generateAccessToken();
    data.accessTokenHash = hashAccessToken(accessToken);
    data.accessTokenExpiresAt = new Date(data.scheduledAt.getTime() + 24 * 60 * 60 * 1000);
  }

  const slot = await slotsRepo.create(data);

  const when = data.scheduledAt.toUTCString();
  await notificationService.sendMail({
    to: candidateEmail(candidate),
    subject: `Interview scheduled: ${drive.companyName} - ${round.name}`,
    text: `Your ${round.name} interview for ${drive.companyName} is scheduled for ${when}.` +
      (data.meetingLink ? ` Meeting link: ${data.meetingLink}` : '')
  });

  if (interviewer) {
    await notificationService.sendMail({
      to: interviewer.email,
      subject: `Interview assigned: ${drive.companyName} - ${round.name}`,
      text: `You've been assigned to interview a candidate for ${drive.companyName} (${round.name}) at ${when}.`
    });
  } else {
    const link = `${env.APP_BASE_URL}/interview/${accessToken}`;
    await notificationService.sendMail({
      to: data.externalInterviewerEmail,
      subject: `Interview invitation: ${drive.companyName} - ${round.name}`,
      text: `You've been invited to conduct a ${round.name} interview for ${drive.companyName} at ${when}. ` +
        `View details here: ${link} (link expires 24h after the scheduled time).`
    });
  }

  return { slot, accessToken };
}

export async function rescheduleSlot(id, payload, user) {
  assertStaff(user);
  const existing = await slotsRepo.findById(id, collegeScopeFor(user));
  if (!existing) throw new HttpError(404, "Interview slot not found");
  if (!ACTIVE_STATUSES.includes(existing.status)) {
    throw new HttpError(409, `Slot is ${existing.status} and cannot be rescheduled`);
  }

  const update = {};
  if (payload.scheduledAt) {
    if (isNaN(new Date(payload.scheduledAt).getTime())) {
      throw new HttpError(400, "scheduledAt must be a valid date");
    }
    update.scheduledAt = new Date(payload.scheduledAt);
  }
  if (payload.durationMinutes) update.durationMinutes = payload.durationMinutes;
  if (payload.meetingLink !== undefined) update.meetingLink = payload.meetingLink;
  if (payload.notes !== undefined) update.notes = payload.notes;

  const slot = await slotsRepo.updateById(id, update, collegeScopeFor(user));

  await notificationService.sendMail({
    to: candidateEmail(slot),
    subject: `Interview rescheduled`,
    text: `Your interview has been rescheduled to ${slot.scheduledAt.toUTCString()}.`
  });

  return slot;
}

export async function cancelSlot(id, user) {
  assertStaff(user);
  const existing = await slotsRepo.findById(id, collegeScopeFor(user));
  if (!existing) throw new HttpError(404, "Interview slot not found");
  if (!ACTIVE_STATUSES.includes(existing.status)) {
    throw new HttpError(409, `Slot is already ${existing.status}`);
  }

  const slot = await slotsRepo.updateById(id, { status: 'Cancelled' }, collegeScopeFor(user));

  await notificationService.sendMail({
    to: candidateEmail(slot),
    subject: `Interview cancelled`,
    text: `Your interview scheduled for ${slot.scheduledAt.toUTCString()} has been cancelled.`
  });

  return slot;
}

export async function completeSlot(id, notes, user) {
  assertStaff(user);
  const existing = await slotsRepo.findById(id, collegeScopeFor(user));
  if (!existing) throw new HttpError(404, "Interview slot not found");
  if (!ACTIVE_STATUSES.includes(existing.status)) {
    throw new HttpError(409, `Slot is already ${existing.status}`);
  }

  const update = { status: 'Completed' };
  if (notes !== undefined) update.notes = notes;
  return slotsRepo.updateById(id, update, collegeScopeFor(user));
}

export async function regenerateExternalLink(id, user) {
  assertStaff(user);
  const existing = await slotsRepo.findById(id, collegeScopeFor(user));
  if (!existing) throw new HttpError(404, "Interview slot not found");
  if (!existing.externalInterviewerEmail) {
    throw new HttpError(400, "This slot has an internal interviewer, not an external link");
  }
  if (!ACTIVE_STATUSES.includes(existing.status)) {
    throw new HttpError(409, `Slot is ${existing.status}, cannot regenerate a link`);
  }

  const accessToken = generateAccessToken();
  const accessTokenExpiresAt = new Date(existing.scheduledAt.getTime() + 24 * 60 * 60 * 1000);
  const slot = await slotsRepo.updateById(
    id,
    { accessTokenHash: hashAccessToken(accessToken), accessTokenExpiresAt },
    collegeScopeFor(user)
  );

  const link = `${env.APP_BASE_URL}/interview/${accessToken}`;
  await notificationService.sendMail({
    to: existing.externalInterviewerEmail,
    subject: `Updated interview link`,
    text: `Your interview access link has been renewed: ${link} (expires 24h after the scheduled time).`
  });

  return { slot, accessToken };
}

export async function listSlotsForDrive(driveId, user) {
  assertStaff(user);
  const drive = await drivesRepo.findById(driveId, collegeScopeFor(user));
  if (!drive) throw new HttpError(404, "Drive not found");
  return slotsRepo.findAll({ driveId });
}

export async function listSlotsForCandidate(driveCandidateId, user) {
  const candidate = await candidatesRepo.findById(driveCandidateId, collegeScopeFor(user));
  if (!candidate) throw new HttpError(404, "Candidate not found");
  if (user.role === 'student' && String(candidate.studentId._id || candidate.studentId) !== String(user._id)) {
    throw new HttpError(403, "Forbidden");
  }
  return slotsRepo.findAll({ driveCandidateId });
}

export async function getMySlots(user) {
  if (user.role === 'student') return slotsRepo.findAll({ studentId: user._id });
  return slotsRepo.findAll({ interviewerId: user._id });
}

export async function getSlotById(id, user) {
  if (user.role === 'student') {
    const slot = await slotsRepo.findById(id, collegeScopeFor(user));
    if (!slot || String(slot.studentId._id || slot.studentId) !== String(user._id)) {
      throw new HttpError(404, "Interview slot not found");
    }
    return slot;
  }
  assertStaff(user);
  const slot = await slotsRepo.findById(id, collegeScopeFor(user));
  if (!slot) throw new HttpError(404, "Interview slot not found");
  return slot;
}

export async function getSlotByToken(token) {
  if (!token) throw new HttpError(404, "Interview slot not found");
  const slot = await slotsRepo.findByTokenHash(hashAccessToken(token));
  if (!slot) throw new HttpError(404, "Interview slot not found or link has expired");

  const drive = await drivesRepo.findById(slot.driveId);
  const round = drive?.rounds?.[slot.roundIndex];

  return {
    _id: slot._id,
    companyName: drive?.companyName,
    roundName: round?.name,
    candidateName: slot.studentId?.name,
    scheduledAt: slot.scheduledAt,
    durationMinutes: slot.durationMinutes,
    meetingLink: slot.meetingLink,
    status: slot.status
  };
}

// Used by the WebSocket signaling layer (realtime/signaling.js) to authorize a socket
// joining a live interview room. `id` is the slotId the client is asking to join; for the
// external-token branch it's cross-checked against the token's actual slot so a valid
// token for one slot can't be reused to join a different slotId by just changing the
// join-room payload.
export async function resolveSlotForParticipant(id, { user, accessToken } = {}) {
  if (accessToken) {
    const slot = await slotsRepo.findByTokenHash(hashAccessToken(accessToken));
    if (!slot || String(slot._id) !== String(id)) {
      throw new HttpError(403, "Invalid or expired interview link");
    }
    return { slot, identity: { kind: 'external', name: slot.externalInterviewerName || 'Interviewer' } };
  }

  if (!user) throw new HttpError(401, "Authentication required");

  if (user.role === 'student') {
    const slot = await slotsRepo.findById(id, collegeScopeFor(user));
    if (!slot || String(slot.studentId._id || slot.studentId) !== String(user._id)) {
      throw new HttpError(404, "Interview slot not found");
    }
    return { slot, identity: { kind: 'candidate', name: user.name, userId: user._id } };
  }

  assertStaff(user);
  const slot = await slotsRepo.findById(id, collegeScopeFor(user));
  if (!slot) throw new HttpError(404, "Interview slot not found");
  return { slot, identity: { kind: 'interviewer', name: user.name, userId: user._id } };
}

function buildScorecardEntry(payload, identity) {
  const ratingsInput = payload.ratings || {};
  const ratings = {};
  for (const key of ['communication', 'problemSolving', 'technicalDepth']) {
    if (ratingsInput[key] === undefined || ratingsInput[key] === null) continue;
    const v = Number(ratingsInput[key]);
    if (!Number.isInteger(v) || v < 1 || v > 5) {
      throw new HttpError(400, `${key} rating must be an integer from 1 to 5`);
    }
    ratings[key] = v;
  }
  return { ...identity, ratings, notes: payload.notes || undefined, submittedAt: new Date() };
}

// One entry per distinct submitter - re-submitting replaces only that submitter's own
// entry rather than the whole array, so a multi-interviewer panel doesn't clobber each
// other's scorecards (a real bug from the single-scorecard-field version: the second
// submitter silently overwrote the first's, found during a live two-tab smoke test).
function upsertScorecardEntry(existingScorecards, entry) {
  const existing = existingScorecards || [];
  const matchesEntry = (s) => (
    entry.role === 'interviewer'
      ? s.role === 'interviewer' && String(s.submittedByUserId) === String(entry.submittedByUserId)
      : s.role === 'external'
  );
  const idx = existing.findIndex(matchesEntry);
  return idx === -1 ? [...existing, entry] : existing.map((s, i) => (i === idx ? entry : s));
}

export async function submitScorecard(id, payload, user) {
  assertStaff(user);
  const slot = await slotsRepo.findById(id, collegeScopeFor(user));
  if (!slot) throw new HttpError(404, "Interview slot not found");
  const entry = buildScorecardEntry(payload, { role: 'interviewer', submittedByUserId: user._id, submittedByName: user.name });
  const scorecards = upsertScorecardEntry(slot.scorecards, entry);
  return slotsRepo.updateById(id, { scorecards }, collegeScopeFor(user));
}

export async function submitScorecardByToken(token, payload) {
  const slot = await slotsRepo.findByTokenHash(hashAccessToken(token));
  if (!slot) throw new HttpError(404, "Interview slot not found or link has expired");
  const entry = buildScorecardEntry(payload, { role: 'external', submittedByName: slot.externalInterviewerName || 'External interviewer' });
  const scorecards = upsertScorecardEntry(slot.scorecards, entry);
  return slotsRepo.updateById(slot._id, { scorecards }, undefined);
}
