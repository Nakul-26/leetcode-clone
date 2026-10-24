import * as submissionsService from "../services/submissions.service.js";

export async function submitSolution(req, res, next) {
  const { problemId, code, language, selectedOptions, answerText, assessmentId, attemptId } = req.body;
  const userId = req.user && req.user._id;

  try {
    if (!userId) {
      return res.status(401).json({ msg: "Unauthorized" });
    }

    const result = await submissionsService.submitSolution({
      problemId,
      code,
      language,
      selectedOptions,
      answerText,
      userId,
      collegeId: req.user && req.user.collegeId,
      assessmentId,
      attemptId,
      requestId: req.id,
      // Attribution when this came in through an external API key rather than the
      // frontend. Undefined for browser traffic and for legacy shared-secret callers.
      apiClientId: req.apiClient ? req.apiClient._id : undefined,
      // Set by the students' own submit route only. /integration shares this controller,
      // and its callers (like Arventiq) may score partial passes, so they get every test.
      stopOnFirstFailure: req.stopOnFirstFailure === true && !req.apiClient
    });
    if (result.notFound) {
      return res.status(404).json({ msg: "Problem not found" });
    }
    res.status(202).json(result.submission);
  } catch (err) {
    if (err.status && err.body) {
      return res.status(err.status).json(err.body);
    }
    next(err);
  }
}

export async function getSubmissionById(req, res, next) {
  const { _id } = req.params;
  const userId = req.user && req.user._id;
  const role = req.user && req.user.role;
  const collegeId = req.user && req.user.collegeId;

  try {
    const result = await submissionsService.getSubmissionById(_id, { userId, role, collegeId });
    if (result.notFound) {
      return res.status(404).json({ msg: "Submission not found" });
    }
    if (result.forbidden) {
      return res.status(403).json({ msg: "Forbidden" });
    }
    res.json(result.submission);
  } catch (err) {
    next(err);
  }
}

export async function getMySubmissions(req, res, next) {
  const userId = req.user && req.user._id;

  try {
    if (!userId) {
      return res.status(401).json({ msg: "Unauthorized" });
    }

    const result = await submissionsService.getMySubmissions(userId, req.query);
    res.json(result.submissions);
  } catch (err) {
    next(err);
  }
}

export async function getMyAnalytics(req, res, next) {
  const userId = req.user && req.user._id;

  try {
    if (!userId) {
      return res.status(401).json({ msg: "Unauthorized" });
    }

    const result = await submissionsService.getMyAnalytics(userId);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function listUngradedSubjectiveSubmissions(req, res, next) {
  const { assessmentId } = req.params;

  try {
    const result = await submissionsService.listUngradedSubjectiveSubmissions(assessmentId, req.user);
    res.json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json(err.body || { msg: err.message });
    }
    next(err);
  }
}

export async function gradeSubjectiveSubmission(req, res, next) {
  const { _id } = req.params;
  const { score, feedback } = req.body;

  try {
    const result = await submissionsService.gradeSubjectiveSubmission(_id, { score, feedback }, req.user);
    res.json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json(err.body || { msg: err.message });
    }
    next(err);
  }
}
