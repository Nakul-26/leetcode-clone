import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ChevronLeft, CheckCircle2, Loader2 } from 'lucide-react';
import { assessments, submissions } from '../api';

const GradeSubjectivePage = () => {
  const { id } = useParams();
  const [assessment, setAssessment] = useState(null);
  const [queue, setQueue] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [drafts, setDrafts] = useState({}); // submissionId -> { score, feedback }
  const [savingId, setSavingId] = useState(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [assessmentRes, queueRes] = await Promise.all([
        assessments.get(id),
        submissions.listUngraded(id)
      ]);
      setAssessment(assessmentRes.data);
      setQueue(queueRes.data);
    } catch (err) {
      setError(err.response?.data?.msg || 'Failed to load grading queue');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const maxScoreFor = (problemId) => {
    const entry = assessment?.problems?.find((p) => (p.problemId?._id || p.problemId) === problemId);
    return entry?.maxScore ?? 100;
  };

  const draftFor = (submissionId) => drafts[submissionId] || { score: '', feedback: '' };

  const setDraft = (submissionId, patch) => {
    setDrafts((prev) => ({ ...prev, [submissionId]: { ...draftFor(submissionId), ...patch } }));
  };

  const handleGrade = async (submission) => {
    const draft = draftFor(submission._id);
    const score = Number(draft.score);
    if (!Number.isFinite(score) || score < 0) {
      alert('Enter a valid non-negative score');
      return;
    }
    setSavingId(submission._id);
    try {
      await submissions.grade(submission._id, { score, feedback: draft.feedback || '' });
      setQueue((prev) => prev.filter((s) => s._id !== submission._id));
    } catch (err) {
      alert(err.response?.data?.msg || 'Failed to save grade');
    } finally {
      setSavingId(null);
    }
  };

  if (loading) return <div className="container flex-center" style={{ height: '60vh' }}><Loader2 className="spin" size={40} color="var(--primary)" /></div>;
  if (error) return <div className="container error-box">{error}</div>;

  return (
    <div className="container fade-in">
      <div className="flex-between mb-8">
        <Link to={`/admin/assessments/${id}/results`} className="button button-outline" style={{ padding: '8px 12px' }}>
          <ChevronLeft size={18} /> Back to Results
        </Link>
        <h1 style={{ fontSize: '1.75rem', margin: 0 }}>Grade Subjective Answers</h1>
        <div style={{ width: '140px' }}></div>
      </div>

      {assessment && <p className="text-muted mb-8">{assessment.title} — {queue.length} answer{queue.length === 1 ? '' : 's'} awaiting grading.</p>}

      {queue.length === 0 && (
        <div className="problem-card flex-center gap-2" style={{ padding: '40px', justifyContent: 'center' }}>
          <CheckCircle2 size={20} color="var(--success)" />
          <span>Nothing left to grade — every subjective answer has been reviewed.</span>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        {queue.map((s) => {
          const maxScore = maxScoreFor(s.problemId?._id || s.problemId);
          const draft = draftFor(s._id);
          return (
            <div key={s._id} className="problem-card">
              <div className="flex-between mb-4">
                <div>
                  <h3 style={{ margin: 0, fontSize: '1.1rem' }}>{s.problemId?.title || 'Untitled Problem'}</h3>
                  <p className="text-muted" style={{ margin: '4px 0 0' }}>
                    {s.userId?.name || 'Unknown Student'} {s.userId?.usn ? `(${s.userId.usn})` : ''}
                  </p>
                </div>
                <span className="tag">Max Score: {maxScore}</span>
              </div>

              {s.problemId?.rubricNotes && (
                <div style={{ background: 'var(--bg)', padding: '12px 16px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', marginBottom: '16px', fontSize: '0.85rem' }}>
                  <strong>Rubric:</strong> {s.problemId.rubricNotes}
                </div>
              )}

              <div style={{ background: 'var(--bg)', padding: '16px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', marginBottom: '16px', whiteSpace: 'pre-wrap', fontSize: '0.95rem', lineHeight: '1.6' }}>
                {s.answerText || <em className="text-muted">No answer submitted</em>}
              </div>

              <div className="grid grid-cols-2 gap-6" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: '16px', alignItems: 'start' }}>
                <div className="form-group">
                  <label>Score (0–{maxScore})</label>
                  <input
                    type="number"
                    min="0"
                    max={maxScore}
                    value={draft.score}
                    onChange={(e) => setDraft(s._id, { score: e.target.value })}
                    placeholder="0"
                  />
                </div>
                <div className="form-group">
                  <label>Feedback (optional)</label>
                  <textarea
                    value={draft.feedback}
                    onChange={(e) => setDraft(s._id, { feedback: e.target.value })}
                    placeholder="Notes for the student..."
                    style={{ height: '60px' }}
                  />
                </div>
              </div>

              <button
                className="button button-primary mt-4"
                onClick={() => handleGrade(s)}
                disabled={savingId === s._id}
              >
                {savingId === s._id ? 'Saving...' : 'Save Grade'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default GradeSubjectivePage;
