import * as questionsRepo from "../repositories/questions.repo.js";
import { HttpError } from "../utils/httpError.js";
import { escapeRegex } from "../utils/escapeRegex.js";

// superadmin operates across colleges; everyone else (including admin — this bank has
// no repo-level findById(id, collegeId) scoping like Assessment/Drive, so every call
// site here does the check inline) is scoped to their own. Mirrors the collegeScopeFor
// convention used throughout the rest of the codebase.
function collegeScopeFor(user) {
  if (!user || user.role === 'superadmin') return undefined;
  return user.collegeId || undefined;
}

function isPrivilegedRole(role) {
  return role === 'admin' || role === 'superadmin' || role === 'faculty';
}

function parsePagination(query) {
  const page = Math.max(1, Number(query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(query.limit || 50)));
  return { limit, skip: (page - 1) * limit };
}

function buildFilter(query = {}, user = null) {
  const filter = {};
  if (query.difficulty) filter.difficulty = query.difficulty;
  if (query.tag) {
    const tags = Array.isArray(query.tag) ? query.tag : String(query.tag).split(',').map(t => t.trim()).filter(Boolean);
    if (tags.length) filter.tags = { $in: tags };
  }
  if (query.search) filter.title = { $regex: escapeRegex(query.search), $options: 'i' };

  // Tenant scoping: admin/faculty are locked to their own college regardless of what
  // collegeId the query asks for — only superadmin may cross-filter via query.collegeId.
  const scope = collegeScopeFor(user);
  if (scope) {
    filter.collegeId = scope;
  } else if (query.collegeId) {
    filter.collegeId = query.collegeId;
  }

  // Visibility: faculty/admin should see their college & private authored questions
  if (user && isPrivilegedRole(user.role)) {
    // no extra filter
  } else {
    // for non-privileged users, only Public questions
    filter.visibility = 'Public';
  }

  return filter;
}

export async function listQuestions(query = {}, user = null) {
  const filter = buildFilter(query, user);
  const options = parsePagination(query);
  const [questions, total] = await Promise.all([
    questionsRepo.findAll(filter, options),
    questionsRepo.count(filter)
  ]);

  const page = Math.max(1, Number(query.page || 1));
  const totalPages = Math.max(1, Math.ceil(total / options.limit));

  return { questions, total, page, totalPages };
}

export async function listTags(_query = {}, user = null) {
  // Build filter similar to listQuestions but only for tags
  const filter = {};
  const scope = collegeScopeFor(user);
  if (scope) {
    filter.collegeId = scope;
  } else if (!user || !isPrivilegedRole(user.role)) {
    // non-privileged users only see public tags
    filter.visibility = 'Public';
  }

  const tags = await questionsRepo.distinctTags(filter);
  // return sorted unique tags
  return (tags || []).sort();
}

export async function selectQuestions(payload = {}, user = null) {
  const { easy = 0, medium = 0, hard = 0, tags = [] } = payload || {};

  const toNumber = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };

  const reqEasy = toNumber(easy);
  const reqMedium = toNumber(medium);
  const reqHard = toNumber(hard);

  if (reqEasy + reqMedium + reqHard === 0) {
    throw new Error('At least one question count must be provided');
  }

  const baseFilter = {};
  if (Array.isArray(tags) && tags.length) baseFilter.tags = { $in: tags };

  // Visibility / college scoping
  const scope = collegeScopeFor(user);
  if (scope) {
    baseFilter.collegeId = scope;
  } else if (!user || !isPrivilegedRole(user.role)) {
    baseFilter.visibility = 'Public';
  }

  const picked = [];
  const addUnique = (docs) => {
    const map = new Map(picked.map(d => [String(d._id), d]));
    for (const d of docs) {
      if (!map.has(String(d._id))) {
        map.set(String(d._id), d);
      }
    }
    // rebuild picked
    picked.length = 0;
    for (const v of map.values()) picked.push(v);
  };

  if (reqEasy > 0) {
    const docs = await questionsRepo.sample({ ...baseFilter, difficulty: 'Easy' }, reqEasy);
    addUnique(docs);
  }
  if (reqMedium > 0) {
    const docs = await questionsRepo.sample({ ...baseFilter, difficulty: 'Medium' }, reqMedium);
    addUnique(docs);
  }
  if (reqHard > 0) {
    const docs = await questionsRepo.sample({ ...baseFilter, difficulty: 'Hard' }, reqHard);
    addUnique(docs);
  }

  return { questions: picked };
}


// A question with no collegeId (legacy data) resolves to visible-to-any-staff rather
// than visible-to-none, matching the same "unscoped rather than scoped-to-nothing" gap
// left open elsewhere (e.g. canAccessSubmission in submissions.service.js).
function isSameCollegeStaff(q, user) {
  return (user.role === 'admin' || user.role === 'faculty')
    && (!q.collegeId || String(q.collegeId) === String(user.collegeId));
}

export async function getQuestionById(id, user = null) {
  const q = await questionsRepo.findById(id);
  if (!q) return null;

  if (q.visibility === 'Public') return q;
  if (!user) return null;
  if (user.role === 'superadmin') return q;
  if (isSameCollegeStaff(q, user)) return q;
  if (String(q.author) === String(user._id)) return q;

  return null;
}

export async function createQuestion(payload, user) {
  if (!user) throw new HttpError(401, 'Unauthorized');
  const data = { ...payload };
  data.author = user._id;
  // collegeId always comes from the authenticated user's own token claim, never the
  // request body, so an admin/faculty can't stamp another tenant's id onto their own
  // content (mirrors createAssessment/createDrive's collegeId-injection guard).
  data.collegeId = user.role === 'superadmin' ? (payload.collegeId || undefined) : (user.collegeId || undefined);

  // Basic validation
  if (!data.title || typeof data.title !== 'string') throw new HttpError(400, 'Title is required');
  return questionsRepo.create(data);
}

export async function updateQuestion(id, payload, user) {
  const q = await questionsRepo.findById(id);
  if (!q) throw new HttpError(404, 'Question not found');

  const isOwner = String(q.author) === String(user._id);
  const isSuperadmin = user.role === 'superadmin';

  if (!isOwner && !isSuperadmin && !isSameCollegeStaff(q, user)) {
    throw new HttpError(403, 'Forbidden');
  }

  const { collegeId, author, ...safePayload } = payload; // both immutable post-creation via this path
  return questionsRepo.updateById(id, safePayload);
}

export async function deleteQuestion(id, user) {
  const q = await questionsRepo.findById(id);
  if (!q) throw new HttpError(404, 'Question not found');

  const isOwner = String(q.author) === String(user._id);
  const isSuperadmin = user.role === 'superadmin';
  const isSameCollegeAdmin = user.role === 'admin' && (!q.collegeId || String(q.collegeId) === String(user.collegeId));

  if (!isOwner && !isSuperadmin && !isSameCollegeAdmin) {
    throw new HttpError(403, 'Forbidden');
  }
  return questionsRepo.deleteById(id);
}
