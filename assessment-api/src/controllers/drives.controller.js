import * as drivesService from "../services/drives.service.js";

export async function listDrives(req, res, next) {
  try {
    const drives = await drivesService.listDrives(req.query, req.user);
    res.json(drives);
  } catch (err) {
    next(err);
  }
}

export async function getDriveById(req, res, next) {
  try {
    const drive = await drivesService.getDriveById(req.params._id, req.user);
    if (!drive) return res.status(404).json({ msg: "Drive not found" });
    res.json(drive);
  } catch (err) {
    next(err);
  }
}

export async function createDrive(req, res, next) {
  try {
    const drive = await drivesService.createDrive(req.body, req.user);
    res.status(201).json(drive);
  } catch (err) {
    next(err);
  }
}

export async function updateDrive(req, res, next) {
  try {
    const drive = await drivesService.updateDrive(req.params._id, req.body, req.user);
    res.json(drive);
  } catch (err) {
    next(err);
  }
}

export async function deleteDrive(req, res, next) {
  try {
    await drivesService.deleteDrive(req.params._id, req.user);
    res.json({ msg: "Drive deleted" });
  } catch (err) {
    next(err);
  }
}

export async function enrollStudents(req, res, next) {
  try {
    const result = await drivesService.enrollStudents(req.params._id, req.body.studentIds, req.user);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function enrollEligible(req, res, next) {
  try {
    const result = await drivesService.enrollEligible(req.params._id, req.user);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function listCandidates(req, res, next) {
  try {
    const candidates = await drivesService.listCandidates(req.params._id, req.user, req.query);
    res.json(candidates);
  } catch (err) {
    next(err);
  }
}

export async function getMyCandidacy(req, res, next) {
  try {
    const candidate = await drivesService.getMyCandidacy(req.params._id, req.user._id);
    res.json(candidate || null);
  } catch (err) {
    next(err);
  }
}

export async function recordRoundResult(req, res, next) {
  try {
    const { result, notes, link } = req.body;
    const candidate = await drivesService.recordRoundResult(req.params.candidateId, result, notes, link, req.user);
    res.json(candidate);
  } catch (err) {
    next(err);
  }
}

export async function advanceRound(req, res, next) {
  try {
    const candidate = await drivesService.advanceRound(req.params.candidateId, req.user);
    res.json(candidate);
  } catch (err) {
    next(err);
  }
}

export async function rejectCandidate(req, res, next) {
  try {
    const candidate = await drivesService.rejectCandidate(req.params.candidateId, req.body.reason, req.user);
    res.json(candidate);
  } catch (err) {
    next(err);
  }
}

export async function withdrawCandidate(req, res, next) {
  try {
    const candidate = await drivesService.withdrawCandidate(req.params.candidateId, req.user);
    res.json(candidate);
  } catch (err) {
    next(err);
  }
}
