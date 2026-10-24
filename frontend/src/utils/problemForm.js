import { isValidType } from "./typeValidator";

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function addError(errors, key, message) {
  if (!errors[key]) {
    errors[key] = message;
  }
}

function normalizeParameters(parameters = [], errors) {
  const normalized = parameters.map((parameter = {}) => ({
    name: String(parameter.name || "").trim(),
    type: String(parameter.type || "").trim()
  }));

  const nonEmpty = normalized.filter((parameter) => parameter.name || parameter.type);
  if (nonEmpty.length === 0) {
    addError(errors, "parameters", "At least one parameter is required");
    return [];
  }

  nonEmpty.forEach((parameter, index) => {
    if (!parameter.name) {
      addError(errors, `parameters.${index}.name`, "Parameter name is required");
    } else if (!IDENTIFIER_PATTERN.test(parameter.name)) {
      addError(errors, `parameters.${index}.name`, "Parameter name must be a valid identifier");
    }

    if (!parameter.type) {
      addError(errors, `parameters.${index}.type`, "Parameter type is required");
    } else if (!isValidType(parameter.type)) {
      addError(errors, `parameters.${index}.type`, `Invalid type: ${parameter.type}`);
    }
  });

  return nonEmpty;
}

function normalizeExpectedValue(rawValue) {
  const value = String(rawValue ?? "");
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeTestCases(testCases = [], parameterCount, errors) {
  if (testCases.length === 0) {
    addError(errors, "testCases", "At least one test case is required");
    return [];
  }

  let hasSample = false;
  const parsed = [];

  testCases.forEach((testCase = {}, index) => {
    const inputsKey = `testCases.${index}.inputs`;
    const rowKey = `testCases.${index}`;
    const rawInputs = String(testCase.inputs ?? "").trim();
    let parsedInputs;

    try {
      parsedInputs = JSON.parse(rawInputs);
    } catch {
      addError(errors, inputsKey, "Inputs must be a valid JSON array");
      return;
    }

    if (!Array.isArray(parsedInputs)) {
      addError(errors, inputsKey, "Inputs must be a JSON array");
      return;
    }

    if (parsedInputs.length !== parameterCount) {
      addError(errors, rowKey, `Expected ${parameterCount} input(s) but got ${parsedInputs.length}`);
    }

    if (testCase.isSample) {
      hasSample = true;
    }

    parsed.push({
      inputs: parsedInputs,
      expected: normalizeExpectedValue(testCase.expected),
      isSample: !!testCase.isSample
    });
  });

  if (!hasSample) {
    addError(errors, "testCases", "At least one sample test case is required");
  }

  return parsed;
}

export function buildProblemPayload(formData) {
  const errors = {};
  const title = String(formData.title || "").trim();
  const description = String(formData.description || "").trim();
  const functionName = String(formData.functionName || "").trim();
  const returnType = String(formData.returnType || "").trim();

  if (!title) addError(errors, "title", "Title is required");
  if (!description) addError(errors, "description", "Description is required");
  if (!functionName) {
    addError(errors, "functionName", "Function name is required");
  } else if (!IDENTIFIER_PATTERN.test(functionName)) {
    addError(errors, "functionName", "Function name must be a valid identifier");
  }
  
  if (!returnType) {
    addError(errors, "returnType", "Return type is required");
  } else if (!isValidType(returnType)) {
    addError(errors, "returnType", `Invalid return type: ${returnType}`);
  }

  if (!formData.referenceSolution || !formData.referenceSolution.trim()) {
    addError(errors, "referenceSolution", "Reference solution is required for certification");
  }

  if (!formData.solutionLanguage) {
    addError(errors, "solutionLanguage", "Solution language is required for certification");
  }

  const parameters = normalizeParameters(formData.parameters || [], errors);
  const testCases = normalizeTestCases(formData.testCases || [], parameters.length, errors);

  if (Object.keys(errors).length > 0) {
    return { errors };
  }

  return {
    errors: {},
    payload: {
      title,
      description,
      difficulty: formData.difficulty,
      functionName,
      parameters,
      returnType,
      compareConfig: {
        mode: formData.compareConfig?.mode || "EXACT",
        floatTolerance: Number(formData.compareConfig?.floatTolerance) || 0,
        orderInsensitive: !!formData.compareConfig?.orderInsensitive
      },
      testCases,
      referenceSolution: formData.referenceSolution,
      solutionLanguage: formData.solutionLanguage,
      tags: String(formData.tags || "")
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      isPremium: !!formData.isPremium
    }
  };
}

export function buildMcqPayload(formData) {
  const errors = {};
  const title = String(formData.title || "").trim();
  const description = String(formData.description || "").trim();

  if (!title) addError(errors, "title", "Title is required");
  if (!description) addError(errors, "description", "Description is required");

  const rawOptions = formData.options || [];
  const options = rawOptions
    .map((o = {}) => ({ text: String(o.text || "").trim(), isCorrect: !!o.isCorrect }))
    .filter((o) => o.text);

  if (options.length < 2) {
    addError(errors, "options", "At least 2 options are required");
  } else {
    const correctCount = options.filter((o) => o.isCorrect).length;
    if (correctCount === 0) {
      addError(errors, "options", "Mark at least one option as correct");
    } else if (!formData.allowMultipleAnswers && correctCount > 1) {
      addError(errors, "options", "Only one option may be marked correct unless multiple answers are allowed");
    }
  }

  if (Object.keys(errors).length > 0) {
    return { errors };
  }

  return {
    errors: {},
    payload: {
      title,
      description,
      difficulty: formData.difficulty,
      problemType: "mcq",
      options,
      allowMultipleAnswers: !!formData.allowMultipleAnswers,
      tags: String(formData.tags || "")
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      isPremium: !!formData.isPremium
    }
  };
}

export function buildSubjectivePayload(formData) {
  const errors = {};
  const title = String(formData.title || "").trim();
  const description = String(formData.description || "").trim();

  if (!title) addError(errors, "title", "Title is required");
  if (!description) addError(errors, "description", "Description is required");

  const maxWords = formData.maxWords === "" || formData.maxWords === undefined ? undefined : Number(formData.maxWords);
  if (maxWords !== undefined && (!Number.isFinite(maxWords) || maxWords < 1)) {
    addError(errors, "maxWords", "Max words must be a positive number");
  }

  if (Object.keys(errors).length > 0) {
    return { errors };
  }

  return {
    errors: {},
    payload: {
      title,
      description,
      difficulty: formData.difficulty,
      problemType: "subjective",
      ...(maxWords !== undefined ? { maxWords } : {}),
      rubricNotes: String(formData.rubricNotes || "").trim(),
      tags: String(formData.tags || "")
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      isPremium: !!formData.isPremium
    }
  };
}

export function collectErrorMessages(errors = {}) {
  return Object.values(errors);
}

// ---------------------------------------------------------------------------
// Stdin problems and reference-computed expected outputs (JUDGE_FIX_PLAN Phase 6)
// ---------------------------------------------------------------------------

export const isCodingType = (problemType) => problemType === "function" || problemType === "stdin";

// A stored test case as the editor's strings. Stdin input/output are raw text; function ones JSON.
export function toFormTestCase(problemType, tc = {}) {
  if (problemType === "stdin") {
    return {
      inputs: String(Array.isArray(tc.inputs) ? (tc.inputs[0] ?? "") : (tc.inputs ?? "")),
      expected: typeof tc.expected === "string" ? tc.expected : String(tc.expected ?? ""),
      isSample: typeof tc.isSample === "boolean" ? tc.isSample : !tc.isHidden
    };
  }
  return {
    inputs: JSON.stringify(tc.inputs ?? []),
    expected: typeof tc.expected === "string" ? tc.expected : JSON.stringify(tc.expected ?? null),
    isSample: typeof tc.isSample === "boolean" ? tc.isSample : !tc.isHidden
  };
}

// How a reference output is written into the expected field.
export function formatOutput(problemType, output) {
  if (problemType === "stdin") return String(output ?? "");
  return JSON.stringify(output ?? null);
}

// True when the field already holds exactly what the reference produced.
export function sameAsOutput(problemType, expectedText, output) {
  if (problemType === "stdin") return String(expectedText ?? "") === String(output ?? "");
  try {
    return JSON.stringify(JSON.parse(String(expectedText))) === JSON.stringify(output ?? null);
  } catch {
    return false;
  }
}

/**
 * The draft sent to POST /problems/reference-outputs. Test cases whose input does not parse are
 * left out, and `indexes` maps each sent case back to its row in the form.
 */
export function buildReferenceDraft(formData) {
  const problemType = formData.problemType;
  const indexes = [];
  const testCases = [];
  (formData.testCases || []).forEach((tc, i) => {
    let inputs;
    if (problemType === "stdin") {
      inputs = [String(tc.inputs ?? "")];
    } else {
      try {
        inputs = JSON.parse(String(tc.inputs ?? "").trim());
      } catch {
        return;
      }
      if (!Array.isArray(inputs)) return;
    }
    const expectedText = String(tc.expected ?? "");
    const hasExpected = problemType === "stdin" ? expectedText !== "" : expectedText.trim() !== "";
    testCases.push({ inputs, isSample: !!tc.isSample, ...(hasExpected ? { expected: problemType === "stdin" ? expectedText : normalizeExpectedValue(expectedText) } : {}) });
    indexes.push(i);
  });
  const draft = {
    problemType,
    title: formData.title || "Draft",
    description: formData.description || "Draft",
    difficulty: formData.difficulty || "Easy",
    referenceSolution: formData.referenceSolution,
    solutionLanguage: formData.solutionLanguage,
    compareConfig: formData.compareConfig,
    testCases
  };
  if (problemType === "function") {
    draft.functionName = String(formData.functionName || "").trim();
    draft.returnType = String(formData.returnType || "").trim();
    draft.parameters = (formData.parameters || []).filter((p) => p.name || p.type);
  }
  return { draft, indexes };
}

/**
 * Many test inputs pasted at once (JUDGE_FIX_PLAN P10). Function problems: one JSON array of
 * arguments per line. Stdin problems: blocks of input separated by a line containing only ---.
 * Either may carry an expected output after a tab, which is what copying two columns out of a
 * spreadsheet produces (input, then expected). Returns form rows (strings).
 */
export function parseBulkTests(problemType, text) {
  const raw = String(text ?? "").replace(/\r\n/g, "\n");
  const rows = [];
  if (problemType === "stdin") {
    for (const block of raw.split(/\n-{3,}\n/)) {
      if (!block.trim()) continue;
      const tab = block.indexOf("\t");
      const inputs = tab >= 0 ? block.slice(0, tab) : block;
      const expected = tab >= 0 ? block.slice(tab + 1) : "";
      rows.push({ inputs: inputs.endsWith("\n") ? inputs : inputs + "\n", expected, isSample: false });
    }
    return rows;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [inputs, expected = ""] = line.split("\t");
    rows.push({ inputs: inputs.trim(), expected: expected.trim(), isSample: false });
  }
  return rows;
}

export function buildStdinPayload(formData) {
  const errors = {};
  const title = String(formData.title || "").trim();
  const description = String(formData.description || "").trim();
  if (!title) addError(errors, "title", "Title is required");
  if (!description) addError(errors, "description", "Description is required");
  if (!formData.referenceSolution || !formData.referenceSolution.trim()) {
    addError(errors, "referenceSolution", "A reference solution is required: expected outputs are checked against it");
  }
  if (!formData.solutionLanguage) addError(errors, "solutionLanguage", "Solution language is required");

  const testCases = (formData.testCases || []).map((tc, i) => {
    const expected = String(tc.expected ?? "");
    if (expected === "") addError(errors, `testCases.${i}`, `Test case ${i + 1} has no expected output (use Generate expected outputs)`);
    return { inputs: [String(tc.inputs ?? "")], expected, isSample: !!tc.isSample };
  });
  if (testCases.length === 0) addError(errors, "testCases", "At least one test case is required");
  else if (!testCases.some((tc) => tc.isSample)) addError(errors, "testCases", "At least one sample test case is required");

  if (Object.keys(errors).length > 0) return { errors };
  return {
    errors: {},
    payload: {
      title,
      description,
      difficulty: formData.difficulty,
      problemType: "stdin",
      ...(String(formData.inputFormat || "").trim() ? { inputFormat: String(formData.inputFormat).trim() } : {}),
      ...(String(formData.outputFormat || "").trim() ? { outputFormat: String(formData.outputFormat).trim() } : {}),
      testCases,
      referenceSolution: formData.referenceSolution,
      solutionLanguage: formData.solutionLanguage,
      tags: String(formData.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean),
      isPremium: !!formData.isPremium
    }
  };
}
