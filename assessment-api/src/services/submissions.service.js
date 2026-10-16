import * as submissionsRepo from "../repositories/submissions.repo.js";
import * as problemsRepo from "../repositories/problems.repo.js";
import * as attemptsRepo from "../repositories/assessmentAttempts.repo.js";
import * as assessmentsRepo from "../repositories/assessments.repo.js";
import { publishSubmissionMessage } from "./evaluation.service.js";
import { recalculateAttemptScore } from "./assessments.service.js";
import { getCacheJSON, setCacheJSON } from "./cache.service.js";
import { checkCollegeSubmissionQuota, checkStudentSubmissionQuota } from "./quota.service.js";
import { checkPlanUsageLimit, collegeAllowsPremium } from "./billing.service.js";
import { HttpError } from "../utils/httpError.js";

function validateSubmissionMessage(msg) {
  if (!msg || typeof msg !== "object") return false;
  if (!msg.submissionId || !msg.problemId || !msg.language || !msg.code) return false;
  // functionName is only required for the named-function problem model — stdin
  // problems have no wrapper/function to name. Mirrors the same conditional check
  // on the Go side (pkg/models/submission_message.go), see PLAN.md §3.7.
  if (msg.problemType !== "stdin" && !msg.functionName) return false;
  if (msg.tests && !Array.isArray(msg.tests)) return false;
  if (Array.isArray(msg.tests)) {
    for (const t of msg.tests) {
      if (typeof t !== "object") return false;
      if (!("inputs" in t) || !("expected" in t)) return false;
    }
  }
  return true;
}

// Shared by submitSolution/rejudge* below so problemType-aware envelope logic
// lives in exactly one place — see PLAN.md §3.7 (the one real shared-code touch
// point between the two problem models).
function buildJudgeTests(problem) {
  return problem.testCases.map((tc) => ({
    inputs: tc.inputs,
    expected: tc.expected,
    isHidden: !isSampleTestCase(tc),
    isSample: isSampleTestCase(tc)
  }));
}

function buildJudgeMessageBody({ submissionId, problem, language, code, requestId }) {
  const problemType = problem.problemType || "function";
  const body = {
    schemaVersion: "v2",
    submissionId,
    problemId: problem._id.toString(),
    language,
    code,
    tests: buildJudgeTests(problem),
    problemType,
    compareMode: problem.compareConfig?.mode || "EXACT",
    requestId: requestId || undefined
  };
  if (problemType !== "stdin") {
    body.functionName = problem.functionName || "solution";
  }
  return body;
}

function canAccessSubmission(submission, { userId, role, collegeId }) {
  if (!submission || !userId) return false;
  if (role === "superadmin") return true;
  if (role === "admin" || role === "faculty") {
    // Legacy submissions from before collegeId was stamped stay visible during the
    // migration window; once backfilled this always requires a same-college match.
    if (!submission.collegeId) return true;
    return String(submission.collegeId) === String(collegeId);
  }
  return String(submission.userId) === String(userId);
}

function isPrivilegedRole(role) {
  return role === "admin" || role === "faculty" || role === "superadmin";
}

export function isSampleTestCase(tc = {}) {
  if (typeof tc.isSample === "boolean") return tc.isSample;
  // If isSample is not explicitly set, we rely on isHidden.
  // A test case is a sample if it's NOT hidden.
  if (typeof tc.isHidden === "boolean") return !tc.isHidden;
  // Default to false for safety: if we don't know, it's hidden.
  return false;
}

function getAttemptExpiration(attempt, assessment) {
  const graceMs = (attempt.graceMinutes || 0) * 60 * 1000;
  const durationExpiry = new Date(attempt.startedAt).getTime() + (assessment.durationMinutes * 60 * 1000) + graceMs;
  return new Date(Math.min(durationExpiry, new Date(assessment.endTime).getTime() + graceMs));
}

async function validateAssessmentSubmission({ problemId, language, userId, assessmentId, attemptId }) {
  if (!assessmentId && !attemptId) return;

  if (!assessmentId || !attemptId) {
    throw new HttpError(400, "Assessment submissions require both assessmentId and attemptId");
  }

  const attempt = await attemptsRepo.findById(attemptId);
  if (!attempt) throw new HttpError(404, "Attempt not found");

  const studentId = attempt.studentId?._id || attempt.studentId;
  if (String(studentId) !== String(userId)) {
    throw new HttpError(403, "Forbidden: You do not own this attempt");
  }

  const attemptAssessmentId = attempt.assessmentId?._id || attempt.assessmentId;
  if (String(attemptAssessmentId) !== String(assessmentId)) {
    throw new HttpError(400, "Attempt does not belong to this assessment");
  }

  const assessment = await assessmentsRepo.findById(assessmentId);
  if (!assessment) throw new HttpError(404, "Assessment not found");

  if (assessment.locked) {
    throw new HttpError(409, "Assessment is locked by the faculty and no longer accepts submissions");
  }

  if (attempt.status !== "Active") {
    throw new HttpError(409, `Attempt is ${attempt.status.toLowerCase()} and no longer accepts submissions`);
  }

  const expiration = getAttemptExpiration(attempt, assessment);
  if (Date.now() >= expiration.getTime()) {
    await attemptsRepo.updateById(attemptId, { status: "TimedOut", submittedAt: expiration });
    throw new HttpError(409, "Attempt has timed out and no longer accepts submissions");
  }

  const includesProblem = assessment.problems.some((entry) => {
    const assessmentProblemId = entry.problemId?._id || entry.problemId;
    return String(assessmentProblemId) === String(problemId);
  });
  if (!includesProblem) {
    throw new HttpError(400, "Problem is not part of this assessment");
  }

  if (assessment.allowedLanguages?.length > 0 && !assessment.allowedLanguages.includes(language)) {
    throw new HttpError(400, "Language is not allowed for this assessment");
  }
}

// Shared by the coding/mcq/subjective submit paths below so the attempt-timeline
// audit log (see AssessmentAttempt.timeline, "Anti-cheating tracking" comment) covers
// every problem type uniformly, not just coding submissions.
async function logSubmitProblemEvent(attemptId, problem, submission) {
  if (!attemptId) return;
  try {
    await attemptsRepo.updateById(attemptId, {
      $push: {
        timeline: {
          event: 'SUBMIT_PROBLEM',
          timestamp: new Date(),
          details: {
            problemId: problem._id,
            problemTitle: problem ? problem.title : 'Unknown Problem',
            submissionId: submission._id
          }
        }
      }
    });
  } catch (err) {
    console.error("Failed to log submission event to attempt timeline:", err);
  }
}

function baseSubmissionFields({ problem, userId, collegeId, assessmentId, attemptId, externalStudentId, externalAssessmentId }) {
  const data = { problemId: problem._id, userId };
  if (collegeId) data.collegeId = collegeId;
  if (assessmentId) data.assessmentId = assessmentId;
  if (attemptId) data.attemptId = attemptId;
  if (externalStudentId) data.externalStudentId = externalStudentId;
  if (externalAssessmentId) data.externalAssessmentId = externalAssessmentId;
  return data;
}

// Correct iff the submitted selection set exactly equals the set of isCorrect option
// indexes — a single wrong or missing pick on a multi-select MCQ fails the whole
// question, same all-or-nothing shape as a coding submission's test cases.
function isMcqSelectionCorrect(problem, selectedOptions) {
  const options = Array.isArray(problem.options) ? problem.options : [];
  const correctIndexes = new Set(
    options.map((o, i) => (o.isCorrect ? i : null)).filter((i) => i !== null)
  );
  const selected = new Set((selectedOptions || []).map(Number));
  return selected.size === correctIndexes.size && [...selected].every((i) => correctIndexes.has(i));
}

async function submitMcqAnswer({ problem, selectedOptions, ...rest }) {
  const options = Array.isArray(problem.options) ? problem.options : [];
  if (!Array.isArray(selectedOptions) || selectedOptions.length === 0) {
    throw new HttpError(400, "selectedOptions is required for MCQ problems");
  }
  if (selectedOptions.some((i) => !Number.isInteger(i) || i < 0 || i >= options.length)) {
    throw new HttpError(400, "selectedOptions contains an invalid option index");
  }
  if (!problem.allowMultipleAnswers && selectedOptions.length > 1) {
    throw new HttpError(400, "Only one option may be selected for this problem");
  }

  const isCorrect = isMcqSelectionCorrect(problem, selectedOptions);
  const submission = await submissionsRepo.create({
    ...baseSubmissionFields({ problem, ...rest }),
    selectedOptions,
    status: isCorrect ? "Success" : "Fail",
    score: isCorrect ? 100 : 0
  });

  await logSubmitProblemEvent(rest.attemptId, problem, submission);
  return { submission };
}

async function submitSubjectiveAnswer({ problem, answerText, ...rest }) {
  if (typeof answerText !== "string" || !answerText.trim()) {
    throw new HttpError(400, "answerText is required for subjective problems");
  }
  if (problem.maxWords) {
    const wordCount = answerText.trim().split(/\s+/).length;
    if (wordCount > problem.maxWords) {
      throw new HttpError(400, `Answer exceeds the ${problem.maxWords}-word limit`, {
        msg: `Answer exceeds the ${problem.maxWords}-word limit (${wordCount} words submitted).`
      });
    }
  }

  // Ungraded until a faculty/admin calls gradeSubjectiveSubmission below — score
  // stays 0 and contributes nothing to the attempt total until then.
  const submission = await submissionsRepo.create({
    ...baseSubmissionFields({ problem, ...rest }),
    answerText,
    status: "PendingReview",
    score: 0
  });

  await logSubmitProblemEvent(rest.attemptId, problem, submission);
  return { submission };
}

function parseOutputJSON(output) {
  if (!output || typeof output !== "string") return null;
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

export function sanitizeResultDetails(details = [], testCases = [], isAssessment = false) {
  return details.map((detail, idx) => {
    const testNum = detail.test ?? detail.Test;
    const testIndexFromPayload = Number.isInteger(testNum) ? testNum - 1 : idx;
    const tc = testCases[testIndexFromPayload];
    const hidden = tc ? !isSampleTestCase(tc) : false;

    if (!hidden) {
      // For sample test cases, ensure all fields are present and correctly named for the frontend.
      // We check for both lowercase and capitalized versions as the judge might return either depending on BSON tags.
      return {
        ...detail,
        inputs: detail.inputs ?? detail.input ?? detail.Input,
        expected: detail.expected ?? detail.Expected,
        output: detail.output ?? detail.Output,
        passed: detail.passed ?? detail.ok ?? detail.Passed ?? detail.Ok ?? false,
        ok: detail.passed ?? detail.ok ?? detail.Passed ?? detail.Ok ?? false,
        stdout: detail.stdout ?? detail.Stdout,
        stderr: detail.stderr ?? detail.Stderr,
        traceback: detail.traceback ?? detail.Traceback,
        timeMs: detail.timeMs ?? detail.TimeMs,
      };
    }

    // For hidden test cases
    const sanitized = {
      test: detail.test ?? detail.Test,
      passed: detail.passed ?? detail.ok ?? detail.Passed ?? detail.Ok ?? false,
      ok: detail.passed ?? detail.ok ?? detail.Passed ?? detail.Ok ?? false,
      isHidden: true,
      timeMs: detail.timeMs ?? detail.TimeMs
    };

    // Requirement: For Practice Problems, show Console Logs. For Assessments, hide them.
    if (!isAssessment) {
      sanitized.stdout = detail.stdout ?? detail.Stdout;
      sanitized.stderr = detail.stderr ?? detail.Stderr;
      sanitized.traceback = detail.traceback ?? detail.Traceback;
    }

    return sanitized;
  });
}

export function sanitizeSubmissionForStudent(submission, problem) {
  if (!submission || !problem || !Array.isArray(problem.testCases)) {
    return submission;
  }

  const normalized = typeof submission.toObject === "function" ? submission.toObject() : { ...submission };
  const isAssessment = !!normalized.assessmentId;
  const parsedOutput = parseOutputJSON(normalized.output);

  if (parsedOutput && Array.isArray(parsedOutput.details)) {
    parsedOutput.details = sanitizeResultDetails(parsedOutput.details, problem.testCases, isAssessment);
    normalized.output = JSON.stringify(parsedOutput);
  }

  if (normalized.testResult && Array.isArray(normalized.testResult.details)) {
    normalized.testResult = {
      ...normalized.testResult,
      details: sanitizeResultDetails(normalized.testResult.details, problem.testCases, isAssessment)
    };
  }

  return normalized;
}

export async function submitSolution({ problemId, code, language, selectedOptions = null, answerText = null, userId, collegeId = null, assessmentId = null, attemptId = null, requestId = null, externalStudentId = null, externalAssessmentId = null, apiClientId = null }) {
  await validateAssessmentSubmission({ problemId, language, userId, assessmentId, attemptId });

  // Checked before any submission record is created so a rejected request never
  // leaves behind an orphan "Pending" submission that nothing will process. Student
  // limit first: a student hitting their own cap gets a specific, actionable message
  // instead of a confusing "your whole college is rate-limited" when it's really just
  // them submitting too fast.
  const studentQuota = await checkStudentSubmissionQuota(userId);
  if (!studentQuota.allowed) {
    throw new HttpError(429, "Submission quota exceeded", {
      msg: `You've submitted too many times in a short period (${studentQuota.limit} per ${studentQuota.windowSeconds}s). Please wait a moment and try again.`
    });
  }

  if (collegeId) {
    const quota = await checkCollegeSubmissionQuota(collegeId);
    if (!quota.allowed) {
      throw new HttpError(429, "Submission quota exceeded", {
        msg: `Submission quota exceeded for this college (${quota.limit} per ${quota.windowSeconds}s). Please try again shortly.`
      });
    }

    // Phase 2 billing hard cap — separate from the fairness quota above (that one
    // throttles bursts within a short window; this one enforces the plan's monthly
    // submission allowance).
    const planUsage = await checkPlanUsageLimit(collegeId);
    if (!planUsage.allowed) {
      throw new HttpError(402, "Plan usage limit exceeded", {
        msg: `This college has used its plan's monthly submission allowance (${planUsage.limit}). Upgrade to continue.`
      });
    }
  }

  const problem = await problemsRepo.findById(problemId);
  if (!problem) {
    return { notFound: true };
  }

  if (problem.isPremium && collegeId && !(await collegeAllowsPremium(collegeId))) {
    throw new HttpError(402, "Upgrade required for premium problems", {
      msg: "This problem is only available on a paid plan."
    });
  }

  const problemType = problem.problemType || "function";
  const passthrough = { userId, collegeId, assessmentId, attemptId, externalStudentId, externalAssessmentId };

  // mcq/subjective never reach judge-service-go — graded (or queued for manual
  // grading) entirely within assessment-api. See submitMcqAnswer/
  // submitSubjectiveAnswer above.
  if (problemType === "mcq") {
    return submitMcqAnswer({ problem, selectedOptions, ...passthrough });
  }
  if (problemType === "subjective") {
    return submitSubjectiveAnswer({ problem, answerText, ...passthrough });
  }

  if (typeof code !== "string" || !code.trim() || typeof language !== "string" || !language.trim()) {
    throw new HttpError(400, "code and language are required for this problem");
  }

  const submissionData = {
    problemId,
    code,
    language,
    userId,
    status: "Pending"
  };

  if (collegeId) submissionData.collegeId = collegeId;
  if (assessmentId) submissionData.assessmentId = assessmentId;
  if (attemptId) submissionData.attemptId = attemptId;
  if (externalStudentId) submissionData.externalStudentId = externalStudentId;
  if (externalAssessmentId) submissionData.externalAssessmentId = externalAssessmentId;
  if (apiClientId) submissionData.apiClientId = apiClientId;

  const submission = await submissionsRepo.create(submissionData);

  await logSubmitProblemEvent(attemptId, problem, submission);

  const messageBody = buildJudgeMessageBody({
    submissionId: submission._id.toString(),
    problem,
    language,
    code,
    requestId
  });

  // Carried through so judge-service-go can tag the usage_events record it writes
  // per submission (H4 metering) without a round-trip lookup of userId -> collegeId.
  if (collegeId) messageBody.collegeId = String(collegeId);
  // Same reason, for per-customer attribution: the judge stamps apiClientId onto the
  // usage event so a submission can be billed to the API key that produced it, with no
  // lookup back into assessment-api (plan Phase 1).
  if (apiClientId) messageBody.apiClientId = String(apiClientId);

  if (!validateSubmissionMessage(messageBody)) {
    throw new HttpError(500, "Invalid submission message", { msg: "Internal server error: invalid submission message" });
  }

  await publishSubmissionMessage(messageBody);

  return { submission };
}

export async function getSubmissionById(id, auth = {}) {
  const cacheKey = `submission:${id}`;
  const cached = await getCacheJSON(cacheKey);
  if (cached) {
    if (!canAccessSubmission(cached, auth)) {
      return { forbidden: true };
    }
    if (!isPrivilegedRole(auth.role)) {
      const problem = await problemsRepo.findById(cached.problemId);
      return { cached: true, submission: sanitizeSubmissionForStudent(cached, problem) };
    }
    return { cached: true, submission: cached };
  }

  const submission = await submissionsRepo.findById(id);
  if (!submission) {
    return { notFound: true };
  }

  if (!canAccessSubmission(submission, auth)) {
    return { forbidden: true };
  }

  if (submission.status === "Success" || submission.status === "Fail") {
    await setCacheJSON(cacheKey, submission, 3600);
  }

  if (!isPrivilegedRole(auth.role)) {
    const problem = await problemsRepo.findById(submission.problemId);
    return { submission: sanitizeSubmissionForStudent(submission, problem) };
  }

  return { submission };
}

export async function getMySubmissions(userId, query = {}) {
  const page = Math.max(1, Number(query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(query.limit || 50)));
  const options = {
    skip: (page - 1) * limit,
    limit: limit
  };
  const submissions = await submissionsRepo.findByUserId(userId, options);
  return { submissions };
}

export async function getMyAnalytics(userId) {
  const submissions = await submissionsRepo.findByUserId(userId, { limit: 1000 }); // Max 1000 for realistic analytics
  
  let totalAttempted = 0;
  let totalSolved = 0;
  const tagStats = {};
  const problemDifficultyStats = { Easy: 0, Medium: 0, Hard: 0 };
  const solvedProblemIds = new Set();

  for (const sub of submissions) {
    const pId = sub.problemId?._id?.toString() || sub.problemId?.toString();
    if (!pId) continue;

    totalAttempted++;
    const isSuccess = sub.status === "Success";
    
    if (isSuccess) {
      solvedProblemIds.add(pId);
    }

    // Using the populated problemId object if available
    if (sub.problemId && typeof sub.problemId === 'object' && sub.problemId.tags) {
      const difficulty = sub.problemId.difficulty || 'Medium';
      // We only count difficulty for solved problems to get "average solved difficulty".
      if (isSuccess) problemDifficultyStats[difficulty]++;

      const tags = sub.problemId.tags || [];
      tags.forEach(tag => {
        if (!tagStats[tag]) {
          tagStats[tag] = { attempted: 0, solved: 0 };
        }
        tagStats[tag].attempted++;
        if (isSuccess) {
          tagStats[tag].solved++;
        }
      });
    } else {
      // If not fully populated, we would need to fetch it, but findByUserId populates 'title'.
      // To get tags and difficulty, we need to modify findByUserId to populate those, or fetch here.
      // Let's fetch the full problem if tags are missing to be safe, but ideally repo is updated.
      const problem = await problemsRepo.findById(pId);
      if (problem) {
        const difficulty = problem.difficulty || 'Medium';
        if (isSuccess) problemDifficultyStats[difficulty]++;
        
        const tags = problem.tags || [];
        tags.forEach(tag => {
          if (!tagStats[tag]) {
            tagStats[tag] = { attempted: 0, solved: 0 };
          }
          tagStats[tag].attempted++;
          if (isSuccess) {
            tagStats[tag].solved++;
          }
        });
      }
    }
  }

  totalSolved = solvedProblemIds.size;

  // Process tag stats into an array
  const tagsArray = Object.keys(tagStats).map(tag => ({
    tag,
    attempted: tagStats[tag].attempted,
    solved: tagStats[tag].solved,
    successRate: Math.round((tagStats[tag].solved / tagStats[tag].attempted) * 100)
  }));

  // Sort by success rate
  tagsArray.sort((a, b) => b.successRate - a.successRate);

  // Strong areas: high success rate, at least 2 attempts
  const strongAreas = tagsArray.filter(t => t.attempted >= 2 && t.successRate >= 70).slice(0, 3);
  
  // Weak areas: low success rate, at least 2 attempts
  const weakAreas = [...tagsArray].reverse().filter(t => t.attempted >= 2 && t.successRate < 50).slice(0, 3);

  // Determine average difficulty
  let avgDiff = "Medium";
  const { Easy, Medium, Hard } = problemDifficultyStats;
  if (Hard > Medium && Hard > Easy) avgDiff = "Hard";
  else if (Easy > Medium && Easy > Hard) avgDiff = "Easy";

  return {
    totalAttempted,
    totalSolved,
    averageDifficulty: avgDiff,
    strongAreas,
    weakAreas,
    tagStats: tagsArray
  };
}

import Submission from "../../models/Submission.mjs";

// superadmin operates across colleges; everyone else is scoped to their own. Mirrors
// assessments.service.js's collegeScopeFor exactly. `user` is optional here so existing
// non-HTTP callers (tests, internal jobs) keep working unscoped — only the admin routes
// pass a real requesting user.
function collegeScopeFor(user) {
  if (!user || user.role === 'superadmin') return undefined;
  return user.collegeId || undefined;
}

export async function rejudgeSubmission(submissionId, user) {
  const submission = await submissionsRepo.findById(submissionId, collegeScopeFor(user));
  if (!submission) {
    throw new HttpError(404, "Submission not found");
  }

  const problem = await problemsRepo.findById(submission.problemId);
  if (!problem) {
    throw new HttpError(404, "Problem not found for this submission");
  }

  // mcq is auto-graded deterministically (nothing for a judge to re-run) and
  // subjective is manually graded (see gradeSubjectiveSubmission) — "rejudge" only
  // makes sense for the two judge-executed problem types.
  const rejudgeType = problem.problemType || "function";
  if (rejudgeType === "mcq" || rejudgeType === "subjective") {
    throw new HttpError(400, `Cannot rejudge a ${rejudgeType} submission — it is not judge-executed`);
  }

  // Reset status, score, output
  submission.status = "Pending";
  submission.score = 0;
  submission.output = undefined;
  submission.testResult = undefined;
  await submission.save();

  const messageBody = buildJudgeMessageBody({
    submissionId: submission._id.toString(),
    problem,
    language: submission.language,
    code: submission.code
  });

  if (!validateSubmissionMessage(messageBody)) {
    throw new HttpError(500, "Invalid submission message configuration");
  }

  await publishSubmissionMessage(messageBody);

  return submission;
}

export async function rejudgeProblemSubmissions(problemId, assessmentId = null, user) {
  const problem = await problemsRepo.findById(problemId);
  if (!problem) {
    throw new HttpError(404, "Problem not found");
  }

  const filter = { problemId };
  if (assessmentId) {
    filter.assessmentId = assessmentId;
  }
  // Problem itself is a shared, unscoped catalog entry (no collegeId), but its
  // submissions are per-college — scope the rejudge to the caller's own college so an
  // admin/faculty can't requeue (and burn judge compute on) another college's attempts.
  const scope = collegeScopeFor(user);
  if (scope) {
    filter.collegeId = scope;
  }

  // Guard mirrors rejudgeSubmission above — never applies to this loop in practice
  // since mcq/subjective problems have no test cases to rejudge against, kept here
  // as a defensive no-op in case that ever changes.
  const rejudgeType = problem.problemType || "function";
  if (rejudgeType === "mcq" || rejudgeType === "subjective") {
    return { count: 0 };
  }

  const submissions = await Submission.find(filter);

  for (const submission of submissions) {
    submission.status = "Pending";
    submission.score = 0;
    submission.output = undefined;
    submission.testResult = undefined;
    await submission.save();

    const messageBody = buildJudgeMessageBody({
      submissionId: submission._id.toString(),
      problem,
      language: submission.language,
      code: submission.code
    });

    await publishSubmissionMessage(messageBody);
  }

  return { count: submissions.length };
}

export async function rejudgeAssessmentSubmissions(assessmentId, user) {
  const assessment = await assessmentsRepo.findById(assessmentId, collegeScopeFor(user));
  if (!assessment) {
    throw new HttpError(404, "Assessment not found");
  }

  const submissions = await Submission.find({ assessmentId });
  const problemsCache = {};

  for (const submission of submissions) {
    const pId = submission.problemId.toString();
    if (!(pId in problemsCache)) {
      problemsCache[pId] = await problemsRepo.findById(pId);
    }

    const problem = problemsCache[pId];
    if (!problem) continue;

    // See rejudgeSubmission's guard above — skip mcq/subjective entries in a mixed
    // assessment, only judge-executed submissions get requeued.
    const rejudgeType = problem.problemType || "function";
    if (rejudgeType === "mcq" || rejudgeType === "subjective") continue;

    submission.status = "Pending";
    submission.score = 0;
    submission.output = undefined;
    submission.testResult = undefined;
    await submission.save();

    const messageBody = buildJudgeMessageBody({
      submissionId: submission._id.toString(),
      problem,
      language: submission.language,
      code: submission.code
    });

    await publishSubmissionMessage(messageBody);
  }

  return { count: submissions.length };
}

function isPrivilegedGrader(role) {
  return role === "admin" || role === "faculty" || role === "superadmin";
}

// Faculty-facing grading queue: every subjective submission in an assessment still
// awaiting manual grading, for the "Grade subjective answers" page.
export async function listUngradedSubjectiveSubmissions(assessmentId, user) {
  if (!isPrivilegedGrader(user?.role)) {
    throw new HttpError(403, "Forbidden");
  }

  const assessment = await assessmentsRepo.findById(assessmentId);
  if (!assessment) {
    throw new HttpError(404, "Assessment not found");
  }
  if (user.role !== "superadmin" && assessment.collegeId && String(assessment.collegeId) !== String(user.collegeId)) {
    throw new HttpError(404, "Assessment not found");
  }

  const submissions = await Submission.find({ assessmentId, status: "PendingReview" })
    .populate("problemId", "title maxWords rubricNotes")
    .populate("userId", "name email usn")
    .sort({ createdAt: 1 });

  return submissions;
}

// Manual grading for a single subjective submission — the only way its status ever
// leaves "PendingReview". Re-grading an already-"Graded" submission is allowed (a
// faculty correction), everything else must go through this once first.
export async function gradeSubjectiveSubmission(submissionId, { score, feedback = "" }, grader) {
  if (!isPrivilegedGrader(grader?.role)) {
    throw new HttpError(403, "Forbidden");
  }

  const submission = await submissionsRepo.findById(submissionId);
  if (!submission) {
    throw new HttpError(404, "Submission not found");
  }
  if (grader.role !== "superadmin" && submission.collegeId && String(submission.collegeId) !== String(grader.collegeId)) {
    throw new HttpError(404, "Submission not found");
  }
  if (submission.status !== "PendingReview" && submission.status !== "Graded") {
    throw new HttpError(409, `Submission is ${submission.status.toLowerCase()} and cannot be graded`);
  }

  const problem = await problemsRepo.findById(submission.problemId);
  if (!problem || (problem.problemType || "function") !== "subjective") {
    throw new HttpError(400, "Submission is not for a subjective problem");
  }

  const numericScore = Number(score);
  if (!Number.isFinite(numericScore) || numericScore < 0) {
    throw new HttpError(400, "score must be a non-negative number");
  }

  // Cap to the problem's configured maxScore within this assessment, when known —
  // a practice-mode (no assessmentId) subjective submission has no assessment
  // problem entry to cap against, so any non-negative score is accepted there.
  if (submission.assessmentId) {
    const assessment = await assessmentsRepo.findById(submission.assessmentId);
    const entry = assessment?.problems?.find(
      (p) => String(p.problemId?._id || p.problemId) === String(submission.problemId)
    );
    if (entry && numericScore > entry.maxScore) {
      throw new HttpError(400, `score cannot exceed this problem's max score of ${entry.maxScore}`);
    }
  }

  const updated = await submissionsRepo.updateById(submissionId, {
    status: "Graded",
    score: numericScore,
    feedback,
    gradedBy: grader._id,
    gradedAt: new Date()
  });

  if (submission.attemptId) {
    await recalculateAttemptScore(submission.attemptId);
  }

  return updated;
}
