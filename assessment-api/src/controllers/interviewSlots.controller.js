import * as interviewSlotsService from "../services/interviewSlots.service.js";

export async function scheduleSlot(req, res, next) {
  try {
    const result = await interviewSlotsService.scheduleSlot(req.params.candidateId, req.body, req.user);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function rescheduleSlot(req, res, next) {
  try {
    const slot = await interviewSlotsService.rescheduleSlot(req.params._id, req.body, req.user);
    res.json(slot);
  } catch (err) {
    next(err);
  }
}

export async function cancelSlot(req, res, next) {
  try {
    const slot = await interviewSlotsService.cancelSlot(req.params._id, req.user);
    res.json(slot);
  } catch (err) {
    next(err);
  }
}

export async function completeSlot(req, res, next) {
  try {
    const slot = await interviewSlotsService.completeSlot(req.params._id, req.body.notes, req.user);
    res.json(slot);
  } catch (err) {
    next(err);
  }
}

export async function regenerateExternalLink(req, res, next) {
  try {
    const result = await interviewSlotsService.regenerateExternalLink(req.params._id, req.user);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function listSlotsForDrive(req, res, next) {
  try {
    const slots = await interviewSlotsService.listSlotsForDrive(req.params.driveId, req.user);
    res.json(slots);
  } catch (err) {
    next(err);
  }
}

export async function listSlotsForCandidate(req, res, next) {
  try {
    const slots = await interviewSlotsService.listSlotsForCandidate(req.params.candidateId, req.user);
    res.json(slots);
  } catch (err) {
    next(err);
  }
}

export async function getMySlots(req, res, next) {
  try {
    const slots = await interviewSlotsService.getMySlots(req.user);
    res.json(slots);
  } catch (err) {
    next(err);
  }
}

export async function getSlotById(req, res, next) {
  try {
    const slot = await interviewSlotsService.getSlotById(req.params._id, req.user);
    res.json(slot);
  } catch (err) {
    next(err);
  }
}

export async function getSlotByToken(req, res, next) {
  try {
    const slot = await interviewSlotsService.getSlotByToken(req.params.token);
    res.json(slot);
  } catch (err) {
    next(err);
  }
}

export async function submitScorecard(req, res, next) {
  try {
    const slot = await interviewSlotsService.submitScorecard(req.params._id, req.body, req.user);
    res.json(slot);
  } catch (err) {
    next(err);
  }
}

export async function submitScorecardByToken(req, res, next) {
  try {
    const slot = await interviewSlotsService.submitScorecardByToken(req.params.token, req.body);
    res.json(slot);
  } catch (err) {
    next(err);
  }
}
