import mongoose from "mongoose";
const { Schema } = mongoose;

// A machine caller of the external API surfaces (/integration/*, /arventiq/*,
// /codeAssess/*). Phase 1 of docs/JUDGE_UNIFICATION_AND_SCALING_PLAN.md.
//
// Before this model, all three surfaces authenticated against a single global
// shared secret read from env (TESTING_PLATFORM_KEY / ARVENTIQ_SECRET /
// CODEASSESS_SHIM_KEY). That made it impossible to tell which customer made a
// call, so there was no way to meter, invoice, rate-limit or revoke one of them
// without rotating the key for everyone. It is also why the Judge0 shim wrote no
// usage events at all: UsageEvent needs collegeId/userId/submissionId and the
// shim had none of the three.
//
// Keys are never stored. `keyHash` is sha256 of the full presented key, which is
// safe here (unlike a user password) because the key is high-entropy random
// material, not something a human chose — so there is nothing to brute-force and
// a plain fast hash is appropriate. It is indexed and unique so authentication is
// a single direct lookup rather than a scan-and-compare over every client.
const ApiClientSchema = new Schema(
  {
    name: { type: String, required: true },

    // Non-secret, human-readable identifier shown in admin UI and logs so a key
    // can be discussed and revoked without ever handling the secret itself.
    keyPrefix: { type: String, required: true, index: true },
    keyHash: { type: String, required: true, unique: true, index: true },

    // Tenant this caller's traffic is attributed to. Everything downstream —
    // UsageEvent, quota enforcement, the collegeId scoping the rest of the
    // platform already applies — keys off this.
    collegeId: { type: Schema.Types.ObjectId, ref: "College", required: true, index: true },

    // Submission.userId is a required ref, so each client needs a User to own the
    // submissions it creates. Mirrors the existing shared service-account pattern
    // in middleware/arventiq.mjs, but one per client instead of one globally.
    serviceUserId: { type: Schema.Types.ObjectId, ref: "User" },

    // Which surfaces this key may call. Checked by the auth middleware so one
    // customer's key cannot reach an endpoint they were not sold.
    scopes: {
      type: [String],
      enum: ["integration", "arventiq", "codeassess"],
      default: []
    },

    // Per-client limits. Null/0 means "fall back to the global env defaults"
    // (COLLEGE_SUBMISSION_QUOTA etc.) so existing behaviour is unchanged until a
    // value is deliberately set — enforcement lands in plan Phase 4.
    rateLimitPerMin: { type: Number, default: 0 },
    monthlyQuota: { type: Number, default: 0 },

    active: { type: Boolean, default: true, index: true },
    lastUsedAt: { type: Date },
    revokedAt: { type: Date }
  },
  { timestamps: true }
);

// Admin listing: a college's keys, newest first.
ApiClientSchema.index({ collegeId: 1, createdAt: -1 });

export default mongoose.model("ApiClient", ApiClientSchema);
