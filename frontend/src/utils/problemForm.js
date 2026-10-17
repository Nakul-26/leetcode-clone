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
