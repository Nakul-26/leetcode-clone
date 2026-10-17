import mongoose from "mongoose";

const { Schema } = mongoose;

const InterviewSlotSchema = new Schema(
  {
    driveId: { type: Schema.Types.ObjectId, ref: "Drive", required: true },
    driveCandidateId: { type: Schema.Types.ObjectId, ref: "DriveCandidate", required: true },
    // Denormalized from DriveCandidate.studentId at creation time so "my scheduled
    // interviews" can be queried directly without a join, mirroring how
    // DriveCandidate.collegeId is denormalized from Drive.
    studentId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    roundIndex: { type: Number, required: true },
    collegeId: { type: Schema.Types.ObjectId, ref: "College" },
    interviewerId: { type: Schema.Types.ObjectId, ref: "User" },
    externalInterviewerName: { type: String },
    externalInterviewerEmail: { type: String },
    scheduledAt: { type: Date, required: true },
    durationMinutes: { type: Number, default: 30 },
    meetingLink: { type: String },
    notes: { type: String },
    status: {
      type: String,
      enum: ["Scheduled", "Completed", "Cancelled", "NoShow"],
      default: "Scheduled"
    },
    // Single-use-per-slot signed link for an external interviewer: only a hash is
    // stored, the raw token is returned once (to the staff member who scheduled the
    // slot) and emailed to the interviewer - same shape as a password-reset token.
    accessTokenHash: { type: String },
    accessTokenExpiresAt: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    // Structured interviewer feedback, submitted from the live room (Phase D) after the
    // interview. One entry per distinct submitter (a panel can have several staff
    // interviewers, plus at most one external interviewer) - re-submitting replaces only
    // that submitter's own entry, identified by submittedByUserId for staff (stable) or
    // by role:'external' for the external interviewer (no account, so no stable id, but
    // a slot only ever has one external interviewer). Free-text name instead of a User
    // ref for submittedBy since an external interviewer has no account.
    scorecards: [
      {
        role: { type: String, enum: ["interviewer", "external"], required: true },
        submittedByUserId: { type: Schema.Types.ObjectId, ref: "User" },
        submittedByName: { type: String },
        ratings: {
          communication: { type: Number, min: 1, max: 5 },
          problemSolving: { type: Number, min: 1, max: 5 },
          technicalDepth: { type: Number, min: 1, max: 5 }
        },
        notes: { type: String },
        submittedAt: { type: Date }
      }
    ]
  },
  { timestamps: true }
);

InterviewSlotSchema.index({ driveCandidateId: 1 });
InterviewSlotSchema.index({ driveId: 1 });
InterviewSlotSchema.index({ studentId: 1 });
InterviewSlotSchema.index({ collegeId: 1 });
InterviewSlotSchema.index({ accessTokenHash: 1 });

export default mongoose.model("InterviewSlot", InterviewSlotSchema);
