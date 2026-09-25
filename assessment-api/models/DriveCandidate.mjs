import mongoose from "mongoose";
const { Schema } = mongoose;

const DriveCandidateSchema = new Schema(
  {
    driveId: { type: Schema.Types.ObjectId, ref: "Drive", required: true },
    studentId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    collegeId: { type: Schema.Types.ObjectId, ref: "College" },
    currentRoundIndex: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["Applied", "InProgress", "RoundPassed", "RoundFailed", "Selected", "Rejected", "Withdrawn"],
      default: "Applied"
    },
    roundHistory: [
      {
        roundIndex: { type: Number, required: true },
        result: { type: String, enum: ["Pass", "Fail"], required: true },
        notes: { type: String },
        link: { type: String },
        recordedAt: { type: Date, default: Date.now },
        recordedBy: { type: Schema.Types.ObjectId, ref: "User" }
      }
    ]
  },
  { timestamps: true }
);

// One pipeline entry per (drive, student) — enrollment is idempotent against this.
DriveCandidateSchema.index({ driveId: 1, studentId: 1 }, { unique: true });
DriveCandidateSchema.index({ collegeId: 1 });
DriveCandidateSchema.index({ studentId: 1 });

export default mongoose.model("DriveCandidate", DriveCandidateSchema);
