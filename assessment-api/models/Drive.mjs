import mongoose from "mongoose";
const { Schema } = mongoose;

const DriveSchema = new Schema(
  {
    companyName: { type: String, required: true },
    description: { type: String },
    rounds: [
      {
        name: { type: String, required: true },
        type: { type: String, enum: ["assessment", "interview"], required: true },
        // Only meaningful when type === 'assessment' — links a round to an existing
        // Assessment doc (e.g. Phase A's MCQ type for an aptitude round). Faculty still
        // record the Pass/Fail outcome into the pipeline manually via recordRoundResult;
        // this is for cross-reference, not automatic grading-to-pipeline wiring.
        assessmentId: { type: Schema.Types.ObjectId, ref: "Assessment" },
        passCriteria: { type: String }
      }
    ],
    eligibility: {
      sections: [{ type: String }],
      notes: { type: String }
    },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    collegeId: { type: Schema.Types.ObjectId, ref: "College" },
    status: {
      type: String,
      enum: ["Draft", "Active", "Closed"],
      default: "Draft"
    }
  },
  { timestamps: true }
);

DriveSchema.index({ createdBy: 1 });
DriveSchema.index({ collegeId: 1 });
DriveSchema.index({ status: 1 });

export default mongoose.model("Drive", DriveSchema);
