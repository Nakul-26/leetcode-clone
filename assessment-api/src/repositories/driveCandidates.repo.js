import DriveCandidate from "../../models/DriveCandidate.mjs";

export async function findAll(filter = {}, options = {}) {
  return DriveCandidate.find(filter, null, options)
    .populate("studentId", "name email usn section")
    .sort({ updatedAt: -1 });
}

export async function findById(id, collegeId) {
  const filter = collegeId ? { _id: id, collegeId } : { _id: id };
  return DriveCandidate.findOne(filter).populate("studentId", "name email usn section");
}

export async function findOne(filter) {
  return DriveCandidate.findOne(filter).populate("studentId", "name email usn section");
}

export async function create(data) {
  const candidate = new DriveCandidate(data);
  return candidate.save();
}

export async function insertMany(docs) {
  if (docs.length === 0) return [];
  return DriveCandidate.insertMany(docs, { ordered: false });
}

export async function updateById(id, data, collegeId) {
  const filter = collegeId ? { _id: id, collegeId } : { _id: id };
  return DriveCandidate.findOneAndUpdate(filter, data, { new: true, runValidators: true })
    .populate("studentId", "name email usn section");
}

export async function existingStudentIds(driveId, studentIds) {
  const existing = await DriveCandidate.find({ driveId, studentId: { $in: studentIds } }).select("studentId");
  return new Set(existing.map((c) => String(c.studentId)));
}
