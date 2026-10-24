
import mongoose from 'mongoose';
import { isValidType } from '../src/utils/typeValidator.mjs';

const { Schema } = mongoose;

const ParameterSchema = new Schema({
  name: { type: String, required: true },
  type: { 
    type: String, 
    required: true,
    validate: {
      validator: isValidType,
      message: props => `${props.value} is not a valid platform type!`
    }
  }
}, { _id: false });

const CompareConfigSchema = new Schema({
  mode: { type: String, enum: ['EXACT', 'STRUCTURAL'], default: 'EXACT' },
  floatTolerance: { type: Number, default: 0 },
  orderInsensitive: { type: Boolean, default: false },
  requireDeepCopy: { type: Boolean, default: false }
}, { _id: false });

// ProblemType mirrors judge-service-go/pkg/models/problem_type.go for the two
// judge-executed shapes ('function' is the named-function model, 'stdin' is a full
// stdin/stdout program — the shape Arventiq's problems actually use, see
// docs/arventiq-integration/PLAN.md §2). 'mcq'/'subjective' are judge-service-go-free:
// graded entirely in assessment-api (auto-graded for mcq, manually graded for
// subjective) — see quota.service.js-adjacent submissions.service.js.
const isFunctionProblem = function () {
  return (this.problemType || 'function') === 'function';
};

const OptionSchema = new Schema({
  text: { type: String, required: true },
  isCorrect: { type: Boolean, default: false }
}, { _id: false });

const ProblemSchema = new Schema({
  title: { type: String, required: true },
  description: { type: String, required: true },
  difficulty: { type: String, enum: ['Easy', 'Medium', 'Hard'], required: true },
  problemType: { type: String, enum: ['function', 'stdin', 'mcq', 'subjective'], default: 'function' },
  // externalId maps a synced problem back to its source system's own identifier
  // (e.g. Arventiq's numeric question id) so Problem Sync can upsert by it.
  externalId: { type: String, unique: true, sparse: true },
  // Descriptive only, used by stdin problems (Arventiq's input_format/output_format).
  inputFormat: { type: String },
  outputFormat: { type: String },
  functionName: { type: String, required: isFunctionProblem },
  parameters: { type: [ParameterSchema], default: [] },
  returnType: {
    type: String,
    required: isFunctionProblem,
    validate: {
      validator: isValidType,
      message: props => `${props.value} is not a valid platform type!`
    }
  },
  timeLimitMs: { type: Number, default: 2000 },
  memoryLimitMb: { type: Number, default: 256 },
  compareConfig: { type: CompareConfigSchema, default: () => ({}) },

  testCases: [{
    inputs: { type: [Schema.Types.Mixed], required: true },
    expected: { type: Schema.Types.Mixed, required: true },
    isSample: { type: Boolean, default: false },
    isHidden: { type: Boolean, default: false }
  }],

  testsJSON: { type: String },

  // The author's correct solution, the source of truth for expected outputs (JUDGE_FIX_PLAN
  // Phase 6): saving checks every expected output against it, and a student's own Run test
  // gets its expected output from it. select:false keeps it out of every query unless asked
  // for explicitly (problemsRepo.findByIdWithReference), so it never reaches a student.
  referenceSolution: { type: String, select: false },
  solutionLanguage: { type: String, select: false },

  // mcq-only. Auto-graded in submissions.service.js: correct iff the submitted
  // selectedOptions set exactly equals the set of isCorrect indexes.
  options: { type: [OptionSchema], default: [] },
  allowMultipleAnswers: { type: Boolean, default: false },

  // subjective-only. maxWords is enforced client/server-side on submit; rubricNotes
  // is grading guidance shown only to faculty on the manual-grading queue, never to
  // students.
  maxWords: { type: Number },
  rubricNotes: { type: String },

  tags: [String],
  isPremium: { type: Boolean, default: false },

  submissionCount: { type: Number, default: 0 },
  acceptedCount: { type: Number, default: 0 },

  createdAt: { type: Date, default: Date.now }
}, {
  // updatedAt versions the cached reference outputs for students' Run tests.
  timestamps: { createdAt: false, updatedAt: true }
});

export default mongoose.model('Problem', ProblemSchema);
