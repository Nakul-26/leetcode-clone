import AuditLog from "../../models/AuditLog.mjs";

export async function logEvent({ event, userId, collegeId, details, ip, userAgent }) {
  try {
    await AuditLog.create({
      event,
      userId,
      collegeId,
      details,
      ip,
      userAgent
    });
  } catch (error) {
    console.error("Failed to log audit event:", error);
  }
}

// superadmin operates across colleges; everyone else is scoped to their own. Mirrors
// assessments.service.js's collegeScopeFor exactly.
function collegeScopeFor(user) {
  if (!user || user.role === 'superadmin') return undefined;
  return user.collegeId || undefined;
}

export async function listLogs(query = {}, requestingUser, limit = 100) {
  const scope = collegeScopeFor(requestingUser);
  const filter = scope ? { ...query, collegeId: scope } : query;

  return AuditLog.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('userId', 'name email role');
}
