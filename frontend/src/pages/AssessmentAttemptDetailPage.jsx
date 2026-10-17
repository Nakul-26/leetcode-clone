import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Play, AlertTriangle, CheckCircle2, Clipboard, Code2, Hourglass, MonitorOff, EyeOff, RefreshCw, Info } from 'lucide-react';
import api, { assessments } from '../api';

const AssessmentAttemptDetailPage = () => {
  const { attemptId } = useParams();
  const [attempt, setAttempt] = useState(null);
  const [submissions, setSubmissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedSubmission, setSelectedSubmission] = useState(null);
  const [activeTab, setActiveTab] = useState('submissions'); // 'submissions' | 'timeline'

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [attemptRes, submissionsRes] = await Promise.all([
          assessments.getAttempt(attemptId),
          assessments.getAttemptSubmissions(attemptId)
        ]);
        setAttempt(attemptRes.data);
        setSubmissions(submissionsRes.data);
        if (submissionsRes.data.length > 0) {
          setSelectedSubmission(submissionsRes.data[0]);
        }
      } catch (err) {
        setError(err.response?.data?.msg || 'Failed to fetch attempt details');
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [attemptId]);

  const handleRejudge = async (submissionId) => {
    if (!window.confirm("Are you sure you want to rejudge this single submission?")) {
      return;
    }
    try {
      await api.post(`/api/v1/admin/rejudge/submission/${submissionId}`);
      alert("Rejudging scheduled. Refreshing results...");
      
      setSubmissions(prev => prev.map(s => s._id === submissionId ? { ...s, status: 'Pending' } : s));
      if (selectedSubmission?._id === submissionId) {
        setSelectedSubmission(prev => ({ ...prev, status: 'Pending' }));
      }
      
      setTimeout(async () => {
        try {
          const submissionsRes = await assessments.getAttemptSubmissions(attemptId);
          setSubmissions(submissionsRes.data);
          const found = submissionsRes.data.find(s => s._id === submissionId);
          if (found) {
            setSelectedSubmission(found);
          }
        } catch (err) {
          console.error(err);
        }
      }, 3000);
    } catch (err) {
      alert(err.response?.data?.error || "Failed to trigger rejudge");
    }
  };

  if (loading) return <div className="container">Loading details...</div>;
  if (error) return <div className="container error">{error}</div>;

  const timeUsed = attempt.submittedAt 
    ? Math.floor((new Date(attempt.submittedAt) - new Date(attempt.startedAt)) / 60000)
    : Math.floor((new Date() - new Date(attempt.startedAt)) / 60000);

  const sortedTimeline = attempt.timeline 
    ? [...attempt.timeline].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    : [];

  return (
    <div className="container">
      <div style={{ marginBottom: '24px' }}>
        <Link to={`/admin/assessments/${attempt.assessmentId._id || attempt.assessmentId}/results`} className="button button-outline">
          &larr; Back to All Results
        </Link>
      </div>

      <div className="problem-card">
        <h2 style={{ margin: '0 0 8px' }}>Student: {attempt.studentId.name}</h2>
        <p style={{ color: 'var(--text-secondary)', margin: '0 0 24px' }}>{attempt.studentId.email}</p>
        
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '24px' }}>
          <div>
            <div style={{ fontSize: '0.8rem', textTransform: 'uppercase', color: 'var(--text-muted)', fontWeight: '700', letterSpacing: '0.05em' }}>Score</div>
            <div style={{ fontSize: '2.5rem', fontWeight: '800', color: 'var(--primary)' }}>{attempt.score}</div>
          </div>
          <div>
            <div style={{ fontSize: '0.8rem', textTransform: 'uppercase', color: 'var(--text-muted)', fontWeight: '700', letterSpacing: '0.05em' }}>Time Used</div>
            <div style={{ fontSize: '2.5rem', fontWeight: '800', color: 'var(--text-main)' }}>{timeUsed} min</div>
          </div>
          <div>
            <div style={{ fontSize: '0.8rem', textTransform: 'uppercase', color: 'var(--text-muted)', fontWeight: '700', letterSpacing: '0.05em' }}>Status</div>
            <div style={{ fontSize: '2.5rem', fontWeight: '800', color: attempt.status === 'Submitted' ? 'var(--success)' : 'var(--warning)' }}>{attempt.status}</div>
          </div>
        </div>
      </div>

      <div className="detail-layout" style={{ display: 'flex', gap: '24px', marginTop: '30px', height: '700px' }}>
        {/* Left Sidebar (Switchable Submissions / Timeline) */}
        <div className="detail-sidebar" style={{ width: '380px', display: 'flex', flexDirection: 'column', background: 'var(--bg-surface)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)', overflow: 'hidden', flexShrink: 0 }}>
          
          <div style={{ display: 'flex', background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid var(--border)' }}>
            <button 
              onClick={() => setActiveTab('submissions')}
              style={{
                flex: 1,
                padding: '16px',
                background: 'none',
                border: 'none',
                borderBottom: activeTab === 'submissions' ? '2px solid var(--primary)' : '2px solid transparent',
                color: activeTab === 'submissions' ? 'var(--text)' : 'var(--text-secondary)',
                fontWeight: '600',
                cursor: 'pointer',
                transition: 'all 0.2s',
                fontSize: '0.9rem'
              }}
            >
              Submissions ({submissions.length})
            </button>
            <button 
              onClick={() => setActiveTab('timeline')}
              style={{
                flex: 1,
                padding: '16px',
                background: 'none',
                border: 'none',
                borderBottom: activeTab === 'timeline' ? '2px solid var(--primary)' : '2px solid transparent',
                color: activeTab === 'timeline' ? 'var(--text)' : 'var(--text-secondary)',
                fontWeight: '600',
                cursor: 'pointer',
                transition: 'all 0.2s',
                fontSize: '0.9rem'
              }}
            >
              Activity Timeline ({sortedTimeline.length})
            </button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: activeTab === 'timeline' ? '24px' : '0' }}>
            {activeTab === 'submissions' ? (
              <>
                {submissions.map(s => (
                  <div 
                    key={s._id} 
                    onClick={() => setSelectedSubmission(s)}
                    style={{ 
                      padding: '16px 20px', 
                      cursor: 'pointer', 
                      borderBottom: '1px solid var(--border)',
                      background: selectedSubmission?._id === s._id ? 'rgba(59, 130, 246, 0.1)' : 'transparent',
                      borderLeft: selectedSubmission?._id === s._id ? '4px solid var(--primary)' : '4px solid transparent',
                      transition: 'all 0.2s'
                    }}
                  >
                    <div style={{ fontWeight: '700', color: 'var(--text-main)', marginBottom: '4px' }}>{s.problemId?.title || 'Unknown Problem'}</div>
                    <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                      <span style={{ textTransform: 'capitalize' }}>{s.language}</span>
                      <span>{new Date(s.createdAt).toLocaleTimeString()}</span>
                    </div>
                    <span className={`tag ${s.status === 'Success' ? 'difficulty-easy' : 'difficulty-hard'}`}>
                      {s.status}
                    </span>
                  </div>
                ))}
                {submissions.length === 0 && (
                  <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
                    No submissions found.
                  </div>
                )}
              </>
            ) : (
              <>
                {sortedTimeline.map((item, idx) => {
                  const eventDate = new Date(item.timestamp);
                  const formattedTime = eventDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                  
                  let icon = <Info size={16} />;
                  let color = 'var(--text-secondary)';
                  let title = item.event;
                  let desc = '';

                  switch (item.event) {
                    case 'START':
                      icon = <Play size={16} />;
                      color = 'var(--success)';
                      title = 'Exam Started';
                      desc = 'Candidate initiated the assessment attempt.';
                      break;
                    case 'SUBMIT':
                      icon = <CheckCircle2 size={16} />;
                      color = 'var(--success)';
                      title = 'Exam Submitted';
                      desc = 'Assessment completed and submitted by candidate.';
                      break;
                    case 'TIMED_OUT':
                      icon = <Hourglass size={16} />;
                      color = 'var(--error)';
                      title = 'Attempt Timed Out';
                      desc = 'Time limit exceeded. Attempt auto-submitted.';
                      break;
                    case 'TAB_SWITCH':
                      icon = <EyeOff size={16} />;
                      color = 'var(--warning)';
                      title = 'Tab Switch';
                      desc = 'Candidate navigated away from the exam tab.';
                      break;
                    case 'COPY':
                      icon = <Clipboard size={16} />;
                      color = 'var(--warning)';
                      title = 'Copy/Cut Action';
                      desc = 'Copy or cut shortcut blocked in coding area.';
                      break;
                    case 'PASTE':
                      icon = <Clipboard size={16} />;
                      color = 'var(--warning)';
                      title = 'Paste Action';
                      desc = 'Paste shortcut blocked in coding area.';
                      break;
                    case 'FULLSCREEN_EXIT':
                      icon = <MonitorOff size={16} />;
                      color = 'var(--error)';
                      title = 'Fullscreen Exited';
                      desc = 'Candidate left fullscreen mode (warning triggered).';
                      break;
                    case 'RETURN':
                      icon = <RefreshCw size={16} />;
                      color = 'var(--info)';
                      title = 'Returned to Test';
                      desc = 'Candidate returned and resumed the exam environment.';
                      break;
                    case 'SUBMIT_PROBLEM':
                      icon = <Code2 size={16} />;
                      color = 'var(--primary)';
                      title = `Submitted ${item.details?.problemTitle || 'Challenge'}`;
                      desc = `Code submission sent for evaluation.`;
                      break;
                    default:
                      title = item.event;
                  }

                  return (
                    <div key={idx} style={{ display: 'flex', gap: '16px', position: 'relative', paddingBottom: '24px' }}>
                      {idx < sortedTimeline.length - 1 && (
                        <div style={{
                          position: 'absolute',
                          left: '17px',
                          top: '24px',
                          bottom: 0,
                          width: '2px',
                          background: 'var(--border)'
                        }}></div>
                      )}
                      
                      <div style={{
                        width: '36px',
                        height: '36px',
                        borderRadius: '50%',
                        background: 'rgba(255,255,255,0.02)',
                        border: `1px solid ${color}`,
                        color: color,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                        zIndex: 1
                      }}>
                        {icon}
                      </div>
                      
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', paddingTop: '4px' }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
                          <strong style={{ fontSize: '0.9rem', color: 'var(--text-main)' }}>{title}</strong>
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{formattedTime}</span>
                        </div>
                        {desc && <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>{desc}</span>}
                        {item.details?.submissionId && (
                          <button
                            onClick={() => {
                              const found = submissions.find(s => s._id === item.details.submissionId);
                              if (found) {
                                setSelectedSubmission(found);
                                setActiveTab('submissions');
                              }
                            }}
                            style={{
                              width: 'fit-content',
                              background: 'rgba(99, 102, 241, 0.05)',
                              color: 'var(--primary)',
                              border: '1px solid rgba(99, 102, 241, 0.1)',
                              padding: '4px 10px',
                              borderRadius: '4px',
                              fontSize: '0.75rem',
                              marginTop: '4px',
                              cursor: 'pointer',
                              fontWeight: '600'
                            }}
                          >
                            View Submission Code
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
                {sortedTimeline.length === 0 && (
                  <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--text-muted)' }}>
                    No proctoring logs recorded.
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Code Viewer */}
        <div className="detail-content" style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#1e1e1e', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)', overflow: 'hidden' }}>
          {selectedSubmission ? (
            <>
              <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.03)' }}>
                <h4 style={{ margin: 0 }}>Submission Code</h4>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <button
                    className="button button-outline"
                    onClick={() => handleRejudge(selectedSubmission._id)}
                    style={{ padding: '6px 12px', fontSize: '0.8rem', color: 'var(--warning)', borderColor: 'rgba(245, 158, 11, 0.4)', display: 'flex', alignItems: 'center', gap: '4px' }}
                  >
                    <RefreshCw size={14} /> Rejudge
                  </button>
                  <div className={`tag ${selectedSubmission.status === 'Success' ? 'difficulty-easy' : 'difficulty-hard'}`}>
                    {selectedSubmission.status}
                  </div>
                </div>
              </div>
              {selectedSubmission.problemId?.problemType === 'mcq' ? (
                <div style={{ flex: 1, overflow: 'auto', padding: '24px' }}>
                  {(selectedSubmission.problemId.options || []).map((opt, idx) => {
                    const wasSelected = (selectedSubmission.selectedOptions || []).includes(idx);
                    return (
                      <div
                        key={idx}
                        style={{
                          padding: '12px 16px',
                          marginBottom: '10px',
                          borderRadius: 'var(--radius-md)',
                          border: `1px solid ${opt.isCorrect ? 'var(--success)' : wasSelected ? 'var(--error)' : 'var(--border)'}`,
                          background: wasSelected ? 'rgba(255,255,255,0.04)' : 'transparent',
                          color: '#d4d4d4',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: '12px'
                        }}
                      >
                        <span>{opt.text}</span>
                        <span style={{ display: 'flex', gap: '8px', fontSize: '0.75rem', flexShrink: 0 }}>
                          {wasSelected && <span style={{ color: 'var(--text-muted)' }}>Selected</span>}
                          {opt.isCorrect && <span style={{ color: 'var(--success)' }}>Correct</span>}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : selectedSubmission.problemId?.problemType === 'subjective' ? (
                <div style={{ flex: 1, overflow: 'auto', padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  <div>
                    <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', color: 'var(--text-muted)', fontWeight: '700', letterSpacing: '0.05em', marginBottom: '8px' }}>
                      Answer
                    </div>
                    <div style={{ color: '#d4d4d4', whiteSpace: 'pre-wrap', lineHeight: '1.6' }}>
                      {selectedSubmission.answerText || <span style={{ color: 'var(--text-muted)' }}>No answer submitted.</span>}
                    </div>
                  </div>
                  {selectedSubmission.status === 'Graded' && (
                    <div>
                      <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', color: 'var(--text-muted)', fontWeight: '700', letterSpacing: '0.05em', marginBottom: '8px' }}>
                        Faculty Feedback (Score: {selectedSubmission.score})
                      </div>
                      <div style={{ color: '#d4d4d4', whiteSpace: 'pre-wrap', lineHeight: '1.6' }}>
                        {selectedSubmission.feedback || <span style={{ color: 'var(--text-muted)' }}>No feedback given.</span>}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <pre style={{
                  flex: 1,
                  margin: 0,
                  padding: '24px',
                  backgroundColor: '#1e1e1e',
                  color: '#d4d4d4',
                  overflow: 'auto',
                  fontSize: '14px',
                  lineHeight: '1.6',
                  fontFamily: "'Fira Code', monospace"
                }}>
                  {selectedSubmission.code}
                </pre>
              )}
            </>
          ) : (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', color: 'var(--text-muted)', flexDirection: 'column', gap: '16px' }}>
              <span style={{ fontSize: '3rem', opacity: 0.2 }}>&lt;/&gt;</span>
              Select a submission to view code
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AssessmentAttemptDetailPage;
