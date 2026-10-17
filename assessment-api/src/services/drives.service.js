import * as drivesRepo from "../repositories/drives.repo.js";
import * as candidatesRepo from "../repositories/driveCandidates.repo.js";
import User from "../../models/User.mjs";
import { HttpError } from "../utils/httpError.js";

// superadmin operates across colleges; everyone else is scoped to their own.
// Returns undefined for "no scoping" (repo layer treats a falsy collegeId as unscoped).
function collegeScopeFor(user) {
  if (!user || user.role === 'superadmin') return undefined;
  return user.collegeId || undefined;
}

function assertStaff(user) {
  if (!user || user.role === 'student') {
    throw new HttpError(403, "Forbidden");
  }
}

export async function listDrives(query = {}, user) {
  const filter = {};

  if (!user || user.role === 'student') {
    filter.status = 'Active';
  } else if (query.status) {
    filter.status = query.status;
  }

  const collegeId = collegeScopeFor(user);
  if (collegeId) filter.collegeId = collegeId;

  return drivesRepo.findAll(filter, { sort: { createdAt: -1 } });
}

export async function getDriveById(id, user) {
  const drive = await drivesRepo.findById(id, collegeScopeFor(user));
  if (!drive) return null;

  if (user.role === 'student' && drive.status === 'Draft') {
    return null;
  }

  return drive;
}

export async function createDrive(payload, user) {
  assertStaff(user);
  validateDrivePayload(payload);
  const data = {
    companyName: payload.companyName,
    description: payload.description,
    rounds: payload.rounds,
    eligibility: payload.eligibility || {},
    status: payload.status || 'Draft',
    createdBy: user._id,
    collegeId: user.role === 'superadmin' ? (payload.collegeId || undefined) : (user.collegeId || undefined)
  };
  return drivesRepo.create(data);
}

export async function updateDrive(id, payload, user) {
  assertStaff(user);
  validateDrivePayload(payload);
  const { collegeId, createdBy, ...safePayload } = payload; // both immutable post-creation via this path
  const drive = await drivesRepo.updateById(id, safePayload, collegeScopeFor(user));
  if (!drive) throw new HttpError(404, "Drive not found");
  return drive;
}

export async function deleteDrive(id, user) {
  if (!user || !['admin', 'superadmin'].includes(user.role)) {
    throw new HttpError(403, "Forbidden");
  }
  const drive = await drivesRepo.deleteById(id, collegeScopeFor(user));
  if (!drive) throw new HttpError(404, "Drive not found");
  return drive;
}

function validateDrivePayload(payload) {
  const errors = [];
  if (!payload.companyName) errors.push("Company name is required");
  if (!Array.isArray(payload.rounds) || payload.rounds.length === 0) {
    errors.push("At least one round is required");
  } else {
    payload.rounds.forEach((round, idx) => {
      if (!round.name) errors.push(`Round ${idx + 1}: name is required`);
      if (!['assessment', 'interview'].includes(round.type)) {
        errors.push(`Round ${idx + 1}: type must be 'assessment' or 'interview'`);
      }
      if (round.type === 'assessment' && !round.assessmentId) {
        errors.push(`Round ${idx + 1}: assessmentId is required for assessment rounds`);
      }
    });
  }

  if (errors.length > 0) {
    throw new HttpError(400, "Validation failed", { errors });
  }
}

async function loadDriveForStaff(driveId, user) {
  assertStaff(user);
  const drive = await drivesRepo.findById(driveId, collegeScopeFor(user));
  if (!drive) throw new HttpError(404, "Drive not found");
  return drive;
}

export async function enrollStudents(driveId, studentIds, user) {
  const drive = await loadDriveForStaff(driveId, user);
  if (!Array.isArray(studentIds) || studentIds.length === 0) {
    throw new HttpError(400, "studentIds must be a non-empty array");
  }

  const studentFilter = { _id: { $in: studentIds }, role: 'student' };
  if (drive.collegeId) studentFilter.collegeId = drive.collegeId;
  const validStudents = await User.find(studentFilter).select('_id');
  const validIds = validStudents.map((s) => String(s._id));

  const alreadyEnrolled = await candidatesRepo.existingStudentIds(driveId, validIds);
  const toEnroll = validIds.filter((id) => !alreadyEnrolled.has(id));

  const docs = toEnroll.map((studentId) => ({
    driveId,
    studentId,
    collegeId: drive.collegeId,
    status: 'Applied',
    currentRoundIndex: 0
  }));

  const created = await candidatesRepo.insertMany(docs);

  return {
    enrolled: created.length,
    skipped: studentIds.length - created.length
  };
}

export async function enrollEligible(driveId, user) {
  const drive = await loadDriveForStaff(driveId, user);

  const studentFilter = { role: 'student' };
  if (drive.collegeId) studentFilter.collegeId = drive.collegeId;
  const sections = drive.eligibility?.sections;
  if (Array.isArray(sections) && sections.length > 0) {
    studentFilter.section = { $in: sections };
  }

  const students = await User.find(studentFilter).select('_id');
  return enrollStudents(driveId, students.map((s) => String(s._id)), user);
}

export async function listCandidates(driveId, user, query = {}) {
  assertStaff(user);
  await loadDriveForStaff(driveId, user);

  const filter = { driveId };
  if (query.status) filter.status = query.status;

  return candidatesRepo.findAll(filter);
}

export async function getMyCandidacy(driveId, userId) {
  return candidatesRepo.findOne({ driveId, studentId: userId });
}

async function loadCandidateForStaff(candidateId, user) {
  assertStaff(user);
  const candidate = await candidatesRepo.findById(candidateId, collegeScopeFor(user));
  if (!candidate) throw new HttpError(404, "Candidate not found");
  return candidate;
}

const TERMINAL_STATUSES = ['Selected', 'Rejected', 'Withdrawn'];

export async function recordRoundResult(candidateId, result, notes, link, user) {
  const candidate = await loadCandidateForStaff(candidateId, user);

  if (!['Pass', 'Fail'].includes(result)) {
    throw new HttpError(400, "result must be 'Pass' or 'Fail'");
  }
  if (!['Applied', 'InProgress'].includes(candidate.status)) {
    throw new HttpError(409, `Candidate is ${candidate.status} and has no active round to record a result for`);
  }

  const historyEntry = {
    roundIndex: candidate.currentRoundIndex,
    result,
    notes,
    link,
    recordedAt: new Date(),
    recordedBy: user._id
  };

  const update = {
    status: result === 'Pass' ? 'RoundPassed' : 'RoundFailed',
    $push: { roundHistory: historyEntry }
  };

  return candidatesRepo.updateById(candidateId, update, collegeScopeFor(user));
}

export async function advanceRound(candidateId, user) {
  const candidate = await loadCandidateForStaff(candidateId, user);
  const drive = await drivesRepo.findById(candidate.driveId, collegeScopeFor(user));
  if (!drive) throw new HttpError(404, "Drive not found");

  if (candidate.status !== 'RoundPassed') {
    throw new HttpError(409, `Candidate must have passed the current round before advancing (currently ${candidate.status})`);
  }

  const isFinalRound = candidate.currentRoundIndex >= drive.rounds.length - 1;
  const update = isFinalRound
    ? { status: 'Selected' }
    : { status: 'InProgress', currentRoundIndex: candidate.currentRoundIndex + 1 };

  return candidatesRepo.updateById(candidateId, update, collegeScopeFor(user));
}

export async function rejectCandidate(candidateId, reason, user) {
  const candidate = await loadCandidateForStaff(candidateId, user);
  if (TERMINAL_STATUSES.includes(candidate.status)) {
    throw new HttpError(409, `Candidate is already ${candidate.status}`);
  }

  const update = {
    status: 'Rejected',
    $push: {
      roundHistory: {
        roundIndex: candidate.currentRoundIndex,
        result: 'Fail',
        notes: reason || 'Rejected by placement cell',
        recordedAt: new Date(),
        recordedBy: user._id
      }
    }
  };
  return candidatesRepo.updateById(candidateId, update, collegeScopeFor(user));
}

export async function withdrawCandidate(candidateId, user) {
  const candidate = await candidatesRepo.findById(candidateId, collegeScopeFor(user));
  if (!candidate) throw new HttpError(404, "Candidate not found");

  const studentId = candidate.studentId._id || candidate.studentId;
  if (user.role === 'student' && String(studentId) !== String(user._id)) {
    throw new HttpError(403, "Forbidden");
  }

  if (TERMINAL_STATUSES.includes(candidate.status)) {
    throw new HttpError(409, `Candidate is already ${candidate.status}`);
  }

  return candidatesRepo.updateById(candidateId, { status: 'Withdrawn' }, collegeScopeFor(user));
}
