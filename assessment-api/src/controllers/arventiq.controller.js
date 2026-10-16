import * as arventiqService from "../services/arventiq.service.js";

export async function syncProblem(req, res, next) {
  try {
    const problem = await arventiqService.syncProblem(req.body);
    res.status(200).json({
      success: true,
      problemId: problem._id.toString(),
      externalId: problem.externalId
    });
  } catch (err) {
    if (err.status && err.body) {
      return res.status(err.status).json({ success: false, ...err.body });
    }
    next(err);
  }
}

export async function submitSolution(req, res, next) {
  const userId = req.user && (req.user._id || req.user.id);
  const { questionId, code, codeLanguage, externalStudentId, externalAssessmentId } = req.body;

  try {
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const submission = await arventiqService.submitArventiqSolution({
      userId,
      questionId,
      code,
      codeLanguage,
      externalStudentId,
      externalAssessmentId,
      requestId: req.id,
      // Attribution for per-customer metering (plan Phase 1); undefined when the
      // caller is still using the legacy global ARVENTIQ_SECRET.
      apiClientId: req.apiClient ? req.apiClient._id : undefined
    });

    res.status(202).json({
      success: true,
      submissionId: submission._id.toString(),
      status: "pending"
    });
  } catch (err) {
    if (err.status && err.body) {
      return res.status(err.status).json({ success: false, ...err.body });
    }
    if (err.status) {
      return res.status(err.status).json({ success: false, message: err.message });
    }
    next(err);
  }
}

export async function runCode(req, res, next) {
  const { questionId, code, codeLanguage, customInput } = req.body;

  try {
    const result = await arventiqService.runArventiqCode({ questionId, code, codeLanguage, customInput });
    res.status(200).json(result);
  } catch (err) {
    if (err.status && err.body) {
      return res.status(err.status).json({ success: false, ...err.body });
    }
    if (err.status) {
      return res.status(err.status).json({ success: false, message: err.message });
    }
    next(err);
  }
}

export async function getSubmissionResult(req, res, next) {
  const { _id } = req.params;
  const userId = req.user && (req.user._id || req.user.id);
  const role = req.user && req.user.role;

  try {
    const result = await arventiqService.getArventiqSubmissionResult(_id, { userId, role });
    if (result.notFound) {
      return res.status(404).json({ success: false, message: "Submission not found" });
    }
    if (result.forbidden) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    if (result.pending) {
      return res.status(202).json({ success: true, status: "pending" });
    }
    res.status(200).json(result.verdict);
  } catch (err) {
    next(err);
  }
}
