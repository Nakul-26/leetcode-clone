import Submission from "../../models/Submission.mjs";

export async function create(data) {
  const submission = new Submission(data);
  return submission.save();
}

// collegeId: pass a value to scope the lookup to that college (404s instead of leaking
// existence across tenants); pass null/undefined to skip scoping (superadmin/cross-tenant use).
export async function findById(id, collegeId) {
  const filter = collegeId ? { _id: id, collegeId } : { _id: id };
  return Submission.findOne(filter);
}

export async function findByUserId(userId, options = {}) {
  return Submission.find({ userId }, null, options)
    .select("_id problemId language status score attemptId assessmentId output testResult selectedOptions answerText feedback createdAt updatedAt")
    .populate("problemId", "title")
    .sort({ createdAt: -1 });
}

export async function updateById(id, data) {
  return Submission.findByIdAndUpdate(id, data, { new: true });
}
