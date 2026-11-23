import Assessment from "../../models/Assessment.mjs";
import { HttpError } from "../utils/httpError.js";

// Who may see and change a problem. The catalog is shared between colleges, and each problem
// says how far:
//   public  - every college sees it, uses it in assessments and may edit it. Only the college
//             that added it (or a superadmin) may delete it.
//   private - belongs to the college that added it. Nobody else sees it, submits to it or
//             changes it; to everyone else it does not exist (404).
// A problem with no owning college (added before this, by a superadmin, or synced from
// Arventiq) is public, and only a superadmin may delete it.
// A problem used by an assessment cannot be deleted, so a delete cannot break an exam.

const isSuperadmin = (user) => user?.role === "superadmin";
const sameCollege = (problem, user) =>
  Boolean(problem.collegeId && user?.collegeId) && String(problem.collegeId) === String(user.collegeId);

export function isPrivate(problem) {
  return problem?.visibility === "private";
}

export function canSeeProblem(problem, user) {
  if (!problem) return false;
  if (!isPrivate(problem) || isSuperadmin(user)) return true;
  return sameCollege(problem, user);
}

// The Mongo filter for the problems this user may see, to combine with a list query.
export function visibleProblemsFilter(user) {
  if (isSuperadmin(user)) return {};
  const or = [{ visibility: { $ne: "private" } }];
  if (user?.collegeId) or.push({ collegeId: user.collegeId });
  return { $or: or };
}

// Edit rights for staff (the routes already require faculty/admin/superadmin).
export function canEditProblem(problem, user) {
  if (isSuperadmin(user)) return true;
  return isPrivate(problem) ? sameCollege(problem, user) : true;
}

export function canDeleteProblem(problem, user) {
  return isSuperadmin(user) || sameCollege(problem, user);
}

// Public/private is the owning college's call. Making a problem private is refused while
// another college's assessment uses it: their students would lose it mid-exam.
export async function assertCanSetVisibility(problem, visibility, user) {
  if (!visibility || visibility === (problem.visibility || "public")) return;
  if (!isSuperadmin(user) && !sameCollege(problem, user)) {
    throw new HttpError(403, "Forbidden", { error: "Only the college that added this problem can change who sees it." });
  }
  if (visibility === "private") {
    const usedElsewhere = await Assessment.exists({
      "problems.problemId": problem._id,
      ...(problem.collegeId ? { collegeId: { $ne: problem.collegeId } } : {})
    });
    if (usedElsewhere) {
      throw new HttpError(409, "Problem in use", { error: "Another college's assessment uses this problem, so it cannot be made private." });
    }
  }
}

export async function assertNotInUse(problem) {
  const used = await Assessment.exists({ "problems.problemId": problem._id });
  if (used) {
    throw new HttpError(409, "Problem in use", { error: "An assessment uses this problem. Remove it from the assessment before deleting it." });
  }
}

// A public problem may be edited by any college, but not while another college's exam that
// uses it is running: changing its tests or statement would change that exam under its
// students. The college running the exam may still edit (to fix a broken test mid-exam), and
// so may a superadmin. Snapshotting the problem per exam would avoid the block, but every
// part that reads a problem (grading, rejudge, reports, the judge) would need the copy.
export async function assertNoOtherCollegeExamRunning(problem, user) {
  if (isSuperadmin(user)) return;
  const now = new Date();
  const running = await Assessment.findOne({
    "problems.problemId": problem._id,
    status: "Published",
    startTime: { $lte: now },
    endTime: { $gte: now },
    ...(user?.collegeId ? { collegeId: { $ne: user.collegeId } } : {})
  }).select("endTime");
  if (running) {
    throw new HttpError(409, "Problem in use", {
      error: `Another college's exam using this problem is running. You can edit it after ${running.endTime.toISOString()}.`
    });
  }
}
