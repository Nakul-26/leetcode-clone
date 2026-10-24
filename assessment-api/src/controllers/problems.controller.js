import * as problemsService from "../services/problems.service.js";

export async function listProblems(req, res, next) {
  try {
    const problems = await problemsService.listProblems(req.query || {}, req.user || null);
    res.json(problems);
  } catch (err) {
    next(err);
  }
}

export async function getProblemById(req, res, next) {
  try {
    const problem = await problemsService.getProblemById(req.params._id, req.user || null);
    if (!problem) {
      return res.status(404).json({ msg: "Problem not found" });
    }
    res.json(problem);
  } catch (err) {
    next(err);
  }
}

export async function getProblemStats(req, res, next) {
  try {
    const stats = await problemsService.getProblemStats(req.params._id);
    res.json(stats);
  } catch (err) {
    next(err);
  }
}

export async function computeReferenceOutputs(req, res, next) {
  try {
    res.json(await problemsService.computeReferenceOutputs({ ...req.body }));
  } catch (err) {
    if (err.status && err.body) {
      return res.status(err.status).json(err.body);
    }
    next(err);
  }
}

export async function createProblem(req, res, next) {
  try {
    const problem = await problemsService.createProblem({ ...req.body });
    res.status(201).json({ message: "Problem created successfully", problem: problem });
  } catch (err) {
    if (err.status && err.body) {
      return res.status(err.status).json(err.body);
    }
    next(err);
  }
}

export async function runProblem(req, res, next) {
  try {
    const result = await problemsService.runProblem(req.params._id, req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function deleteProblem(req, res, next) {
  try {
    const problem = await problemsService.deleteProblem(req.params._id);
    if (!problem) {
      return res.status(404).json({ msg: "Problem not found" });
    }
    res.json({ msg: "Problem removed" });
  } catch (err) {
    next(err);
  }
}

export async function updateProblem(req, res, next) {
  try {
    const updatedProblem = await problemsService.updateProblem(req.params._id, { ...req.body });
    if (!updatedProblem) {
      return res.status(404).json({ msg: "Problem not found" });
    }
    res.json({ message: "Problem updated successfully", problem: updatedProblem });
  } catch (err) {
    if (err.status && err.body) {
      return res.status(err.status).json(err.body);
    }
    next(err);
  }
}
