import mongoose from "mongoose";
const { Schema } = mongoose;

// Written directly by judge-service-go (bypassing Mongoose, same as it already
// does for the submissions collection) next to its per-submission elapsedMs
// computation. This model exists so assessment-api can query/report on it with
// the same indexes, not to gate the writes themselves.
const UsageEventSchema = new Schema(
  {
    collegeId: { type: Schema.Types.ObjectId, ref: "College" },
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    submissionId: { type: Schema.Types.ObjectId, ref: "Submission" },
    // Which external API key this usage is billable to (plan Phase 1). Absent for
    // frontend traffic and for legacy shared-secret callers.
    apiClientId: { type: Schema.Types.ObjectId, ref: "ApiClient" },
    language: { type: String },
    status: { type: String },
    elapsedMs: { type: Number },
    // Test cases executed. A coalesced batch is one submission with many, so billing and
    // quotas count this, not documents. Absent on events written before it existed (treat as 1).
    testCount: { type: Number },
    // Which judge path ran it: "queue" (submissions, including the keyed public API), "run"
    // (synchronous sample runs) or "raw-run" (the legacy public-API path). Absent on events
    // written before it existed, which all came from the queue. Statistics only.
    source: { type: String },
    createdAt: { type: Date, default: Date.now }
  },
  { timestamps: false }
);

UsageEventSchema.index({ collegeId: 1, createdAt: -1 });
UsageEventSchema.index({ collegeId: 1, language: 1 });
// Per-client metering: "how much did this customer use this period".
UsageEventSchema.index({ apiClientId: 1, createdAt: -1 });
// Per-language statistics over a time window (GET /api/admin/language-stats).
UsageEventSchema.index({ language: 1, createdAt: -1 });

export default mongoose.model("UsageEvent", UsageEventSchema);
