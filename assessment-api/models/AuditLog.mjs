import mongoose from "mongoose";

const auditLogSchema = new mongoose.Schema(
  {
    event: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    // The acting user's college at the time of the event — lets GET /api/admin/audit-logs
    // scope results per-tenant the same way Assessment/Submission/AssessmentAttempt do.
    // Absent for events with no known college (e.g. a failed login against an unknown
    // email, or a superadmin-only action) — same "unscoped rather than scoped-to-nothing"
    // gap as elsewhere, only visible to superadmin.
    collegeId: { type: mongoose.Schema.Types.ObjectId, ref: "College" },
    details: { type: mongoose.Schema.Types.Mixed },
    ip: { type: String },
    userAgent: { type: String }
  },
  { timestamps: true }
);

auditLogSchema.index({ collegeId: 1 });

export default mongoose.model("AuditLog", auditLogSchema);
