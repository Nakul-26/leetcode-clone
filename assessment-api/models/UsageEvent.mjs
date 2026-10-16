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
    createdAt: { type: Date, default: Date.now }
  },
  { timestamps: false }
);

UsageEventSchema.index({ collegeId: 1, createdAt: -1 });
UsageEventSchema.index({ collegeId: 1, language: 1 });
// Per-client metering: "how much did this customer use this period".
UsageEventSchema.index({ apiClientId: 1, createdAt: -1 });

export default mongoose.model("UsageEvent", UsageEventSchema);
