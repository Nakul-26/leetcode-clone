import React, { useState, useEffect, useRef } from 'react';
import { useParams, Link, useLocation } from 'react-router-dom';
import Editor from '@monaco-editor/react';
import { Play, Send, ChevronLeft, Info, History, Settings2, Terminal, AlertCircle, ChevronDown, ChevronUp, Loader2, Trash2, CheckCircle2, X, Edit2, Lock } from 'lucide-react';
import api, { problems } from '../api';
import SubmissionOutput from '../components/SubmissionOutput';
import { starterCode } from '../utils/buildTemplate';
import { SUPPORTED_LANGUAGES } from '../utils/languages';
import { defineModernDarkTheme, MONACO_EDITOR_OPTIONS } from '../utils/editorTheme';
import { buildCustomTests, initialTestCases, emptyTestCase, isStdinProblem, MAX_CUSTOM_TESTS } from '../utils/buildCustomTests';

const ProblemPage = ({ user }) => {
  const { _id } = useParams();
  const location = useLocation();
  const [problem, setProblem] = useState(null);
  const [successMsg, setSuccessMsg] = useState(location.state?.successMessage || '');
  const [stats, setStats] = useState(null);
  const [code, setCode] = useState('');
  const [selectedLanguage, setSelectedLanguage] = useState('python');
  const [activeTab, setActiveTab] = useState('description');
  const [consoleTab, setConsoleTab] = useState('testcases');
  
  const [submission, setSubmission] = useState(null);
  const [runResult, setRunResult] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [showConsole, setShowConsole] = useState(false);
  
  const [testCases, setTestCases] = useState(['[]']);
  const [activeTestCaseIdx, setActiveTestCaseIdx] = useState(0);
  
  const [mySubmissions, setMySubmissions] = useState([]);
  const [loadingSubmissions, setLoadingSubmissions] = useState(false);
  
  const intervalRef = useRef(null);
  const isAuthed = !!user;
  const canManage = user && (user.role === 'admin' || user.role === 'faculty' || user.role === 'superadmin');
  const isCollegeAdmin = user && (user.role === 'admin' || user.role === 'superadmin');

  useEffect(() => {
    if (activeTab === 'submissions' && isAuthed && mySubmissions.length === 0) {
      setLoadingSubmissions(true);
      api.get('/api/v1/submissions/my')
        .then(res => {
          const filtered = res.data.filter(s => s.problemId?._id === _id || s.problemId === _id);
          // Sort by newest first
          filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
          setMySubmissions(filtered);
        })
        .catch(err => console.error('Failed to fetch submissions:', err))
        .finally(() => setLoadingSubmissions(false));
    }
  }, [activeTab, isAuthed, _id, mySubmissions.length]);

  useEffect(() => {
    const fetchProblem = async () => {
      try {
        const [problemRes, statsRes] = await Promise.all([
          problems.get(_id),
          problems.getStats(_id)
        ]);
        
        const fetchedProblem = problemRes.data;
        setProblem(fetchedProblem);
        setStats(statsRes.data);
        
        setTestCases(initialTestCases(fetchedProblem));
        setActiveTestCaseIdx(0);
      } catch (err) {
        console.error(`Error fetching problem ${_id}:`, err);
      }
    };
    fetchProblem();

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [_id]);

  useEffect(() => {
    if (problem) {
      setCode(starterCode(selectedLanguage, problem));
    }
  }, [selectedLanguage, problem]);

  const checkStatus = async (submissionId) => {
    try {
      const res = await api.get(`/api/v1/submissions/${submissionId}`);
      const currentSubmission = res.data;
      setSubmission(currentSubmission);

      if (['Success', 'Fail', 'Error'].includes(currentSubmission.status)) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
        const statsRes = await problems.getStats(_id);
        setStats(statsRes.data);
      }
    } catch (err) {
      console.error('Error checking submission status:', err);
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  const handleRun = async () => {
    if (!isAuthed) return;
    setIsRunning(true);
    setRunResult(null);
    setSubmission(null);
    setShowConsole(true);
    setConsoleTab('result');

    let tests = [];
    try {
      tests = buildCustomTests(testCases, problem);
    } catch (err) {
      console.error('Invalid JSON in test cases:', err);
      setRunResult({ status: 'Error', error: 'Invalid JSON in one of the test cases.' });
      setIsRunning(false);
      return;
    }

    try {
      const res = await problems.run(_id, { code, language: selectedLanguage, customTests: tests });
      setRunResult(res.data);
    } catch (err) {
      console.error('Error running code:', err);
      setRunResult({ status: 'Error', error: 'Failed to run code' });
    } finally {
      setIsRunning(false);
    }
  };

  const handleSubmit = async () => {
    if (!isAuthed || intervalRef.current) return;
    setRunResult(null);
    setSubmission({ status: 'Submitting...' });
    setShowConsole(true);
    setConsoleTab('result');

    try {
      const res = await api.post('/api/v1/submissions', { problemId: _id, code, language: selectedLanguage });
      const newSubmission = res.data;
      setSubmission(newSubmission);
      intervalRef.current = setInterval(() => checkStatus(newSubmission._id), 2000);
    } catch (err) {
      console.error('Error submitting code:', err);
      setSubmission({ status: 'Error', error: 'An error occurred during submission.' });
    }
  };

  const handleTestCaseChange = (idx, value) => {
    setTestCases(prev => {
      const next = [...prev];
      next[idx] = value;
      return next;
    });
  };

  const handleAddTestCase = () => {
    if (testCases.length >= MAX_CUSTOM_TESTS) return;
    setTestCases(prev => [...prev, emptyTestCase(problem)]);
    setActiveTestCaseIdx(testCases.length);
  };

  const handleRemoveTestCase = (idx) => {
    if (testCases.length <= 1) return;
    setTestCases(prev => {
      const next = [...prev];
      next.splice(idx, 1);
      return next;
    });
    setActiveTestCaseIdx(prev => prev >= idx ? Math.max(0, prev - 1) : prev);
  };

  if (!problem) return <div className="container flex-center" style={{ height: '100vh' }}><Loader2 className="spin" size={48} color="var(--primary)" /></div>;

  if (problem.locked) {
    return (
      <div className="container fade-in" style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="problem-card text-center" style={{ maxWidth: '480px', padding: '48px 40px' }}>
          <div style={{ padding: '16px', background: 'rgba(99, 102, 241, 0.1)', borderRadius: '50%', width: 'fit-content', margin: '0 auto 24px' }}>
            <Lock size={32} color="var(--primary)" />
          </div>
          <h2 className="mb-2">This is a Premium Problem</h2>
          <p className="text-muted mb-6">
            {isCollegeAdmin
              ? "Upgrade your college's plan to unlock this problem for your students."
              : 'Ask your admin to upgrade the plan to unlock this problem.'}
          </p>
          {isCollegeAdmin ? (
            <Link to="/admin/billing" className="button">View Plans</Link>
          ) : (
            <Link to="/problems" className="button button-outline">Back to Problems</Link>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 64px)' }}>
      {successMsg && (
        <div style={{ padding: '16px 24px', background: 'var(--bg)' }}>
          <div className="success-box flex-between" style={{ maxWidth: '1400px', margin: '0 auto', padding: '12px 16px', background: 'rgba(var(--success-rgb), 0.1)', border: '1px solid var(--success)', borderRadius: 'var(--radius-md)', color: 'var(--success)' }}>
            <div className="flex-center gap-2">
              <CheckCircle2 size={18} />
              <span>{successMsg}</span>
            </div>
            <button onClick={() => setSuccessMsg('')} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', display: 'flex' }}>
              <X size={18} />
            </button>
          </div>
        </div>
      )}
      <div className="ide-layout fade-in" style={{ flex: 1 }}>
      {/* Left Panel: Problem Info */}
      <div className="ide-panel-left">
        <div className="ide-tabs">
          <div className={`ide-tab ${activeTab === 'description' ? 'active' : ''}`} onClick={() => setActiveTab('description')}>
            <div className="flex-center gap-2"><Info size={16} /> Description</div>
          </div>
          <div className={`ide-tab ${activeTab === 'submissions' ? 'active' : ''}`} onClick={() => setActiveTab('submissions')}>
            <div className="flex-center gap-2"><History size={16} /> Submissions</div>
          </div>
        </div>

        <div className="ide-content">
          {activeTab === 'description' ? (
            <div>
              <div className="flex-between mb-4">
                <Link to="/problems" className="text-muted flex-center gap-2" style={{ width: 'fit-content', fontSize: '0.85rem' }}>
                  <ChevronLeft size={16} /> Back to Problems
                </Link>
                {canManage && (
                  <Link to={`/problems/${_id}/edit`} className="text-muted flex-center gap-2" style={{ fontSize: '0.85rem' }}>
                    <Edit2 size={16} /> Edit Problem
                  </Link>
                )}
              </div>
              <h1 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>{problem.title}</h1>
              <div className="flex-gap mb-4">
                <span className={`tag difficulty-${problem.difficulty.toLowerCase()}`}>{problem.difficulty}</span>
                {(problem.tags || []).map(tag => <span key={tag} className="tag">{tag}</span>)}
              </div>

              <div style={{ fontSize: '0.95rem', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', marginBottom: '2rem' }}>
                {problem.description}
              </div>

              <div style={{ background: 'var(--surface)', padding: '20px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)' }}>
                <h4 style={{ fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '1rem' }}>Problem Specs</h4>
                <div style={{ display: 'grid', gap: '12px', fontSize: '0.9rem' }}>
                  <div className="flex-between">
                    <span className="text-muted">Function</span>
                    <code style={{ color: 'var(--primary)', background: 'transparent' }}>{problem.functionName}</code>
                  </div>
                  <div className="flex-between">
                    <span className="text-muted">Return Type</span>
                    <code style={{ color: 'var(--success)', background: 'transparent' }}>{problem.returnType}</code>
                  </div>
                  <div className="mt-2">
                    <span className="text-muted">Parameters</span>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px' }}>
                      {(problem.parameters || []).map(p => (
                        <span key={p.name} style={{ background: 'var(--bg)', padding: '2px 10px', borderRadius: '4px', fontSize: '0.8rem', border: '1px solid var(--border)' }}>
                          {p.name}: <span style={{ color: 'var(--warning)' }}>{p.type}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {stats && (
                <div className="mt-8 flex-between" style={{ padding: '16px 0', borderTop: '1px solid var(--border)' }}>
                  <div className="text-center">
                    <div className="text-muted" style={{ fontSize: '0.7rem', textTransform: 'uppercase', fontWeight: '800' }}>Acceptance</div>
                    <div style={{ fontSize: '1.1rem', fontWeight: '700' }}>{stats.acceptanceRate.toFixed(1)}%</div>
                  </div>
                  <div className="text-center">
                    <div className="text-muted" style={{ fontSize: '0.7rem', textTransform: 'uppercase', fontWeight: '800' }}>Submissions</div>
                    <div style={{ fontSize: '1.1rem', fontWeight: '700' }}>{stats.totalSubmissions}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-muted" style={{ fontSize: '0.7rem', textTransform: 'uppercase', fontWeight: '800' }}>Avg Runtime</div>
                    <div style={{ fontSize: '1.1rem', fontWeight: '700' }}>{stats.averageRuntimeMs ? `${stats.averageRuntimeMs.toFixed(0)}ms` : 'N/A'}</div>
                  </div>
                </div>
              )}
            </div>
          ) : !isAuthed ? (
            <div className="text-center mt-8">
              <p className="text-muted">Sign in to view your submission history for this problem.</p>
            </div>
          ) : (
            <div className="fade-in">
              <h3 className="mb-6" style={{ fontSize: '1.25rem' }}>Your Submissions</h3>
              {loadingSubmissions ? (
                <div className="flex-center mt-8"><Loader2 className="spin" size={24} color="var(--primary)" /></div>
              ) : mySubmissions.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {mySubmissions.map(sub => (
                    <div key={sub._id} style={{ background: 'var(--surface)', padding: '16px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div className={`tag ${sub.status === 'Success' || sub.status === 'Accepted' ? 'difficulty-easy' : (['Fail', 'Error', 'Time Limit Exceeded', 'Runtime Error', 'Wrong Answer'].includes(sub.status) ? 'difficulty-hard' : 'difficulty-medium')}`} style={{ marginBottom: '8px' }}>
                          {sub.status}
                        </div>
                        <div className="text-muted flex-center gap-2" style={{ fontSize: '0.85rem', justifyContent: 'flex-start' }}>
                          <span style={{ textTransform: 'capitalize' }}>{sub.language}</span>
                          <span>•</span>
                          <span>{new Date(sub.createdAt).toLocaleString()}</span>
                        </div>
                      </div>
                      <button 
                        className="button button-outline" 
                        style={{ padding: '6px 12px', fontSize: '0.85rem' }}
                        onClick={() => {
                          setSubmission(sub);
                          setRunResult(null);
                          setShowConsole(true);
                          setConsoleTab('result');
                        }}
                      >
                        View Result
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center mt-8 p-6" style={{ background: 'var(--surface)', borderRadius: 'var(--radius-lg)', border: '1px dashed var(--border)' }}>
                  <p className="text-muted mb-0">You haven't made any submissions for this problem yet.</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Right Panel: Editor */}
      <div className="ide-panel-right">
        <div className="ide-toolbar">
          <div className="flex-center gap-4">
            <div className="flex-center gap-2">
              <span style={{ fontSize: '0.75rem', fontWeight: '700', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Language</span>
              <select
                value={selectedLanguage}
                onChange={(e) => setSelectedLanguage(e.target.value)}
                style={{ width: 'auto', padding: '4px 8px', fontSize: '0.85rem', background: 'var(--bg)' }}
              >
                {SUPPORTED_LANGUAGES.map(lang => <option key={lang} value={lang}>{lang}</option>)}
              </select>
            </div>
            <div className="flex-center gap-2">
              <Settings2 size={16} className="text-muted" />
              <span className="text-muted" style={{ fontSize: '0.85rem' }}>Auto-save</span>
            </div>
          </div>
          <div className="flex-center gap-2">
            {!isAuthed && <span style={{ color: 'var(--error)', fontSize: '0.8rem' }}>Login to run code</span>}
            <button onClick={handleRun} disabled={!isAuthed || isRunning || submission?.status === 'Submitting...'} className="button button-outline" style={{ height: '36px', padding: '0 16px', fontSize: '0.85rem', borderColor: 'rgba(255,255,255,0.1)' }}>
              <Play size={14} /> Run
            </button>
            <button onClick={handleSubmit} disabled={!isAuthed || isRunning || submission?.status === 'Submitting...'} className="button button-primary" style={{ height: '36px', padding: '0 20px', fontSize: '0.85rem' }}>
              <Send size={14} /> Submit
            </button>
          </div>
        </div>

        <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
          <Editor
            height="100%"
            defaultLanguage={selectedLanguage}
            language={selectedLanguage === 'python' ? 'python' : selectedLanguage === 'javascript' ? 'javascript' : selectedLanguage}
            theme="modern-dark"
            value={code}
            onChange={(val) => setCode(val)}
            beforeMount={defineModernDarkTheme}
            options={MONACO_EDITOR_OPTIONS}
          />
        </div>

        {/* Developer Console Drawer */}
        <div className="console-drawer" style={{ height: showConsole ? '35%' : '44px' }}>
          <div className="console-header">
            <div className="console-tabs">
              <button 
                className={`console-tab ${consoleTab === 'testcases' ? 'active' : ''}`} 
                onClick={() => { setConsoleTab('testcases'); setShowConsole(true); }}
              >
                Testcases
              </button>
              <button 
                className={`console-tab ${consoleTab === 'console' ? 'active' : ''}`} 
                onClick={() => { setConsoleTab('console'); setShowConsole(true); }}
              >
                Console
              </button>
              <button 
                className={`console-tab ${consoleTab === 'result' ? 'active' : ''}`} 
                onClick={() => { setConsoleTab('result'); setShowConsole(true); }}
              >
                Result
              </button>
            </div>
            <div className="flex-center gap-2">
              <button className="text-muted flex-center" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }} onClick={() => setShowConsole(!showConsole)}>
                {showConsole ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
              </button>
            </div>
          </div>

          {showConsole && (
            <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
              {(isRunning || submission?.status === 'Submitting...') ? (
                <div className="flex-center fade-in" style={{ height: '100%', flexDirection: 'column', gap: '16px' }}>
                  <Loader2 className="spin" size={32} color="var(--primary)" />
                  <p className="text-muted" style={{ fontWeight: '600', letterSpacing: '0.05em', textTransform: 'uppercase', fontSize: '0.85rem' }}>
                    {isRunning ? 'Executing Code...' : 'Judging Submission...'}
                  </p>
                </div>
              ) : (
                <>
                  {consoleTab === 'testcases' && (
                    <div className="fade-in">
                      <div className="flex-between mb-4">
                        <div className="flex-center gap-2" style={{ overflowX: 'auto', paddingBottom: '4px' }}>
                          {testCases.map((tc, idx) => (
                            <button 
                              key={idx} 
                              onClick={() => setActiveTestCaseIdx(idx)} 
                              className="button"
                              style={{ 
                                padding: '4px 12px', 
                                fontSize: '0.8rem',
                                borderRadius: '100px',
                                background: activeTestCaseIdx === idx ? 'var(--primary-glow)' : 'var(--bg)',
                                color: activeTestCaseIdx === idx ? 'var(--primary)' : 'var(--text-secondary)',
                                border: `1px solid ${activeTestCaseIdx === idx ? 'var(--primary)' : 'var(--border)'}` 
                              }}
                            >
                              Case {idx + 1}
                            </button>
                          ))}
                          <button 
                            onClick={handleAddTestCase} 
                            disabled={testCases.length >= MAX_CUSTOM_TESTS}
                            title={testCases.length >= MAX_CUSTOM_TESTS ? `At most ${MAX_CUSTOM_TESTS} test cases` : undefined}
                            className="button"
                            style={{ padding: '4px 12px', fontSize: '0.8rem', borderRadius: '100px', background: 'var(--bg)', border: '1px dashed var(--border)', color: 'var(--text-secondary)' }}
                          >
                            + Add Case
                          </button>
                        </div>
                        {testCases.length > 1 && (
                          <button onClick={() => handleRemoveTestCase(activeTestCaseIdx)} className="text-muted" style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
                            <Trash2 size={16} />
                          </button>
                        )}
                      </div>

                      <div>
                        <label style={{ fontSize: '0.75rem', fontWeight: '600', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px', display: 'block' }}>{isStdinProblem(problem) ? 'Input (what your program reads)' : 'JSON Input Array'}</label>
                        <textarea
                          value={testCases[activeTestCaseIdx]}
                          onChange={(e) => handleTestCaseChange(activeTestCaseIdx, e.target.value)}
                          placeholder={isStdinProblem(problem) ? 'e.g.\n3\n1 2 3' : 'e.g., [[2,7,11,15], 9]'}
                          style={{ height: '120px', fontSize: '0.9rem', fontFamily: "'JetBrains Mono', monospace", background: 'var(--bg)', width: '100%', padding: '12px', borderRadius: '8px', border: '1px solid var(--border)', color: 'var(--text)' }}
                        />
                      </div>
                    </div>
                  )}

                  {consoleTab === 'result' && (
                    <div className="fade-in">
                      {runResult && <SubmissionOutput output={runResult} />}
                      {submission && !runResult && <SubmissionOutput output={submission} />}
                      {!runResult && !submission && (
                        <div className="flex-center" style={{ height: '100px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                          Run your code to see results here.
                        </div>
                      )}
                    </div>
                  )}

                  {consoleTab === 'console' && (
                    <div className="fade-in">
                      <div className="flex-center" style={{ height: '100px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                        Raw stdout logs will appear here during execution.
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
    </div>
  );
};

export default ProblemPage;
