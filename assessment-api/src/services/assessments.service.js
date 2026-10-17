import * as assessmentsRepo from "../repositories/assessments.repo.js";
import * as attemptsRepo from "../repositories/assessmentAttempts.repo.js";
import Submission from "../../models/Submission.mjs";
import User from "../../models/User.mjs";
import { HttpError } from "../utils/httpError.js";
import * as auditService from "./audit.service.js";

// superadmin operates across colleges; everyone else is scoped to their own.
// Returns undefined/null for "no scoping" (repo layer treats a falsy collegeId as unscoped).
function collegeScopeFor(user) {
  if (!user || user.role === 'superadmin') return undefined;
  return user.collegeId || undefined;
}

export async function listAssessments(query = {}, user) {
  const page = Math.max(1, Number(query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(query.limit || 50)));
  const filter = {};

  // If guest or student, only show Published or Completed assessments
  if (!user || user.role === 'student') {
    filter.status = { $in: ['Published', 'Completed'] };
  }

  const collegeId = collegeScopeFor(user);
  if (collegeId) filter.collegeId = collegeId;

  const options = {
    sort: { startTime: -1 },
    skip: (page - 1) * limit,
    limit: limit
  };

  return assessmentsRepo.findAll(filter, options);
}

export async function getAssessmentById(id, user) {
  const assessment = await assessmentsRepo.findById(id, collegeScopeFor(user));
  if (!assessment) return null;

  // Student can only see if it's not Draft
  if (user.role === 'student' && assessment.status === 'Draft') {
    return null;
  }

  return assessment;
}

export async function getMyAssessmentAttempt(assessmentId, userId) {
  return attemptsRepo.findOne({ assessmentId, studentId: userId });
}

export async function createAssessment(payload, user) {
  validateAssessmentPayload(payload);
  const data = {
    ...payload,
    createdBy: user._id,
    // collegeId always comes from the authenticated user's own token claim, never the
    // request body, so a faculty/admin can't stamp another tenant's id onto their own data.
    collegeId: user.role === 'superadmin' ? (payload.collegeId || undefined) : (user.collegeId || undefined)
  };
  return assessmentsRepo.create(data);
}

export async function updateAssessment(id, payload, user) {
  validateAssessmentPayload(payload);
  const { collegeId, ...safePayload } = payload; // collegeId is immutable post-creation via this path
  const assessment = await assessmentsRepo.updateById(id, safePayload, collegeScopeFor(user));
  if (!assessment) throw new HttpError(404, "Assessment not found");
  return assessment;
}

export async function deleteAssessment(id, user) {
  const assessment = await assessmentsRepo.deleteById(id, collegeScopeFor(user));
  if (!assessment) throw new HttpError(404, "Assessment not found");
  return assessment;
}

export async function startAssessment(assessmentId, user, auditInfo = {}) {
  const userId = user._id;
  const assessment = await assessmentsRepo.findById(assessmentId, collegeScopeFor(user));
  if (!assessment) throw new HttpError(404, "Assessment not found");
  if (assessment.status !== 'Published') throw new HttpError(400, "Assessment is not active");
  if (assessment.locked) throw new HttpError(409, "Assessment is locked by the faculty");

  const now = new Date();
  if (now < assessment.startTime) throw new HttpError(400, "Assessment has not started yet");
  if (now > assessment.endTime) throw new HttpError(400, "Assessment has already ended");

  // Check if already started
  let attempt = await attemptsRepo.findOne({ assessmentId, studentId: userId });
  if (attempt) return attempt;

  // Shuffle problem order for anti-cheating
  const problemIds = assessment.problems.map(p => p.problemId._id || p.problemId);
  const shuffledOrder = [...problemIds].sort(() => Math.random() - 0.5);

  try {
    attempt = await attemptsRepo.create({
      assessmentId,
      studentId: userId,
      collegeId: assessment.collegeId || user.collegeId || undefined,
      startedAt: now,
      status: 'Active',
      problemOrder: shuffledOrder,
      timeline: [{ event: 'START', timestamp: now }]
    });
  } catch (error) {
    // The unique attempt index makes concurrent start requests idempotent.
    if (error?.code === 11000) {
      return attemptsRepo.findOne({ assessmentId, studentId: userId });
    }
    throw error;
  }

  await auditService.logEvent({
    event: "ASSESSMENT_STARTED",
    userId,
    collegeId: attempt.collegeId || undefined,
    details: { assessmentId, attemptId: attempt._id },
    ...auditInfo
  });

  return attempt;
}

export async function logAntiCheatingEvent(attemptId, eventType, user) {
  const attempt = await attemptsRepo.findById(attemptId, collegeScopeFor(user));
  if (!attempt) throw new HttpError(404, "Attempt not found");

  const studentId = attempt.studentId._id || attempt.studentId;
  if (String(studentId) !== String(user._id)) {
    throw new HttpError(403, "Forbidden");
  }

  if (attempt.status !== 'Active') return attempt;

  const update = {
    $push: {
      timeline: {
        event: eventType,
        timestamp: new Date()
      }
    }
  };
  switch (eventType) {
    case 'TAB_SWITCH':
      update.$inc = { tabSwitchCount: 1 };
      break;
    case 'COPY':
      update.$inc = { copyCount: 1 };
      break;
    case 'PASTE':
      update.$inc = { pasteCount: 1 };
      break;
    case 'FULLSCREEN_EXIT':
      update.$inc = { fullscreenExitCount: 1 };
      break;
    case 'RETURN':
      // Just logged in the timeline, no counters incremented
      break;
    default:
      throw new HttpError(400, "Invalid event type");
  }

  return attemptsRepo.updateById(attemptId, update);
}

export async function getAssessmentAttemptById(attemptId, user) {
  const attempt = await attemptsRepo.findById(attemptId, collegeScopeFor(user));
  if (!attempt) return null;

  const assessment = await assessmentsRepo.findById(attempt.assessmentId, collegeScopeFor(user));
  if (!assessment) return null;

  // Auto-timeout check
  if (attempt.status === 'Active' && isAttemptExpired(attempt, assessment)) {
    await attemptsRepo.updateById(attemptId, { status: 'TimedOut', submittedAt: getExpirationTime(attempt, assessment) });
    attempt.status = 'TimedOut';
    attempt.submittedAt = getExpirationTime(attempt, assessment);
  }

  await recalculateAttemptScore(attemptId);
  
  // Re-fetch after score update and status change
  const finalAttempt = await attemptsRepo.findById(attemptId);

  // Check permission
  const studentId = finalAttempt.studentId._id || finalAttempt.studentId;
  if (user.role === 'student' && String(studentId) !== String(user._id)) {
    throw new HttpError(403, "Forbidden");
  }

  // Reorder assessment problems based on attempt's problemOrder
  if (finalAttempt.problemOrder && finalAttempt.problemOrder.length > 0) {
    const orderMap = new Map();
    finalAttempt.problemOrder.forEach((id, index) => orderMap.set(String(id), index));
    
    // Create a lean copy of assessment and sort problems
    const assessmentObj = assessment.toObject ? assessment.toObject() : assessment;
    assessmentObj.problems.sort((a, b) => {
      const idxA = orderMap.get(String(a.problemId._id || a.problemId)) ?? 999;
      const idxB = orderMap.get(String(b.problemId._id || b.problemId)) ?? 999;
      return idxA - idxB;
    });
    finalAttempt.assessmentId = assessmentObj;
  }

  return finalAttempt;
}

export async function recalculateAttemptScore(attemptId) {
  const attempt = await attemptsRepo.findById(attemptId);
  if (!attempt) return;

  const assessment = await assessmentsRepo.findById(attempt.assessmentId);
  if (!assessment) return;

  // Find every submission that actually earns points: 'Success' covers both coding
  // and mcq (both resolve synchronously/asynchronously to a binary pass/fail);
  // 'Graded' is a manually-scored subjective answer (see
  // submissions.service.js's gradeSubjectiveSubmission) and carries real partial
  // credit in its own score field instead of an all-or-nothing maxScore.
  const submissions = await Submission.find({
    attemptId: attempt._id,
    status: { $in: ['Success', 'Graded'] }
  });

  // Last submission per problem wins (matches the pre-existing binary behavior,
  // which only ever needed set-membership since Submission has no other status that
  // implies "this is the graded answer" — Graded is now the only exception).
  const byProblemId = new Map();
  for (const s of submissions) {
    byProblemId.set(String(s.problemId), s);
  }

  let totalScore = 0;
  for (const p of assessment.problems) {
    const pId = String(p.problemId._id || p.problemId);
    const submission = byProblemId.get(pId);
    if (!submission) continue;

    if (submission.status === 'Graded') {
      totalScore += Math.min(submission.score || 0, p.maxScore);
    } else {
      totalScore += p.maxScore;
    }
  }

  if (attempt.score !== totalScore) {
    await attemptsRepo.updateById(attemptId, { score: totalScore });
  }
}

export async function listAssessmentAttempts(assessmentId, user, query = {}) {
  const page = Math.max(1, Number(query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(query.limit || 50)));
  // Only faculty/admin can list all attempts for an assessment
  if (user.role === 'student') {
    throw new HttpError(403, "Forbidden");
  }

  const options = {
    sort: { startedAt: -1 },
    skip: (page - 1) * limit,
    limit: limit
  };

  // Scoped by the attempt's own collegeId rather than pre-checking the assessment's
  // existence, so this keeps returning [] (not a 404) for an out-of-scope/unknown
  // assessmentId — the integration /results/:_id contract already relies on that shape.
  const filter = { assessmentId };
  const collegeId = collegeScopeFor(user);
  if (collegeId) filter.collegeId = collegeId;

  return attemptsRepo.findAll(filter, options);
}

export async function getAssessmentAttendance(assessmentId, user) {
  // Only faculty/admin can see attendance
  if (user.role === 'student') {
    throw new HttpError(403, "Forbidden");
  }

  const assessment = await assessmentsRepo.findById(assessmentId, collegeScopeFor(user));
  if (!assessment) throw new HttpError(404, "Assessment not found");

  // Get all students in the same college as the assessment (falls back to every student
  // only for legacy/superadmin-created data with no collegeId yet).
  const studentFilter = { role: 'student' };
  if (assessment.collegeId) studentFilter.collegeId = assessment.collegeId;
  const students = await User.find(studentFilter).select('name email usn section');

  // Get all attempts for this assessment
  const attempts = await attemptsRepo.findAll({ assessmentId });

  // Map students to status
  const attendance = students.map(student => {
    const attempt = attempts.find(a => String(a.studentId._id || a.studentId) === String(student._id));
    return {
      studentId: student._id,
      name: student.name,
      email: student.email,
      usn: student.usn || '',
      section: student.section || '',
      status: attempt ? attempt.status : 'Not Started',
      attemptId: attempt ? attempt._id : null,
      score: attempt ? attempt.score : 0,
      startedAt: attempt ? attempt.startedAt : null,
      submittedAt: attempt ? attempt.submittedAt : null,
      tabSwitchCount: attempt ? (attempt.tabSwitchCount || 0) : 0,
      copyCount: attempt ? (attempt.copyCount || 0) : 0,
      pasteCount: attempt ? (attempt.pasteCount || 0) : 0,
      fullscreenExitCount: attempt ? (attempt.fullscreenExitCount || 0) : 0,
      challenge: attempt && attempt.challenge ? attempt.challenge : { status: 'None' }
    };
  });

  return attendance;
}

export async function submitAssessment(attemptId, user, auditInfo = {}) {
  const attempt = await attemptsRepo.findById(attemptId, collegeScopeFor(user));
  if (!attempt) throw new HttpError(404, "Attempt not found");

  const assessment = await assessmentsRepo.findById(attempt.assessmentId, collegeScopeFor(user));
  if (!assessment) throw new HttpError(404, "Assessment not found");

  // Permission check
  const studentId = attempt.studentId._id || attempt.studentId;
  if (user.role === 'student' && String(studentId) !== String(user._id)) {
    throw new HttpError(403, "Forbidden");
  }

  if (attempt.status !== 'Active') {
    return attempt; // Already submitted or timed out
  }

  // Check for timeout
  if (isAttemptExpired(attempt, assessment)) {
    await recalculateAttemptScore(attemptId);
    const result = await attemptsRepo.updateById(attemptId, {
      status: 'TimedOut',
      submittedAt: getExpirationTime(attempt, assessment),
      $push: {
        timeline: {
          event: 'TIMED_OUT',
          timestamp: getExpirationTime(attempt, assessment)
        }
      }
    });

    await auditService.logEvent({
      event: "ASSESSMENT_TIMEOUT",
      userId: user._id,
      collegeId: attempt.collegeId || undefined,
      details: { attemptId, assessmentId: attempt.assessmentId },
      ...auditInfo
    });

    return result;
  }

  await recalculateAttemptScore(attemptId);
  
  const result = await attemptsRepo.updateById(attemptId, {
    status: 'Submitted',
    submittedAt: new Date(),
    $push: {
      timeline: {
        event: 'SUBMIT',
        timestamp: new Date()
      }
    }
  });

  await auditService.logEvent({
    event: "ASSESSMENT_SUBMITTED",
    userId: user._id,
    collegeId: attempt.collegeId || undefined,
    details: { attemptId, assessmentId: attempt.assessmentId, score: result.score },
    ...auditInfo
  });

  return result;
}

function isAttemptExpired(attempt, assessment) {
  const now = new Date();
  const expirationTime = getExpirationTime(attempt, assessment);
  return now > expirationTime;
}

function getExpirationTime(attempt, assessment) {
  const startTime = new Date(attempt.startedAt);
  const graceMs = (attempt.graceMinutes || 0) * 60000;
  const durationMs = (assessment.durationMinutes * 60000) + graceMs;
  const relativeExpiry = new Date(startTime.getTime() + durationMs);
  const absoluteExpiry = new Date(new Date(assessment.endTime).getTime() + graceMs);
  
  // Expiry is whichever comes first
  return relativeExpiry < absoluteExpiry ? relativeExpiry : absoluteExpiry;
}

export async function getAttemptSubmissions(attemptId, user, query = {}) {
  const page = Math.max(1, Number(query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(query.limit || 50)));

  const attempt = await attemptsRepo.findById(attemptId, collegeScopeFor(user));
  if (!attempt) throw new HttpError(404, "Attempt not found");

  // Permission check: Faculty/Admin or the Student who owns the attempt
  const studentId = attempt.studentId._id || attempt.studentId;
  if (user.role === 'student' && String(studentId) !== String(user._id)) {
    throw new HttpError(403, "Forbidden");
  }

  return Submission.find({ attemptId })
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .populate('problemId', 'title problemType options maxWords rubricNotes');
}

function validateAssessmentPayload(payload) {
  const errors = [];
  if (!payload.title) errors.push("Title is required");
  if (!payload.startTime) errors.push("Start time is required");
  if (!payload.endTime) errors.push("End time is required");
  if (!Number.isFinite(Number(payload.durationMinutes)) || Number(payload.durationMinutes) <= 0) {
    errors.push("Duration must be greater than zero");
  }
  if (payload.startTime && payload.endTime && new Date(payload.startTime) >= new Date(payload.endTime)) {
    errors.push("End time must be after start time");
  }
  if (!Array.isArray(payload.problems) || payload.problems.length === 0) {
    errors.push("At least one problem is required");
  } else {
    const problemIds = payload.problems.map((problem) => String(problem.problemId));
    if (new Set(problemIds).size !== problemIds.length) {
      errors.push("An assessment cannot contain duplicate problems");
    }
    if (payload.problems.some((problem) => problem.maxScore !== undefined
      && (!Number.isFinite(Number(problem.maxScore)) || Number(problem.maxScore) <= 0))) {
      errors.push("Every problem max score must be greater than zero");
    }
  }

  if (errors.length > 0) {
    throw new HttpError(400, "Validation failed", { errors });
  }
}

export async function getAnnouncements(assessmentId, user) {
  const assessment = await assessmentsRepo.findById(assessmentId, collegeScopeFor(user));
  if (!assessment) throw new HttpError(404, "Assessment not found");
  return assessment.announcements || [];
}

export async function createAnnouncement(assessmentId, message, user) {
  if (!message || typeof message !== 'string' || message.trim() === '') {
    throw new HttpError(400, "Message must be a non-empty string");
  }
  const assessment = await assessmentsRepo.findById(assessmentId, collegeScopeFor(user));
  if (!assessment) throw new HttpError(404, "Assessment not found");

  const announcement = {
    message: message.trim(),
    sentAt: new Date()
  };

  await assessmentsRepo.updateById(assessmentId, {
    $push: { announcements: announcement }
  }, collegeScopeFor(user));

  return announcement;
}

export async function getAssessmentAnalytics(assessmentId, user) {
  // Only faculty/admin can see analytics
  if (user.role === 'student') {
    throw new HttpError(403, "Forbidden");
  }

  const assessment = await assessmentsRepo.findById(assessmentId, collegeScopeFor(user));
  if (!assessment) throw new HttpError(404, "Assessment not found");

  const studentFilter = { role: 'student' };
  if (assessment.collegeId) studentFilter.collegeId = assessment.collegeId;
  const students = await User.find(studentFilter).select('name email usn section');
  const attempts = await attemptsRepo.findAll({ assessmentId });
  const submissions = await Submission.find({ assessmentId });

  const maxPossibleScore = assessment.problems?.reduce((sum, p) => sum + (p.maxScore || 100), 0) || 100;
  const completedAttempts = attempts.filter(a => a.status === 'Submitted' || a.status === 'TimedOut');

  let avgScore = 0;
  let highestScore = 0;
  let lowestScore = 0;
  let passRate = 0;

  if (completedAttempts.length > 0) {
    const scores = completedAttempts.map(a => a.score || 0);
    avgScore = Number((scores.reduce((a, b) => a + b, 0) / completedAttempts.length).toFixed(1));
    highestScore = Math.max(...scores);
    lowestScore = Math.min(...scores);
    const passedCount = completedAttempts.filter(a => (a.score || 0) >= (maxPossibleScore * 0.4)).length;
    passRate = Number(((passedCount / completedAttempts.length) * 100).toFixed(0));
  }

  const overallStats = {
    totalStudents: students.length,
    startedCount: attempts.filter(a => a.status !== 'Not Started').length,
    submittedCount: completedAttempts.length,
    activeCount: attempts.filter(a => a.status === 'Active').length,
    avgScore,
    highestScore,
    lowestScore,
    passRate,
    maxPossibleScore
  };

  // Section-wise reports
  const sectionStats = {};
  attempts.forEach(attempt => {
    const student = attempt.studentId;
    if (!student) return;
    const sec = student.section || 'Unassigned';
    if (!sectionStats[sec]) {
      sectionStats[sec] = {
        section: sec,
        total: 0,
        started: 0,
        submitted: 0,
        scores: [],
        passedCount: 0
      };
    }
    sectionStats[sec].total++;
    if (attempt.status !== 'Not Started') {
      sectionStats[sec].started++;
    }
    if (attempt.status === 'Submitted' || attempt.status === 'TimedOut') {
      sectionStats[sec].submitted++;
      sectionStats[sec].scores.push(attempt.score || 0);
      if ((attempt.score || 0) >= (maxPossibleScore * 0.4)) {
        sectionStats[sec].passedCount++;
      }
    }
  });

  // Include registered student users who haven't started yet!
  students.forEach(student => {
    const sec = student.section || 'Unassigned';
    const hasAttempt = attempts.some(a => String(a.studentId?._id || a.studentId) === String(student._id));
    if (!hasAttempt) {
      if (!sectionStats[sec]) {
        sectionStats[sec] = {
          section: sec,
          total: 0,
          started: 0,
          submitted: 0,
          scores: [],
          passedCount: 0
        };
      }
      sectionStats[sec].total++;
    }
  });

  const sectionReports = Object.values(sectionStats).map(sec => {
    const avgScore = sec.scores.length > 0 ? (sec.scores.reduce((a, b) => a + b, 0) / sec.scores.length).toFixed(1) : 0;
    const passRate = sec.submitted > 0 ? ((sec.passedCount / sec.submitted) * 100).toFixed(0) : 0;
    return {
      section: sec.section,
      total: sec.total,
      started: sec.started,
      submitted: sec.submitted,
      avgScore: Number(avgScore),
      passRate: Number(passRate)
    };
  });

  // Question Analytics
  const questionReports = assessment.problems.map(p => {
    const pId = String(p.problemId._id || p.problemId);
    const title = p.problemId.title || 'Unknown';
    const difficulty = p.problemId.difficulty || 'Medium';
    const maxScore = p.maxScore || 100;

    const pSubmissions = submissions.filter(s => String(s.problemId) === pId);

    const attemptedStudents = new Set(pSubmissions.map(s => String(s.userId)));
    const attemptCount = attemptedStudents.size;

    const solvedStudents = new Set(
      pSubmissions.filter(s => s.status === 'Success').map(s => String(s.userId))
    );
    const solvedCount = solvedStudents.size;
    const solvedRate = attemptCount > 0 ? Number(((solvedCount / attemptCount) * 100).toFixed(0)) : 0;
    const overallSolvedRate = completedAttempts.length > 0 ? Number(((solvedCount / completedAttempts.length) * 100).toFixed(0)) : 0;

    return {
      problemId: pId,
      title,
      difficulty,
      maxScore,
      attemptCount,
      solvedCount,
      solvedRate,
      overallSolvedRate
    };
  });

  return {
    assessment: {
      _id: assessment._id,
      title: assessment.title,
      startTime: assessment.startTime,
      endTime: assessment.endTime
    },
    overallStats,
    sectionReports,
    questionReports
  };
}

export async function saveDraft(attemptId, codeDrafts, user) {
  const attempt = await attemptsRepo.findById(attemptId, collegeScopeFor(user));
  if (!attempt) throw new HttpError(404, "Attempt not found");

  if (attempt.status !== 'Active') {
    throw new HttpError(409, `Attempt is ${attempt.status.toLowerCase()} and cannot save draft`);
  }

  // Permission check: student owner or admin/faculty
  const studentId = attempt.studentId._id || attempt.studentId;
  if (user.role === 'student' && String(studentId) !== String(user._id)) {
    throw new HttpError(403, "Forbidden");
  }

  return attemptsRepo.updateById(attemptId, { codeDrafts });
}

export async function lockAssessment(assessmentId, user) {
  if (user.role === 'student') {
    throw new HttpError(403, "Forbidden");
  }
  const assessment = await assessmentsRepo.updateById(assessmentId, { locked: true }, collegeScopeFor(user));
  if (!assessment) throw new HttpError(404, "Assessment not found");

  return assessment;
}

export async function unlockAssessment(assessmentId, user) {
  if (user.role === 'student') {
    throw new HttpError(403, "Forbidden");
  }
  const assessment = await assessmentsRepo.updateById(assessmentId, { locked: false }, collegeScopeFor(user));
  if (!assessment) throw new HttpError(404, "Assessment not found");

  return assessment;
}

export async function addGraceTime(attemptId, graceMinutes, user) {
  if (user.role === 'student') {
    throw new HttpError(403, "Forbidden");
  }
  const attempt = await attemptsRepo.findById(attemptId, collegeScopeFor(user));
  if (!attempt) throw new HttpError(404, "Attempt not found");

  const newGraceMinutes = (attempt.graceMinutes || 0) + Number(graceMinutes);
  
  // Log event in timeline
  const timelineEvent = {
    event: 'GRACE_TIME_ADDED',
    timestamp: new Date(),
    details: { addedMinutes: Number(graceMinutes), totalGraceMinutes: newGraceMinutes }
  };

  const updateFields = { 
    graceMinutes: newGraceMinutes,
    $push: { timeline: timelineEvent }
  };

  // Re-activate if timed out
  if (attempt.status === 'TimedOut') {
    updateFields.status = 'Active';
    updateFields.submittedAt = null;
  }

  return attemptsRepo.updateById(attemptId, updateFields);
}

export async function raiseChallenge(attemptId, reason, user) {
  const attempt = await attemptsRepo.findById(attemptId);
  if (!attempt) throw new HttpError(404, "Attempt not found");

  const studentId = attempt.studentId._id || attempt.studentId;
  if (String(studentId) !== String(user._id)) {
    throw new HttpError(403, "Forbidden");
  }

  if (attempt.status === 'Active') {
    throw new HttpError(400, "Cannot challenge an active assessment attempt");
  }

  if (attempt.challenge && attempt.challenge.status !== 'None') {
    throw new HttpError(409, "A challenge has already been raised for this attempt");
  }

  const updateFields = {
    'challenge.status': 'Raised',
    'challenge.reason': reason,
    'challenge.raisedAt': new Date(),
    'challenge.facultyComment': '',
    $push: {
      timeline: {
        event: 'CHALLENGE_RAISED',
        timestamp: new Date(),
        details: { reason }
      }
    }
  };

  return attemptsRepo.updateById(attemptId, updateFields);
}

export async function resolveChallenge(attemptId, status, facultyComment, user) {
  const attempt = await attemptsRepo.findById(attemptId, collegeScopeFor(user));
  if (!attempt) throw new HttpError(404, "Attempt not found");

  if (!attempt.challenge || attempt.challenge.status !== 'Raised') {
    throw new HttpError(400, "No active challenge found to resolve");
  }

  if (!['Accepted', 'Rejected'].includes(status)) {
    throw new HttpError(400, "Invalid status. Must be Accepted or Rejected");
  }

  const updateFields = {
    'challenge.status': status,
    'challenge.facultyComment': facultyComment || '',
    'challenge.resolvedAt': new Date(),
    $push: {
      timeline: {
        event: `CHALLENGE_${status.toUpperCase()}`,
        timestamp: new Date(),
        details: { facultyComment }
      }
    }
  };

  return attemptsRepo.updateById(attemptId, updateFields);
}

