
import mongoose from 'mongoose';
const { Schema } = mongoose;

const SubmissionSchema = new Schema({
    problemId: {
        type: Schema.Types.ObjectId,
        ref: 'Problem',
        required: true
    },
    userId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    assessmentId: {
        type: Schema.Types.ObjectId,
        ref: 'Assessment'
    },
    attemptId: {
        type: Schema.Types.ObjectId,
        ref: 'AssessmentAttempt'
    },
    collegeId: {
        type: Schema.Types.ObjectId,
        ref: 'College'
    },
    score: {
        type: Number,
        default: 0
    },
    // Required for coding (function/stdin) submissions only, enforced in
    // submissions.service.js — mcq/subjective submissions have no code/language and
    // use selectedOptions/answerText below instead.
    code: {
        type: String
    },
    language: {
        type: String
    },
    status: {
        type: String,
        // PendingReview: a subjective answer awaiting manual faculty grading.
        // Graded: a subjective answer that has been manually graded (see gradedBy/
        // gradedAt/feedback/score below). mcq submissions resolve synchronously to
        // Success/Fail exactly like coding submissions, no new status needed for them.
        enum: ['Pending', 'Running', 'Success', 'Fail', 'Error', 'PendingReview', 'Graded'],
        default: 'Pending'
    },
    output: {
        type: String
    },
    testResult: {
        type: Object // To store the structured result from the judge service
    },
    tests: {
        type: Array
    },
    // mcq-only: indexes into the Problem.options array the student selected.
    selectedOptions: {
        type: [Number]
    },
    // subjective-only: the student's free-text answer.
    answerText: {
        type: String
    },
    // subjective-only, set when a faculty/admin grades the answer (see
    // submissions.service.js's gradeSubjectiveSubmission).
    gradedBy: {
        type: Schema.Types.ObjectId,
        ref: 'User'
    },
    gradedAt: {
        type: Date
    },
    feedback: {
        type: String
    },
    // Opaque traceability metadata for submissions that originate from an external
    // system (Arventiq) via the shared service account — not used for auth or
    // ownership checks, see docs/arventiq-integration/PLAN.md §6.
    externalStudentId: {
        type: String
    },
    externalAssessmentId: {
        type: String
    },
    // Which external API key produced this submission (plan Phase 1). Absent for
    // submissions made through the frontend, and for callers still using a legacy
    // global shared secret - those stay unattributable until they are issued a key.
    apiClientId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ApiClient'
    }
}, { timestamps: true });

// Optional: add an index for faster lookups by status
SubmissionSchema.index({ status: 1 });
SubmissionSchema.index({ userId: 1 });
SubmissionSchema.index({ assessmentId: 1 });
SubmissionSchema.index({ attemptId: 1 });
SubmissionSchema.index({ assessmentId: 1, userId: 1 });
SubmissionSchema.index({ collegeId: 1 });
// Per-client usage reporting and quota windows.
SubmissionSchema.index({ apiClientId: 1, createdAt: -1 });

export default mongoose.model('Submission', SubmissionSchema);
