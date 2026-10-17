import * as problemsRepo from "../repositories/problems.repo.js";
import Submission from "../../models/Submission.mjs";
import { HttpError } from "../utils/httpError.js";
import { validateProblemDefinition } from "./preview.service.js";
import { env } from "../config/env.js";
import { collegeAllowsPremium } from "./billing.service.js";
import { escapeRegex } from "../utils/escapeRegex.js";

function isPrivilegedRole(role) {
  return role === "admin" || role === "faculty" || role === "superadmin";
}

function isSampleTestCase(tc = {}) {
  if (typeof tc.isSample === "boolean") return tc.isSample;
  // If isSample is not explicitly set, we rely on isHidden.
  // A test case is a sample if it's NOT hidden.
  if (typeof tc.isHidden === "boolean") return !tc.isHidden;
  // Default to false for safety: if we don't know, it's hidden.
  return false;
}

function sanitizeResultDetails(details = [], testCases = [], isAssessment = false) {
  return details.map((detail, idx) => {
    const testNum = detail.test ?? detail.Test;
    const testIndexFromPayload = Number.isInteger(testNum) ? testNum - 1 : idx;
    const tc = testCases[testIndexFromPayload];
    const hidden = tc ? !isSampleTestCase(tc) : false;

    if (!hidden) {
      // For sample test cases, ensure all fields are present and correctly named for the frontend.
      // We check for both lowercase and capitalized versions as the judge might return either depending on BSON tags.
      return {
        ...detail,
        inputs: detail.inputs ?? detail.input ?? detail.Input,
        expected: detail.expected ?? detail.Expected,
        output: detail.output ?? detail.Output,
        passed: detail.passed ?? detail.ok ?? detail.Passed ?? detail.Ok ?? false,
        ok: detail.passed ?? detail.ok ?? detail.Passed ?? detail.Ok ?? false,
        stdout: detail.stdout ?? detail.Stdout,
        stderr: detail.stderr ?? detail.Stderr,
        traceback: detail.traceback ?? detail.Traceback,
        timeMs: detail.timeMs ?? detail.TimeMs,
      };
    }

    // For hidden test cases
    const sanitized = {
      test: detail.test ?? detail.Test,
      passed: detail.passed ?? detail.ok ?? detail.Passed ?? detail.Ok ?? false,
      ok: detail.passed ?? detail.ok ?? detail.Passed ?? detail.Ok ?? false,
      isHidden: true,
      timeMs: detail.timeMs ?? detail.TimeMs
    };

    // Requirement: For Practice Problems, show Console Logs. For Assessments, hide them.
    if (!isAssessment) {
      sanitized.stdout = detail.stdout ?? detail.Stdout;
      sanitized.stderr = detail.stderr ?? detail.Stderr;
      sanitized.traceback = detail.traceback ?? detail.Traceback;
    }

    return sanitized;
  });
}

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function normalizeProblemPayload(payload = {}) {
  const normalized = { ...payload };
  if (typeof normalized.title === "string") {
    normalized.title = normalized.title.trim();
  }
  if (typeof normalized.description === "string") {
    normalized.description = normalized.description.trim();
  }
  if (typeof normalized.functionName === "string") {
    normalized.functionName = normalized.functionName.trim();
  }
  if (typeof normalized.returnType === "string") {
    normalized.returnType = normalized.returnType.trim();
  }

  if (Array.isArray(normalized.parameters)) {
    normalized.parameters = normalized.parameters
      .map((p = {}) => ({
        ...p,
        name: typeof p.name === "string" ? p.name.trim() : p.name,
        type: typeof p.type === "string" ? p.type.trim() : p.type
      }));
  }

  normalized.compareConfig = {
    mode: normalized.compareConfig?.mode || "EXACT",
    floatTolerance: Number.isFinite(Number(normalized.compareConfig?.floatTolerance))
      ? Number(normalized.compareConfig.floatTolerance)
      : 0,
    orderInsensitive: Boolean(normalized.compareConfig?.orderInsensitive)
  };

  if (!Array.isArray(normalized.testCases)) return normalized;
  return {
    ...normalized,
    testCases: normalized.testCases.map((tc = {}) => {
      const sample = tc.isSample === true;
      return {
        inputs: tc.inputs,
        expected: tc.expected,
        isSample: sample,
        isHidden: !sample
      };
    })
  };
}

function sanitizeProblemForStudent(problemDoc) {
  const problem = typeof problemDoc.toObject === "function" ? problemDoc.toObject() : { ...problemDoc };
  const visibleCases = Array.isArray(problem.testCases)
    ? problem.testCases
        .filter((tc) => isSampleTestCase(tc))
        .map((tc) => ({
          ...tc,
          isSample: true,
          isHidden: false
        }))
    : [];

  return {
    ...problem,
    testCases: visibleCases
  };
}

function validateProblemPayload(payload) {
  const validationErrors = [];

  if (!payload.title || typeof payload.title !== "string" || !payload.title.trim()) {
    validationErrors.push("title is required");
  }
  if (!payload.description || typeof payload.description !== "string" || !payload.description.trim()) {
    validationErrors.push("description is required");
  }
  if (!payload.difficulty || typeof payload.difficulty !== "string") {
    validationErrors.push("difficulty is required");
  } else if (!["Easy", "Medium", "Hard"].includes(payload.difficulty)) {
    validationErrors.push("difficulty must be Easy, Medium, or Hard");
  }

  if (Array.isArray(payload.testCases)) {
    if (payload.testCases.length === 0) {
      validationErrors.push("testCases must contain at least one test case");
    }

    payload.testCases.forEach((tc, i) => {
      if (!Array.isArray(tc.inputs)) {
        validationErrors.push(`testCases[${i}].inputs must be an array`);
      }
      if (tc.expected === undefined || tc.expected === null) {
        validationErrors.push(`testCases[${i}].expected is required`);
      }
    });
  } else {
    validationErrors.push("testCases must be an array");
  }

  if (!payload.functionName || typeof payload.functionName !== "string") {
    validationErrors.push("functionName is required");
  } else if (!IDENTIFIER_PATTERN.test(payload.functionName.trim())) {
    validationErrors.push("functionName must be a valid identifier");
  }
  if (!payload.returnType || typeof payload.returnType !== "string") {
    validationErrors.push("returnType is required");
  }
  if (!Array.isArray(payload.parameters)) {
    validationErrors.push("parameters must be an array");
  } else {
    if (payload.parameters.length === 0) {
      validationErrors.push("parameters must contain at least one parameter");
    }

    payload.parameters.forEach((p, i) => {
      if (!p || typeof p.name !== "string" || !p.name.trim()) {
        validationErrors.push(`parameters[${i}].name is required`);
      } else if (!IDENTIFIER_PATTERN.test(p.name.trim())) {
        validationErrors.push(`parameters[${i}].name: invalid format`);
      }
      if (!p || typeof p.type !== "string" || !p.type.trim()) {
        validationErrors.push(`parameters[${i}].type is required`);
      }
    });
  }

  if (payload.compareConfig) {
    const { mode, floatTolerance } = payload.compareConfig;
    if (mode && mode !== "EXACT" && mode !== "STRUCTURAL") {
      validationErrors.push("compareConfig.mode must be EXACT or STRUCTURAL");
    }
    if (floatTolerance !== undefined && (!Number.isFinite(floatTolerance) || floatTolerance < 0)) {
      validationErrors.push("compareConfig.floatTolerance must be a non-negative number");
    }
  }

  if (Array.isArray(payload.parameters) && Array.isArray(payload.testCases)) {
    const expectedArity = payload.parameters.length;
    payload.testCases.forEach((tc, i) => {
      if (Array.isArray(tc.inputs) && tc.inputs.length !== expectedArity) {
        validationErrors.push(
          `testCases[${i}].inputs length ${tc.inputs.length} does not match parameters length ${expectedArity}`
        );
      }
    });
  }

  if (Array.isArray(payload.testCases) && !payload.testCases.some((tc) => tc?.isSample === true)) {
    validationErrors.push("At least one test case must be marked as sample");
  }

  return validationErrors;
}

// mcq/subjective problems never reach the judge (no compile/run/wrapper step), so
// they get their own lightweight structural validators instead of
// validateProblemPayload's coding-specific checks (functionName/parameters/
// testCases) and skip validateProblemDefinition's deep judge-based validation
// entirely — see createProblem/updateProblem below.
function validateMcqPayload(payload) {
  const validationErrors = [];

  if (!payload.title || typeof payload.title !== "string" || !payload.title.trim()) {
    validationErrors.push("title is required");
  }
  if (!payload.description || typeof payload.description !== "string" || !payload.description.trim()) {
    validationErrors.push("description is required");
  }
  if (!payload.difficulty || !["Easy", "Medium", "Hard"].includes(payload.difficulty)) {
    validationErrors.push("difficulty must be Easy, Medium, or Hard");
  }

  if (!Array.isArray(payload.options) || payload.options.length < 2) {
    validationErrors.push("options must contain at least 2 choices");
  } else {
    payload.options.forEach((o, i) => {
      if (!o || typeof o.text !== "string" || !o.text.trim()) {
        validationErrors.push(`options[${i}].text is required`);
      }
    });
    const correctCount = payload.options.filter((o) => o?.isCorrect === true).length;
    if (correctCount === 0) {
      validationErrors.push("options must include at least one correct answer");
    }
    if (!payload.allowMultipleAnswers && correctCount > 1) {
      validationErrors.push("only one option may be marked correct unless allowMultipleAnswers is set");
    }
  }

  return validationErrors;
}

function validateSubjectivePayload(payload) {
  const validationErrors = [];

  if (!payload.title || typeof payload.title !== "string" || !payload.title.trim()) {
    validationErrors.push("title is required");
  }
  if (!payload.description || typeof payload.description !== "string" || !payload.description.trim()) {
    validationErrors.push("description is required");
  }
  if (!payload.difficulty || !["Easy", "Medium", "Hard"].includes(payload.difficulty)) {
    validationErrors.push("difficulty must be Easy, Medium, or Hard");
  }
  if (payload.maxWords !== undefined && payload.maxWords !== null) {
    if (!Number.isFinite(Number(payload.maxWords)) || Number(payload.maxWords) < 1) {
      validationErrors.push("maxWords must be a positive number");
    }
  }

  return validationErrors;
}

function parsePagination(query) {
  const page = Math.max(1, Number(query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(query.limit || 50)));
  const options = {
    limit: limit,
    skip: (page - 1) * limit
  };
  return options;
}

function buildProblemFilter(query) {
  const filter = {};
  if (query.difficulty) filter.difficulty = query.difficulty;
  
  if (query.tag) {
    const tags = Array.isArray(query.tag) 
      ? query.tag 
      : query.tag.split(',').map(t => t.trim()).filter(Boolean);
    if (tags.length > 0) {
      filter.tags = { $in: tags };
    }
  }

  if (query.search) {
    filter.title = { $regex: escapeRegex(query.search), $options: 'i' };
  }
  
  return filter;
}

export async function listProblems(query = {}, user = null) {
  const filter = buildProblemFilter(query);
  const options = parsePagination(query);
  const problems = await problemsRepo.findAllWithoutTests(filter, options);

  // Phase 2: isPremium was previously set on Problem but never consumed anywhere —
  // this is what wires it to the college's plan. Privileged roles always see
  // everything (they're managing the content, not consuming it as a student would).
  if (isPrivilegedRole(user && user.role)) {
    return problems.map((p) => ({ ...(typeof p.toObject === "function" ? p.toObject() : p), locked: false }));
  }

  const allowsPremium = await collegeAllowsPremium(user && user.collegeId);
  return problems.map((p) => {
    const problem = typeof p.toObject === "function" ? p.toObject() : { ...p };
    return { ...problem, locked: Boolean(problem.isPremium) && !allowsPremium };
  });
}

export async function getProblemById(id, user = null) {
  const problem = await problemsRepo.findById(id);
  if (!problem) return null;

  if (isPrivilegedRole(user && user.role)) {
    return { ...(typeof problem.toObject === "function" ? problem.toObject() : problem), locked: false };
  }

  const sanitized = sanitizeProblemForStudent(problem);
  const allowsPremium = await collegeAllowsPremium(user && user.collegeId);
  return { ...sanitized, locked: Boolean(problem.isPremium) && !allowsPremium };
}

export async function getProblemStats(problemId) {
  const totalSubmissions = await Submission.countDocuments({ problemId });
  const acceptedSubmissions = await Submission.countDocuments({ problemId, status: "Success" });
  
  const successSubmissions = await Submission.find({ problemId, status: "Success" });
  
  let totalTime = 0;
  let countWithTime = 0;
  
  successSubmissions.forEach(s => {
    let elapsed = null;
    if (s.testResult && typeof s.testResult === 'object') {
      elapsed = s.testResult.elapsedMs ?? s.testResult.totalTimeMs;
    } else if (s.output) {
      try {
        const parsed = JSON.parse(s.output);
        elapsed = parsed.elapsedMs ?? parsed.totalTimeMs;
      } catch { /* ignore */ }
    }
    
    if (elapsed !== null && typeof elapsed === 'number') {
      totalTime += elapsed;
      countWithTime++;
    }
  });

  return {
    problemId,
    totalSubmissions,
    acceptedSubmissions,
    acceptanceRate: totalSubmissions > 0 ? (acceptedSubmissions / totalSubmissions) * 100 : 0,
    averageRuntimeMs: countWithTime > 0 ? totalTime / countWithTime : null
  };
}

// mcq/subjective skip both the coding-specific structural check and the deep
// judge-based validation (schema/types/wrapper-generation/reference-solution run) —
// there's no code to compile or run for either type.
function structuralValidatorFor(problemType) {
  if (problemType === "mcq") return validateMcqPayload;
  if (problemType === "subjective") return validateSubjectivePayload;
  return validateProblemPayload;
}

export async function createProblem(payload) {
  const normalizedPayload = normalizeProblemPayload(payload);
  const problemType = normalizedPayload.problemType || "function";
  const validationErrors = structuralValidatorFor(problemType)(normalizedPayload);
  if (validationErrors.length > 0) {
    throw new HttpError(400, "Validation failed", {
      error: validationErrors.join(", "),
      errors: validationErrors
    });
  }

  if (problemType === "function") {
    // Mandatory deep validation (schema + types + wrappers + reference solution)
    const report = await validateProblemDefinition(normalizedPayload);
    if (!report.schemaValid || !report.typeValidation || !report.wrapperGeneration || !report.referenceSolutionPassed) {
      throw new HttpError(400, "Deep validation failed", {
        error: "Problem failed deep validation checks (schema, types, wrappers, or reference solution).",
        errors: report.errors
      });
    }
  }

  return problemsRepo.create(normalizedPayload);
}

export async function updateProblem(id, payload) {
  const normalizedPayload = normalizeProblemPayload(payload);
  const problemType = normalizedPayload.problemType || "function";
  const validationErrors = structuralValidatorFor(problemType)(normalizedPayload);
  if (validationErrors.length > 0) {
    throw new HttpError(400, "Validation failed", {
      error: validationErrors.join(", "),
      errors: validationErrors
    });
  }

  if (problemType === "function") {
    // Mandatory deep validation (schema + types + wrappers + reference solution)
    const report = await validateProblemDefinition(normalizedPayload);
    if (!report.schemaValid || !report.typeValidation || !report.wrapperGeneration || !report.referenceSolutionPassed) {
      throw new HttpError(400, "Deep validation failed", {
        error: "Problem failed deep validation checks (schema, types, wrappers, or reference solution).",
        errors: report.errors
      });
    }
  }

  return problemsRepo.updateById(id, normalizedPayload);
}

export async function deleteProblem(id) {
  return problemsRepo.deleteById(id);
}

export async function runProblem(id, payload) {
  const problem = await problemsRepo.findById(id);
  if (!problem) throw new HttpError(404, "Problem not found");

  const { code, language, customTests } = payload;
  const problemType = problem.problemType || "function";

  const judgeMsg = {
    schemaVersion: "1",
    submissionId: "run-" + Date.now(), // Ephemeral ID
    problemId: id,
    language: language,
    code: code,
    problemType,
    compareMode: problem.compareConfig?.mode || "STRUCTURAL",
    compareConfig: problem.compareConfig || {},
    tests: customTests || [] // Pass custom tests if provided
  };
  // functionName is only meaningful for the named-function problem model — sending
  // it unconditionally (as this used to) breaks stdin-type problems: with no
  // problemType in the message, the Go judge defaulted to function-mode and
  // rejected the request for missing functionName.
  if (problemType !== "stdin") {
    judgeMsg.functionName = problem.functionName;
  }

  // If custom tests were provided without expected values, try to fill expected
  // from the problem's sample test cases (match by inputs JSON) so the judge and UI
  // can show Expected Output even when the frontend omitted it.
  try {
    if (Array.isArray(judgeMsg.tests) && judgeMsg.tests.length > 0 && Array.isArray(problem.testCases) && problem.testCases.length > 0) {
      const fillMap = new Map();
      for (const tc of problem.testCases) {
        try {
          fillMap.set(JSON.stringify(tc.inputs), tc.expected);
        } catch {
          // ignore non-serializable
        }
      }
      judgeMsg.tests = judgeMsg.tests.map((t) => {
        if (t == null) return t;
        if (t.expected !== undefined && t.expected !== null) return t;
        try {
          const key = JSON.stringify(t.inputs);
          if (fillMap.has(key)) {
            t.expected = fillMap.get(key);
          }
        } catch {
          // ignore
        }
        return t;
      });
    }
  } catch (e) {
    // best-effort only; do not fail the run if merging fails
    console.warn('Failed to merge expected values into custom tests:', e && e.message ? e.message : e);
  }

  try {
    const response = await fetch(`${env.JUDGE_SERVICE_URL}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(judgeMsg)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new HttpError(response.status, "Judge service error: " + errorText);
    }

    const judgeResult = await response.json();
    if (judgeResult && Array.isArray(judgeResult.details)) {
      if (customTests && customTests.length > 0) {
        // For custom tests, everything is visible, just normalize field names
        judgeResult.details = judgeResult.details.map(detail => ({
          ...detail,
          inputs: detail.inputs ?? detail.input ?? detail.Input,
          expected: detail.expected ?? detail.Expected,
          output: detail.output ?? detail.Output,
          passed: detail.passed ?? detail.ok ?? detail.Passed ?? detail.Ok ?? false,
          ok: detail.passed ?? detail.ok ?? detail.Passed ?? detail.Ok ?? false,
          stdout: detail.stdout ?? detail.Stdout,
          stderr: detail.stderr ?? detail.Stderr,
          traceback: detail.traceback ?? detail.Traceback,
          timeMs: detail.timeMs ?? detail.TimeMs,
        }));
      } else {
        judgeResult.details = sanitizeResultDetails(judgeResult.details, problem.testCases, false); // runProblem is for practice
      }
    }
    return judgeResult;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error("Failed to connect to judge service:", err);
    throw new HttpError(500, "Failed to connect to judge service");
  }
}
