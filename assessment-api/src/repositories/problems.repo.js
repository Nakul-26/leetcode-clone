import Problem from "../../models/Problem.mjs";

export async function findAll(filter = {}, options = {}) {
  return Problem.find(filter, null, options);
}

export async function findAllWithoutTests(filter = {}, options = {}) {
  return Problem.find(filter, null, options).select("-testCases");
}

export async function findById(id) {
  return Problem.findById(id);
}

// Includes the reference solution, which every other query leaves out (select:false). Only for
// server-side use and privileged readers; never return this to a student.
export async function findByIdWithReference(id) {
  return Problem.findById(id).select("+referenceSolution +solutionLanguage");
}

export async function findByExternalId(externalId) {
  return Problem.findOne({ externalId: String(externalId) });
}

export async function create(data) {
  const problem = new Problem(data);
  return problem.save();
}

export async function deleteById(id) {
  return Problem.findByIdAndDelete(id);
}

export async function updateById(id, data) {
  return Problem.findByIdAndUpdate(id, data, { new: true, runValidators: true });
}
