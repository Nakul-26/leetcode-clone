import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, UserPlus, Wand2, Check, X, ArrowRight, LogOut, CalendarPlus } from 'lucide-react';
import { drives, admin, interviewSlots } from '../api';
import { getApiErrorMessage } from '../utils/assessmentForm';

const COLUMNS = ['Applied', 'InProgress', 'RoundPassed', 'RoundFailed', 'Selected', 'Rejected', 'Withdrawn'];

const COLUMN_STYLES = {
  Applied: { color: 'var(--text-muted)', bg: 'rgba(255,255,255,0.05)' },
  InProgress: { color: 'var(--primary)', bg: 'rgba(99, 102, 241, 0.1)' },
  RoundPassed: { color: 'var(--success)', bg: 'rgba(16, 185, 129, 0.1)' },
  RoundFailed: { color: 'var(--error)', bg: 'rgba(239, 68, 68, 0.1)' },
  Selected: { color: 'var(--success)', bg: 'rgba(16, 185, 129, 0.15)' },
  Rejected: { color: 'var(--error)', bg: 'rgba(239, 68, 68, 0.1)' },
  Withdrawn: { color: 'var(--text-muted)', bg: 'rgba(255,255,255,0.05)' }
};

const DrivePipelinePage = () => {
  const { id } = useParams();
  const [drive, setDrive] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const [showEnroll, setShowEnroll] = useState(false);
  const [students, setStudents] = useState([]);
  const [studentSearch, setStudentSearch] = useState('');
  const [selectedStudentIds, setSelectedStudentIds] = useState(new Set());
  const [enrolling, setEnrolling] = useState(false);

  const [scheduleCandidate, setScheduleCandidate] = useState(null);
  const [staffList, setStaffList] = useState([]);
  const [scheduleForm, setScheduleForm] = useState(null);
  const [scheduling, setScheduling] = useState(false);
  const [scheduleError, setScheduleError] = useState(null);
  const [scheduleResult, setScheduleResult] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      const [driveRes, candidatesRes] = await Promise.all([
        drives.get(id),
        drives.listCandidates(id)
      ]);
      setDrive(driveRes.data);
      setCandidates(candidatesRes.data);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Failed to load pipeline'));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const openEnrollModal = async () => {
    setShowEnroll(true);
    try {
      const res = await admin.listUsers({ role: 'student', limit: 500 });
      setStudents(res.data.users);
    } catch (err) {
      alert(getApiErrorMessage(err, 'Failed to load students'));
    }
  };

  const toggleStudent = (studentId) => {
    const next = new Set(selectedStudentIds);
    if (next.has(studentId)) next.delete(studentId);
    else next.add(studentId);
    setSelectedStudentIds(next);
  };

  const handleEnrollSelected = async () => {
    if (selectedStudentIds.size === 0) return;
    setEnrolling(true);
    try {
      await drives.enrollStudents(id, Array.from(selectedStudentIds));
      setShowEnroll(false);
      setSelectedStudentIds(new Set());
      fetchData();
    } catch (err) {
      alert(getApiErrorMessage(err, 'Failed to enroll students'));
    } finally {
      setEnrolling(false);
    }
  };

  const handleAutoEnroll = async () => {
    if (!window.confirm('Auto-enroll all eligible students based on this drive\'s section filters?')) return;
    setEnrolling(true);
    try {
      const res = await drives.enrollEligible(id);
      alert(`Enrolled ${res.data.enrolled} student(s). Skipped ${res.data.skipped} (already enrolled).`);
      fetchData();
    } catch (err) {
      alert(getApiErrorMessage(err, 'Failed to auto-enroll students'));
    } finally {
      setEnrolling(false);
    }
  };

  const withAction = async (candidateId, fn) => {
    setBusyId(candidateId);
    try {
      await fn();
      fetchData();
    } catch (err) {
      alert(getApiErrorMessage(err, 'Action failed'));
    } finally {
      setBusyId(null);
    }
  };

  const recordResult = (candidateId, result) => {
    let notes = '';
    if (result === 'Fail') {
      notes = window.prompt('Optional notes for this failed round:') || '';
    }
    withAction(candidateId, () => drives.recordResult(candidateId, result, notes, ''));
  };

  const advance = (candidateId) => withAction(candidateId, () => drives.advance(candidateId));

  const reject = (candidateId) => {
    const reason = window.prompt('Reason for rejecting this candidate:') || '';
    withAction(candidateId, () => drives.reject(candidateId, reason));
  };

  const withdraw = (candidateId) => {
    if (!window.confirm('Mark this candidate as withdrawn?')) return;
    withAction(candidateId, () => drives.withdraw(candidateId));
  };

  const openScheduleModal = async (candidate) => {
    setScheduleCandidate(candidate);
    setScheduleError(null);
    setScheduleResult(null);
    setScheduleForm({
      mode: 'internal',
      interviewerId: '',
      externalName: '',
      externalEmail: '',
      scheduledAt: '',
      durationMinutes: 30,
      meetingLink: '',
      notes: ''
    });
    try {
      const res = await admin.listUsers({ role: 'faculty', limit: 200 });
      setStaffList(res.data.users);
    } catch {
      setStaffList([]);
    }
  };

  const closeScheduleModal = () => {
    setScheduleCandidate(null);
    setScheduleForm(null);
    setScheduleResult(null);
  };

  const submitSchedule = async (e) => {
    e.preventDefault();
    setScheduleError(null);
    setScheduling(true);
    try {
      const payload = {
        scheduledAt: new Date(scheduleForm.scheduledAt).toISOString(),
        durationMinutes: Number(scheduleForm.durationMinutes) || 30,
        meetingLink: scheduleForm.meetingLink || undefined,
        notes: scheduleForm.notes || undefined
      };
      if (scheduleForm.mode === 'internal') {
        payload.interviewerId = scheduleForm.interviewerId;
      } else {
        payload.externalInterviewerName = scheduleForm.externalName;
        payload.externalInterviewerEmail = scheduleForm.externalEmail;
      }
      const res = await interviewSlots.schedule(scheduleCandidate._id, payload);
      setScheduleResult(res.data);
    } catch (err) {
      setScheduleError(getApiErrorMessage(err, 'Failed to schedule interview'));
    } finally {
      setScheduling(false);
    }
  };

  if (loading) return <div className="container">Loading pipeline...</div>;
  if (error) return <div className="container error-box">{error}</div>;
  if (!drive) return null;

  const filteredStudents = students.filter((s) => {
    const q = studentSearch.toLowerCase();
    return !q || s.name?.toLowerCase().includes(q) || s.email?.toLowerCase().includes(q) || s.usn?.toLowerCase().includes(q);
  });

  const grouped = COLUMNS.reduce((acc, status) => {
    acc[status] = candidates.filter((c) => c.status === status);
    return acc;
  }, {});

  return (
    <div className="container fade-in">
      <Link to="/admin/drives" className="flex-center gap-2 text-muted mb-4" style={{ justifyContent: 'flex-start' }}>
        <ArrowLeft size={16} /> Back to Drives
      </Link>

      <div className="flex-between mb-8">
        <div>
          <h1 className="mb-2">{drive.companyName} — Pipeline</h1>
          <p className="text-muted">{candidates.length} candidate(s) across {drive.rounds.length} round(s).</p>
        </div>
        <div className="flex-center gap-3">
          <button className="button button-outline" onClick={handleAutoEnroll} disabled={enrolling}>
            <Wand2 size={16} /> Auto-Enroll Eligible
          </button>
          <button className="button" onClick={openEnrollModal}>
            <UserPlus size={16} /> Enroll Students
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '16px', overflowX: 'auto', paddingBottom: '12px' }}>
        {COLUMNS.map((status) => {
          const style = COLUMN_STYLES[status];
          return (
            <div key={status} style={{ minWidth: '280px', flex: '0 0 280px' }}>
              <div style={{
                padding: '8px 14px',
                borderRadius: 'var(--radius-lg)',
                color: style.color,
                backgroundColor: style.bg,
                fontWeight: 700,
                fontSize: '0.8rem',
                letterSpacing: '0.03em',
                marginBottom: '10px'
              }}>
                {status.toUpperCase()} ({grouped[status].length})
              </div>

              {grouped[status].map((c) => {
                const round = drive.rounds[c.currentRoundIndex];
                const isBusy = busyId === c._id;
                return (
                  <div key={c._id} className="problem-card" style={{ padding: '14px', marginBottom: '10px' }}>
                    <div style={{ fontWeight: 600 }}>{c.studentId?.name}</div>
                    <div className="text-muted" style={{ fontSize: '0.8rem', marginBottom: '8px' }}>
                      {c.studentId?.usn || c.studentId?.email} {c.studentId?.section ? `· ${c.studentId.section}` : ''}
                    </div>
                    <div className="text-muted" style={{ fontSize: '0.8rem', marginBottom: '10px' }}>
                      Round {c.currentRoundIndex + 1}: {round?.name || '—'}
                    </div>

                    <div className="flex-center gap-2" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
                      {['Applied', 'InProgress'].includes(c.status) && round?.type === 'interview' && (
                        <button className="button button-outline" style={{ padding: '4px 10px', fontSize: '0.8rem' }} disabled={isBusy} onClick={() => openScheduleModal(c)}>
                          <CalendarPlus size={14} /> Schedule Interview
                        </button>
                      )}
                      {['Applied', 'InProgress'].includes(c.status) && (
                        <>
                          <button className="button button-outline" style={{ padding: '4px 10px', fontSize: '0.8rem' }} disabled={isBusy} onClick={() => recordResult(c._id, 'Pass')}>
                            <Check size={14} /> Pass
                          </button>
                          <button className="button button-outline" style={{ padding: '4px 10px', fontSize: '0.8rem', color: 'var(--error)' }} disabled={isBusy} onClick={() => recordResult(c._id, 'Fail')}>
                            <X size={14} /> Fail
                          </button>
                        </>
                      )}
                      {c.status === 'RoundPassed' && (
                        <button className="button button-outline" style={{ padding: '4px 10px', fontSize: '0.8rem' }} disabled={isBusy} onClick={() => advance(c._id)}>
                          <ArrowRight size={14} /> Advance
                        </button>
                      )}
                      {!['Selected', 'Rejected', 'Withdrawn'].includes(c.status) && (
                        <>
                          <button className="button button-outline" style={{ padding: '4px 10px', fontSize: '0.8rem', color: 'var(--error)' }} disabled={isBusy} onClick={() => reject(c._id)}>
                            Reject
                          </button>
                          <button className="button button-outline" style={{ padding: '4px 10px', fontSize: '0.8rem' }} disabled={isBusy} onClick={() => withdraw(c._id)}>
                            <LogOut size={14} /> Withdraw
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
              {grouped[status].length === 0 && (
                <div className="text-muted" style={{ fontSize: '0.8rem', padding: '12px', textAlign: 'center' }}>No candidates</div>
              )}
            </div>
          );
        })}
      </div>

      {showEnroll && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div className="problem-card" style={{ width: '560px', maxHeight: '80vh', overflowY: 'auto', padding: '24px' }}>
            <h3 className="mb-4">Enroll Students</h3>
            <input
              type="text"
              placeholder="Search by name, email, or USN..."
              value={studentSearch}
              onChange={(e) => setStudentSearch(e.target.value)}
              style={{ width: '100%', marginBottom: '12px' }}
            />
            <div style={{ maxHeight: '320px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '8px' }}>
              {filteredStudents.map((s) => (
                <label key={s._id} className="flex-center gap-2" style={{ justifyContent: 'flex-start', padding: '6px 4px', cursor: 'pointer' }}>
                  <input type="checkbox" checked={selectedStudentIds.has(s._id)} onChange={() => toggleStudent(s._id)} />
                  <span>{s.name} <span className="text-muted">({s.usn || s.email}{s.section ? `, ${s.section}` : ''})</span></span>
                </label>
              ))}
              {filteredStudents.length === 0 && <div className="text-muted" style={{ padding: '12px' }}>No students found.</div>}
            </div>
            <div className="flex-between mt-4">
              <span className="text-muted">{selectedStudentIds.size} selected</span>
              <div className="flex-center gap-3">
                <button className="button button-outline" onClick={() => setShowEnroll(false)}>Cancel</button>
                <button className="button" onClick={handleEnrollSelected} disabled={enrolling || selectedStudentIds.size === 0}>
                  {enrolling ? 'Enrolling...' : 'Enroll Selected'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {scheduleCandidate && scheduleForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div className="problem-card" style={{ width: '520px', maxHeight: '85vh', overflowY: 'auto', padding: '24px' }}>
            <h3 className="mb-2">Schedule Interview</h3>
            <p className="text-muted mb-4">{scheduleCandidate.studentId?.name} — Round {scheduleCandidate.currentRoundIndex + 1}</p>

            {scheduleResult ? (
              <div>
                <div className="error-box" style={{ background: 'rgba(16, 185, 129, 0.1)', color: 'var(--success)', borderColor: 'rgba(16, 185, 129, 0.2)' }}>
                  Interview scheduled successfully.
                </div>
                {scheduleResult.accessToken && (
                  <div className="form-group">
                    <label>External interviewer access link (shown once — also emailed):</label>
                    <input type="text" readOnly value={`${window.location.origin}/interview/${scheduleResult.accessToken}`} onFocus={(e) => e.target.select()} />
                  </div>
                )}
                <div className="mt-4" style={{ textAlign: 'right' }}>
                  <button className="button" onClick={() => { closeScheduleModal(); fetchData(); }}>Done</button>
                </div>
              </div>
            ) : (
              <form onSubmit={submitSchedule}>
                {scheduleError && <div className="error-box">{scheduleError}</div>}

                <div className="form-group">
                  <label>Interviewer:</label>
                  <select
                    value={scheduleForm.mode}
                    onChange={(e) => setScheduleForm({ ...scheduleForm, mode: e.target.value })}
                  >
                    <option value="internal">Faculty (internal)</option>
                    <option value="external">External (email invite link)</option>
                  </select>
                </div>

                {scheduleForm.mode === 'internal' ? (
                  <div className="form-group">
                    <label>Select faculty:</label>
                    <select
                      value={scheduleForm.interviewerId}
                      onChange={(e) => setScheduleForm({ ...scheduleForm, interviewerId: e.target.value })}
                      required
                    >
                      <option value="">Choose...</option>
                      {staffList.map((s) => (
                        <option key={s._id} value={s._id}>{s.name} ({s.email})</option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <>
                    <div className="form-group">
                      <label>External interviewer name:</label>
                      <input type="text" value={scheduleForm.externalName} onChange={(e) => setScheduleForm({ ...scheduleForm, externalName: e.target.value })} required />
                    </div>
                    <div className="form-group">
                      <label>External interviewer email:</label>
                      <input type="email" value={scheduleForm.externalEmail} onChange={(e) => setScheduleForm({ ...scheduleForm, externalEmail: e.target.value })} required />
                    </div>
                  </>
                )}

                <div className="form-group">
                  <label>Date &amp; time:</label>
                  <input type="datetime-local" value={scheduleForm.scheduledAt} onChange={(e) => setScheduleForm({ ...scheduleForm, scheduledAt: e.target.value })} required />
                </div>
                <div className="form-group">
                  <label>Duration (minutes):</label>
                  <input type="number" min="5" value={scheduleForm.durationMinutes} onChange={(e) => setScheduleForm({ ...scheduleForm, durationMinutes: e.target.value })} />
                </div>
                <div className="form-group">
                  <label>Meeting link (optional):</label>
                  <input type="text" placeholder="https://meet.example.com/..." value={scheduleForm.meetingLink} onChange={(e) => setScheduleForm({ ...scheduleForm, meetingLink: e.target.value })} />
                </div>
                <div className="form-group">
                  <label>Notes (optional):</label>
                  <textarea value={scheduleForm.notes} onChange={(e) => setScheduleForm({ ...scheduleForm, notes: e.target.value })} />
                </div>

                <div className="flex-between mt-4">
                  <button type="button" className="button button-outline" onClick={closeScheduleModal}>Cancel</button>
                  <button type="submit" className="button" disabled={scheduling}>
                    {scheduling ? 'Scheduling...' : 'Schedule'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default DrivePipelinePage;
