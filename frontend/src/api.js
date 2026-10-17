import axios from "axios";

export function resolveBaseUrl() {
  const raw = import.meta.env.VITE_API_URL;
  if (!raw) return "";

  // If a Docker-internal host leaks to browser config, fallback to same-origin proxy.
  if (typeof window !== "undefined" && raw.includes("assessment-api")) {
    return "";
  }

  return raw;
}

// H8: auth now travels via an httpOnly cookie set by the backend (login/register/signup),
// not a JS-readable token in localStorage/an Authorization header - withCredentials sends
// it automatically. The X-Requested-With header is the backend's lightweight CSRF check
// (a bare cross-site HTML form can't set custom headers, but this axios instance always does).
const api = axios.create({
  baseURL: resolveBaseUrl(),
  withCredentials: true,
  headers: {
    "X-Requested-With": "XMLHttpRequest"
  }
});

// Add a response interceptor to handle 401 errors
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response && error.response.status === 401) {
      // If we get a 401, clear the cached user and notify the app. The auth cookie itself
      // is httpOnly - only the backend can clear it (see auth.logout below).
      localStorage.removeItem("user");
      window.dispatchEvent(new Event("auth-change"));
    }
    return Promise.reject(error);
  }
);

export const auth = {
  logout: () => api.post("/api/v1/auth/logout")
};

export const assessments = {
  list: (params) => api.get("/api/v1/assessments", { params }),
  get: (id) => api.get(`/api/v1/assessments/${id}`),
  getMyAttempt: (id) => api.get(`/api/v1/assessments/${id}/my-attempt`),
  create: (data) => api.post("/api/v1/assessments", data),
  update: (id, data) => api.put(`/api/v1/assessments/${id}`, data),
  delete: (id) => api.delete(`/api/v1/assessments/${id}`),
  start: (id) => api.post(`/api/v1/assessments/${id}/start`),
  submitAttempt: (attemptId) => api.post(`/api/v1/assessments/attempts/${attemptId}/submit`),
  getAttempt: (attemptId) => api.get(`/api/v1/assessments/attempts/${attemptId}`),
  getAttemptSubmissions: (attemptId) => api.get(`/api/v1/assessments/attempts/${attemptId}/submissions`),
  listAttempts: (assessmentId) => api.get(`/api/v1/assessments/${assessmentId}/attempts`),
  getAttendance: (id) => api.get(`/api/v1/assessments/${id}/attendance`),
  getAnalytics: (id) => api.get(`/api/v1/assessments/${id}/analytics`),
  saveDraft: (attemptId, codeDrafts) => api.post(`/api/v1/assessments/attempts/${attemptId}/draft`, { codeDrafts }),
  lock: (id) => api.post(`/api/v1/assessments/${id}/lock`),
  unlock: (id) => api.post(`/api/v1/assessments/${id}/unlock`),
  addGraceTime: (attemptId, graceMinutes) => api.post(`/api/v1/assessments/attempts/${attemptId}/grace`, { graceMinutes }),
  logEvent: (attemptId, eventType) => api.post(`/api/v1/assessments/attempts/${attemptId}/log-event`, { eventType }),
  raiseChallenge: (attemptId, reason) => api.post(`/api/v1/assessments/attempts/${attemptId}/challenge`, { reason }),
  resolveChallenge: (attemptId, status, facultyComment) => api.post(`/api/v1/assessments/attempts/${attemptId}/challenge/resolve`, { status, facultyComment })
};

export const problems = {
  list: (params) => api.get("/api/v1/problems", { params }),
  get: (id) => api.get(`/api/v1/problems/${id}`),
  run: (id, data) => api.post(`/api/v1/problems/${id}/run`, data),
  getStats: (id) => api.get(`/api/v1/problems/${id}/stats`),
  delete: (id) => api.delete(`/api/v1/problems/${id}`)
};

export const submissions = {
  getAnalytics: () => api.get('/api/v1/submissions/analytics/my'),
  listUngraded: (assessmentId) => api.get(`/api/v1/submissions/assessment/${assessmentId}/ungraded`),
  grade: (submissionId, data) => api.post(`/api/v1/submissions/${submissionId}/grade`, data)
};

export const admin = {
  getSystemStats: () => api.get("/api/v1/admin/system-stats"),
  getAuditLogs: (params) => api.get("/api/v1/admin/audit-logs", { params }),
  bulkImportStudents: (data) => api.post("/api/v1/admin/bulk-import-students", data),
  listUsers: (params) => api.get("/api/v1/admin/users", { params }),
  createUser: (data) => api.post("/api/v1/admin/users", data),
  deleteUser: (userId) => api.delete(`/api/v1/admin/users/${userId}`),
  resetPassword: (userId, newPassword) => api.post(`/api/v1/admin/users/${userId}/reset-password`, { newPassword }),
  updateBanner: (data) => api.post("/api/v1/admin/banner", data),
  downloadBackup: () => api.get("/api/v1/admin/backup", { responseType: 'blob' }),
  restoreDatabase: (data) => api.post("/api/v1/admin/restore", data)
};

export const system = {
  getBanner: () => api.get("/api/v1/health/banner")
};

export const questions = {
  list: (params) => api.get("/api/v1/questions", { params }),
  tags: () => api.get("/api/v1/questions/tags"),
  get: (id) => api.get(`/api/v1/questions/${id}`),
  create: (data) => api.post("/api/v1/questions", data),
  update: (id, data) => api.put(`/api/v1/questions/${id}`, data),
  delete: (id) => api.delete(`/api/v1/questions/${id}`)
};

export const drives = {
  list: (params) => api.get("/api/v1/drives", { params }),
  get: (id) => api.get(`/api/v1/drives/${id}`),
  create: (data) => api.post("/api/v1/drives", data),
  update: (id, data) => api.put(`/api/v1/drives/${id}`, data),
  delete: (id) => api.delete(`/api/v1/drives/${id}`),
  enrollStudents: (id, studentIds) => api.post(`/api/v1/drives/${id}/candidates`, { studentIds }),
  enrollEligible: (id) => api.post(`/api/v1/drives/${id}/candidates/auto-enroll`),
  listCandidates: (id, params) => api.get(`/api/v1/drives/${id}/candidates`, { params }),
  getMyCandidacy: (id) => api.get(`/api/v1/drives/${id}/my-candidacy`),
  recordResult: (candidateId, result, notes, link) => api.post(`/api/v1/drives/candidates/${candidateId}/result`, { result, notes, link }),
  advance: (candidateId) => api.post(`/api/v1/drives/candidates/${candidateId}/advance`),
  reject: (candidateId, reason) => api.post(`/api/v1/drives/candidates/${candidateId}/reject`, { reason }),
  withdraw: (candidateId) => api.post(`/api/v1/drives/candidates/${candidateId}/withdraw`)
};

export const interviewSlots = {
  schedule: (candidateId, data) => api.post(`/api/v1/interview-slots/candidate/${candidateId}`, data),
  listForCandidate: (candidateId) => api.get(`/api/v1/interview-slots/candidate/${candidateId}`),
  listForDrive: (driveId) => api.get(`/api/v1/interview-slots/drive/${driveId}`),
  my: () => api.get('/api/v1/interview-slots/my'),
  get: (id) => api.get(`/api/v1/interview-slots/${id}`),
  reschedule: (id, data) => api.put(`/api/v1/interview-slots/${id}`, data),
  cancel: (id) => api.post(`/api/v1/interview-slots/${id}/cancel`),
  complete: (id, notes) => api.post(`/api/v1/interview-slots/${id}/complete`, { notes }),
  regenerateLink: (id) => api.post(`/api/v1/interview-slots/${id}/regenerate-link`),
  getByToken: (token) => api.get(`/api/v1/interview-slots/external/${token}`),
  submitScorecard: (id, data) => api.post(`/api/v1/interview-slots/${id}/scorecard`, data),
  submitScorecardByToken: (token, data) => api.post(`/api/v1/interview-slots/external/${token}/scorecard`, data)
};

export const billing = {
  getStatus: () => api.get("/api/v1/billing/status"),
  createCheckout: (planId) => api.post("/api/v1/billing/checkout", { planId }),
  createPortal: () => api.post("/api/v1/billing/portal"),
  listColleges: () => api.get("/api/v1/billing/colleges"),
  setCollegePlan: (collegeId, data) => api.patch(`/api/v1/billing/colleges/${collegeId}/plan`, data)
};

export default api;
