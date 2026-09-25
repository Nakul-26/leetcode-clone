import InterviewSlot from "../../models/InterviewSlot.mjs";

export async function findAll(filter = {}, options = {}) {
  return InterviewSlot.find(filter, null, options)
    .populate("interviewerId", "name email")
    .populate("studentId", "name email usn section")
    .sort({ scheduledAt: 1 });
}

// collegeId: pass a value to scope the lookup to that college (404s instead of leaking
// existence across tenants); pass null/undefined to skip scoping.
export async function findById(id, collegeId) {
  const filter = collegeId ? { _id: id, collegeId } : { _id: id };
  return InterviewSlot.findOne(filter)
    .populate("interviewerId", "name email")
    .populate("studentId", "name email usn section");
}

export async function findByTokenHash(tokenHash) {
  return InterviewSlot.findOne({
    accessTokenHash: tokenHash,
    accessTokenExpiresAt: { $gt: new Date() }
  })
    .populate("interviewerId", "name email")
    .populate("studentId", "name email usn section");
}

export async function create(data) {
  const slot = new InterviewSlot(data);
  await slot.save();
  return slot.populate([
    { path: "interviewerId", select: "name email" },
    { path: "studentId", select: "name email usn section" }
  ]);
}

export async function updateById(id, data, collegeId) {
  const filter = collegeId ? { _id: id, collegeId } : { _id: id };
  return InterviewSlot.findOneAndUpdate(filter, data, { new: true, runValidators: true })
    .populate("interviewerId", "name email")
    .populate("studentId", "name email usn section");
}
