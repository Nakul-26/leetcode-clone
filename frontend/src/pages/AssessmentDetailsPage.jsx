import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Play, Calendar, Clock, Code2, AlertTriangle, ChevronLeft, CheckCircle2, ExternalLink, ShieldCheck, ListChecks, Award, Eye } from 'lucide-react';
import { assessments } from '../api';

const AssessmentDetailsPage = ({ user }) => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [assessment, setAssessment] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [starting, setStarting] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [showFsPrompt, setShowFsPrompt] = useState(false);
  const [fsPending, setFsPending] = useState(false);
  const [myAttempt, setMyAttempt] = useState(null);

  useEffect(() => {
    const fetchAssessment = async () => {
      try {
        const [assessmentRes, attemptRes] = await Promise.all([
          assessments.get(id),
          assessments.getMyAttempt(id).catch(() => ({ data: null }))
        ]);
        setAssessment(assessmentRes.data);
        setMyAttempt(attemptRes.data);
      } catch (err) {
        setError(err.response?.data?.msg || 'Failed to fetch assessment details');
      } finally {
        setLoading(false);
      }
    };
    fetchAssessment();
  }, [id]);

  const startAttempt = async () => {
    setStarting(true);
    try {
      const res = await assessments.start(id);
      const attempt = res.data;
      navigate(
        attempt.status === 'Active'
          ? `/assessment-attempt/${attempt._id}`
          : `/assessment-attempt/${attempt._id}/result`
      );
    } catch (err) {
      alert(err.response?.data?.msg || 'Failed to start assessment');
    } finally {
      setStarting(false);
    }
  };

  const handleStart = () => {
    setAgreed(false);
    // show instructions modal first
    setShowInstructions(true);
  };

  const handleBeginAfterInstructions = () => {
    // prompt for fullscreen next
    setShowInstructions(false);
    setShowFsPrompt(true);
  };

  const enterFullscreenAndStart = async () => {
    setFsPending(true);
    const onFsChange = async () => {
      if (document.fullscreenElement) {
        document.removeEventListener('fullscreenchange', onFsChange);
        setShowFsPrompt(false);
        await startAttempt();
      }
    };

    try {
      // request fullscreen; some browsers require user gesture and may reject
      const el = document.documentElement;
      if (el.requestFullscreen) {
        document.addEventListener('fullscreenchange', onFsChange);
        await el.requestFullscreen();
        // if requestFullscreen resolves but event not yet fired, handler will trigger
      } else {
        alert('Fullscreen API not supported by your browser. Please use a browser that supports fullscreen to start the assessment.');
      }
    } catch {
      // user likely denied or request failed
      document.removeEventListener('fullscreenchange', onFsChange);
      alert('Unable to enter fullscreen. Please try again.');
    } finally {
      setFsPending(false);
    }
  };

  if (loading) return <div className="container">Loading assessment details...</div>;
  if (error) return <div className="container error-box">{error}</div>;
  if (!assessment) return <div className="container">Assessment not found.</div>;

  const now = new Date();
  const startTime = new Date(assessment.startTime);
  const endTime = new Date(assessment.endTime);
  const isAvailable = now >= startTime && now <= endTime && assessment.status === 'Published';
  const isUpcoming = now < startTime;

  const isStudent = user && user.role === 'student';
  const hasAttempt = Boolean(myAttempt);
  const attemptFinished = myAttempt && myAttempt.status && myAttempt.status !== 'Active';
  const attemptActive = myAttempt && myAttempt.status === 'Active';
  const availableForUser = isAvailable && isStudent && !hasAttempt;

  return (
    <>
    <div className="container fade-in">
      <div className="mb-8">
        <Link to="/assessments" className="text-muted flex-center gap-2 mb-6" style={{ width: 'fit-content', fontSize: '0.9rem', justifyContent: 'flex-start' }}>
          <ChevronLeft size={16} /> Back to Assessments
        </Link>
        <h1 className="mb-2">{assessment.title}</h1>
        <p className="text-secondary" style={{ fontSize: '1.1rem', maxWidth: '800px' }}>
          {assessment.description}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-6" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: '24px' }}>
        
        {/* Left Col: Info */}
        <div className="problem-card" style={{ height: 'fit-content' }}>
          <h3 className="mb-6">Assessment Details</h3>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div className="flex-center gap-4" style={{ justifyContent: 'flex-start' }}>
              <div style={{ padding: '12px', background: 'rgba(255,255,255,0.05)', borderRadius: '12px' }}>
                <Clock size={24} color="var(--primary)" />
              </div>
              <div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: '700' }}>Duration</div>
                <div style={{ fontSize: '1.1rem', fontWeight: '600' }}>{assessment.durationMinutes} Minutes</div>
              </div>
            </div>

            <div className="flex-center gap-4" style={{ justifyContent: 'flex-start' }}>
              <div style={{ padding: '12px', background: 'rgba(255,255,255,0.05)', borderRadius: '12px' }}>
                <Calendar size={24} color="var(--success)" />
              </div>
              <div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: '700' }}>Window</div>
                <div style={{ fontSize: '0.95rem' }}>Starts: <strong>{startTime.toLocaleString()}</strong></div>
                <div style={{ fontSize: '0.95rem' }}>Ends: <strong>{endTime.toLocaleString()}</strong></div>
              </div>
            </div>

            <div className="flex-center gap-4" style={{ justifyContent: 'flex-start' }}>
              <div style={{ padding: '12px', background: 'rgba(255,255,255,0.05)', borderRadius: '12px' }}>
                <Code2 size={24} color="var(--warning)" />
              </div>
              <div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: '700' }}>Languages</div>
                <div style={{ fontSize: '0.95rem', fontWeight: '600' }}>
                  {assessment.allowedLanguages?.join(', ') || 'All Supported Languages'}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right Col: Action & Problems summary */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          
          {/* Action Box */}
          <div className="problem-card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '40px 24px', background: isAvailable ? 'var(--surface-hover)' : 'var(--surface)', borderColor: isAvailable ? 'var(--primary)' : 'var(--border)' }}>
            
            {hasAttempt && attemptFinished ? (
              <>
                <AlertTriangle size={48} className="text-muted mb-4" />
                <h3 className="mb-2 text-muted">Already given assessment</h3>
                <p className="text-secondary mb-6">You have already submitted this assessment. Review your result and submission history below.</p>
                <button
                  className="button"
                  style={{ padding: '16px 40px', fontSize: '1.05rem', borderRadius: '100px' }}
                  onClick={() => navigate(`/assessment-attempt/${myAttempt._id}/result`)}
                >
                  <ExternalLink size={18} />
                  See Results
                </button>
              </>
            ) : attemptActive ? (
              <>
                <div className="mb-4" style={{ width: '16px', height: '16px', borderRadius: '50%', background: 'var(--warning)', boxShadow: '0 0 16px var(--warning)' }}></div>
                <h3 className="mb-2" style={{ color: 'var(--warning)' }}>Assessment in progress</h3>
                <p className="text-secondary mb-6">You already started this assessment. Return to the workspace to continue from where you left off.</p>
                <button
                  className="button"
                  style={{ padding: '16px 40px', fontSize: '1.05rem', borderRadius: '100px' }}
                  onClick={() => navigate(`/assessment-attempt/${myAttempt._id}`)}
                >
                  <ExternalLink size={18} />
                  Continue Assessment
                </button>
              </>
            ) : availableForUser ? (
              <>
                <div className="mb-4" style={{ width: '16px', height: '16px', borderRadius: '50%', background: 'var(--success)', boxShadow: '0 0 16px var(--success)', animation: 'pulse 2s infinite' }}></div>
                <h3 className="mb-2" style={{ color: 'var(--success)' }}>Live Now</h3>
                <p className="text-secondary mb-6">You have {assessment.durationMinutes} minutes to complete {assessment.problems?.length} problems.</p>
                <button
                  className="button"
                  style={{ padding: '16px 40px', fontSize: '1.15rem', borderRadius: '100px' }}
                  onClick={handleStart}
                  disabled={starting}
                >
                  <Play size={20} />
                  {starting ? 'Preparing Workspace...' : 'Start Assessment'}
                </button>
              </>
            ) : isAvailable && !isStudent ? (
              <>
                <AlertTriangle size={48} className="text-muted mb-4" />
                <h3 className="mb-2 text-muted">Cannot Start</h3>
                <p className="text-secondary mb-6">You cannot start this assessment because your account role is <strong>{user?.role || 'guest'}</strong>. Only students can start assessments.</p>
              </>
            ) : isUpcoming ? (
              <>
                <Calendar size={48} className="text-muted mb-4" />
                <h3 className="mb-2">Upcoming Assessment</h3>
                <p className="text-secondary mb-6">This assessment will be available shortly.</p>
                <div style={{ background: 'rgba(99, 102, 241, 0.1)', padding: '16px 32px', borderRadius: '100px', color: 'var(--primary)', border: '1px solid rgba(99, 102, 241, 0.2)', fontWeight: '600' }}>
                  Available on {startTime.toLocaleDateString()}
                </div>
              </>
            ) : (
              <>
                <AlertTriangle size={48} className="text-muted mb-4" />
                <h3 className="mb-2 text-muted">Assessment Ended</h3>
                <p className="text-secondary mb-0">This assessment is no longer accepting submissions.</p>
              </>
            )}

          </div>

          <div className="problem-card">
            <h4 className="mb-4 flex-center gap-2" style={{ justifyContent: 'flex-start' }}><CheckCircle2 size={18} /> Problems Included</h4>
            <div className="flex-between" style={{ padding: '16px', background: 'rgba(255,255,255,0.02)', borderRadius: '12px', border: '1px solid var(--border)' }}>
              <span style={{ fontSize: '1.25rem', fontWeight: '700' }}>{assessment.problems?.length || 0}</span>
              <span className="text-muted">Total Coding Challenges</span>
            </div>
            <p className="text-muted mt-4" style={{ fontSize: '0.85rem' }}>
              Note: Problem details are hidden until you start the assessment to prevent cheating.
            </p>
          </div>

        </div>

      </div>

      <style>{`
        @keyframes pulse {
          0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
          70% { transform: scale(1); box-shadow: 0 0 0 10px rgba(16, 185, 129, 0); }
          100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
        }
      `}</style>
    </div>

      {/* Instructions Modal */}
      {showInstructions && (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(2, 6, 23, 0.85)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1200,
          padding: '20px'
        }}>
          <div style={{
            width: '800px',
            maxWidth: '100%',
            maxHeight: '90vh',
            background: 'var(--surface)',
            borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--border-bright)',
            boxShadow: 'var(--shadow-lg), 0 0 40px rgba(99, 102, 241, 0.1)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden'
          }}>
            {/* Header */}
            <div style={{
              padding: '24px 32px',
              borderBottom: '1px solid var(--border)',
              background: 'linear-gradient(to right, rgba(99, 102, 241, 0.05), transparent)',
              display: 'flex',
              alignItems: 'center',
              gap: '16px'
            }}>
              <div style={{
                background: 'var(--primary-glow)',
                color: 'var(--primary)',
                padding: '10px',
                borderRadius: 'var(--radius-md)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}>
                <ShieldCheck size={28} />
              </div>
              <div>
                <h3 style={{ margin: 0, fontSize: '1.4rem' }}>Instructions & Anti-Cheating Policy</h3>
                <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  Please review the rules carefully before starting.
                </p>
              </div>
            </div>

            {/* Scrollable Content */}
            <div style={{
              padding: '32px',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '24px'
            }}>
              {/* Assessment Stats Row */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
                gap: '16px'
              }}>
                {/* Duration */}
                <div style={{
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                  padding: '16px',
                  textAlign: 'center'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'center', color: 'var(--primary)', marginBottom: '8px' }}>
                    <Clock size={20} />
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 'bold' }}>Duration</div>
                  <div style={{ fontSize: '1.1rem', fontWeight: '700', marginTop: '4px' }}>{assessment.durationMinutes} Mins</div>
                </div>

                {/* Total Questions */}
                <div style={{
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                  padding: '16px',
                  textAlign: 'center'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'center', color: 'var(--success)', marginBottom: '8px' }}>
                    <ListChecks size={20} />
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 'bold' }}>Questions</div>
                  <div style={{ fontSize: '1.1rem', fontWeight: '700', marginTop: '4px' }}>{assessment.problems?.length || 0} Total</div>
                </div>

                {/* Total Marks */}
                <div style={{
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                  padding: '16px',
                  textAlign: 'center'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'center', color: 'var(--warning)', marginBottom: '8px' }}>
                    <Award size={20} />
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 'bold' }}>Total Marks</div>
                  <div style={{ fontSize: '1.1rem', fontWeight: '700', marginTop: '4px' }}>
                    {assessment.problems?.reduce((sum, p) => sum + p.maxScore, 0)} Marks
                  </div>
                </div>

                {/* Negative Marking */}
                <div style={{
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                  padding: '16px',
                  textAlign: 'center'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'center', color: 'var(--error)', marginBottom: '8px' }}>
                    <AlertTriangle size={20} />
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 'bold' }}>Negative Marks</div>
                  <div style={{ fontSize: '1.1rem', fontWeight: '700', marginTop: '4px', color: 'var(--text-secondary)' }}>None</div>
                </div>
              </div>

              {/* Dynamic Languages Card */}
              <div style={{
                background: 'rgba(99, 102, 241, 0.03)',
                border: '1px solid rgba(99, 102, 241, 0.1)',
                borderRadius: 'var(--radius-md)',
                padding: '16px 20px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <Code2 size={20} color="var(--primary)" />
                  <span style={{ fontWeight: '600', fontSize: '0.95rem' }}>Allowed Coding Languages</span>
                </div>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {assessment.allowedLanguages && assessment.allowedLanguages.length > 0 ? (
                    assessment.allowedLanguages.map(lang => (
                      <span key={lang} className="tag" style={{ textTransform: 'capitalize', fontSize: '0.8rem', background: 'rgba(255,255,255,0.05)', color: 'var(--text)' }}>
                        {lang}
                      </span>
                    ))
                  ) : (
                    <span className="tag" style={{ fontSize: '0.8rem', background: 'rgba(255,255,255,0.05)', color: 'var(--text)' }}>All Platform Languages</span>
                  )}
                </div>
              </div>

              {/* Anti-Cheating and Exam Conduct Rules */}
              <div>
                <h4 style={{ fontSize: '1rem', color: 'var(--text)', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ width: '4px', height: '16px', background: 'var(--primary)', display: 'inline-block', borderRadius: '2px' }}></span>
                  Anti-Cheating & Exam Conduct Rules
                </h4>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  {/* Rule 1: Fullscreen */}
                  <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
                    <div style={{ color: 'var(--warning)', marginTop: '2px', background: 'rgba(245, 158, 11, 0.1)', padding: '6px', borderRadius: '50%', display: 'flex' }}>
                      <Eye size={18} />
                    </div>
                    <div>
                      <strong style={{ fontSize: '0.95rem', display: 'block', color: 'var(--text)' }}>Mandatory Fullscreen Mode</strong>
                      <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                        The exam will start and run in fullscreen mode. Any attempt to exit fullscreen will trigger warning dialogs and could result in auto-submission of your attempt.
                      </span>
                    </div>
                  </div>

                  {/* Rule 2: Tab Switching */}
                  <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
                    <div style={{ color: 'var(--error)', marginTop: '2px', background: 'rgba(239, 68, 68, 0.1)', padding: '6px', borderRadius: '50%', display: 'flex' }}>
                      <AlertTriangle size={18} />
                    </div>
                    <div>
                      <strong style={{ fontSize: '0.95rem', display: 'block', color: 'var(--text)' }}>Tab & Window Switches Tracked</strong>
                      <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                        Navigating away from the exam tab (tab switches, opening browser tools, using chat/search apps) is tracked. Exceeding limit will result in immediate disqualification.
                      </span>
                    </div>
                  </div>

                  {/* Rule 3: Copy/Paste Block */}
                  <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
                    <div style={{ color: 'var(--info)', marginTop: '2px', background: 'rgba(59, 130, 246, 0.1)', padding: '6px', borderRadius: '50%', display: 'flex' }}>
                      <Code2 size={18} />
                    </div>
                    <div>
                      <strong style={{ fontSize: '0.95rem', display: 'block', color: 'var(--text)' }}>Blocked Clipboard Activities</strong>
                      <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                        Copying text from the questions, or pasting external code into the code editor, is strictly blocked and logged in the system audit timeline.
                      </span>
                    </div>
                  </div>

                  {/* Rule 4: Auto-Submit */}
                  <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
                    <div style={{ color: 'var(--success)', marginTop: '2px', background: 'rgba(16, 185, 205, 0.1)', padding: '6px', borderRadius: '50%', display: 'flex' }}>
                      <Clock size={18} />
                    </div>
                    <div>
                      <strong style={{ fontSize: '0.95rem', display: 'block', color: 'var(--text)' }}>Auto-Submission on Timeout</strong>
                      <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                        The assessment timer runs continuously once started. If the time limit is reached, your current progress is auto-saved and submitted automatically.
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Footer with Checkbox & Actions */}
            <div style={{
              padding: '24px 32px',
              borderTop: '1px solid var(--border)',
              background: 'rgba(255, 255, 255, 0.01)',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px'
            }}>
              <label style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '12px',
                cursor: 'pointer',
                userSelect: 'none'
              }}>
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                  style={{
                    marginTop: '4px',
                    width: '16px',
                    height: '16px',
                    accentColor: 'var(--primary)'
                  }}
                />
                <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
                  I confirm that I am <strong>{user?.name || 'the registered student'}</strong>. I have read, understood, and agree to abide by all the assessment guidelines and the anti-cheating policies. I understand that violations will be logged for faculty review.
                </span>
              </label>

              <div style={{ display: 'flex', gap: '16px', justifyContent: 'flex-end', marginTop: '4px' }}>
                <button
                  className="button button-outline"
                  onClick={() => setShowInstructions(false)}
                  style={{ padding: '10px 24px' }}
                >
                  Cancel
                </button>
                <button
                  className="button"
                  onClick={handleBeginAfterInstructions}
                  disabled={!agreed}
                  style={{
                    padding: '10px 32px',
                    background: agreed ? 'var(--primary-gradient)' : 'rgba(255,255,255,0.05)',
                    color: agreed ? 'white' : 'var(--text-muted)',
                    cursor: agreed ? 'pointer' : 'not-allowed',
                    opacity: agreed ? 1 : 0.6,
                    border: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    fontWeight: '600'
                  }}
                >
                  I Understand & Continue <Play size={16} />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Fullscreen Prompt Modal */}
      {showFsPrompt && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1200 }}>
          <div style={{ width: '560px', maxWidth: '94%', background: 'var(--surface)', padding: '20px', borderRadius: '12px', border: '1px solid var(--border)' }}>
            <h3 style={{ marginTop: 0 }}>Enter Fullscreen to Start</h3>
            <p style={{ color: 'var(--text-secondary)' }}>For best security, please enter fullscreen now. The assessment timer will begin once fullscreen is active.</p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button className="button button-outline" onClick={() => { setShowFsPrompt(false); }}>Cancel</button>
              <button className="button" onClick={enterFullscreenAndStart} disabled={fsPending}>{fsPending ? 'Entering Fullscreen...' : 'Enter Fullscreen and Start'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default AssessmentDetailsPage;
