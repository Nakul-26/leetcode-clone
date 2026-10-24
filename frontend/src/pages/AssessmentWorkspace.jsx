import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Editor from '@monaco-editor/react';
import { Clock, CheckCircle2, ChevronRight, Terminal, Play, Send, Info, Code2, AlertCircle, ChevronDown, ChevronUp, Loader2, Trash2, Megaphone, AlertTriangle } from 'lucide-react';
import api, { assessments } from '../api';
import SubmissionOutput from '../components/SubmissionOutput';
import { starterCode } from '../utils/buildTemplate';
import { SUPPORTED_LANGUAGES } from '../utils/languages';
import { defineModernDarkTheme, MONACO_EDITOR_OPTIONS } from '../utils/editorTheme';
import { buildCustomTests, initialTestCases, emptyTestCase, isStdinProblem, MAX_CUSTOM_TESTS } from '../utils/buildCustomTests';

function loadDraft(attemptId) {
  try {
    return JSON.parse(localStorage.getItem(`assessment-draft:${attemptId}`) || '{}');
  } catch {
    localStorage.removeItem(`assessment-draft:${attemptId}`);
    return {};
  }
}

// Computes remaining seconds against a server-derived endTimeMs using a monotonic
// performance.now() delta rather than repeatedly sampling Date.now(). Date.now() is only
// read once, to establish the anchor at the very start of the session (attemptStartAnchor
// below) - after that, elapsed time is tracked via performance.now(), which is guaranteed
// monotonic and immune to the student rolling their system clock backward mid-exam.
function computeRemainingSeconds(endTimeMs, anchor) {
  if (!anchor) return Math.max(0, Math.floor((endTimeMs - Date.now()) / 1000));
  const effectiveNow = anchor.wallNow0 + (performance.now() - anchor.perfNow0);
  return Math.max(0, Math.floor((endTimeMs - effectiveNow) / 1000));
}

const AssessmentWorkspace = () => {
  const { attemptId } = useParams();
  const navigate = useNavigate();
  
  const [attempt, setAttempt] = useState(null);
  const [assessment, setAssessment] = useState(null);
  const [problems, setProblems] = useState([]);
  const [currentProblemIndex, setCurrentProblemIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [codeMap, setCodeMap] = useState({}); // problemId -> code
  const [langMap, setLangMap] = useState({}); // problemId -> language
  const [mcqAnswerMap, setMcqAnswerMap] = useState({}); // problemId -> selected option indexes
  const [subjectiveAnswerMap, setSubjectiveAnswerMap] = useState({}); // problemId -> free-text answer
  const [submissionMap, setSubmissionMap] = useState({}); // problemId -> submission object
  const intervalRefs = useRef({}); // problemId -> intervalId
  const finishStartedRef = useRef(false);
  const timeAnchorRef = useRef(null); // { wallNow0, perfNow0 } - set once, see computeRemainingSeconds

  const [timeLeft, setTimeLeft] = useState(null);
  const [showConsole, setShowConsole] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const [consoleTab, setConsoleTab] = useState('testcases');
  const [tabSwitchCount, setTabSwitchCount] = useState(0);
  const [, setCopyCount] = useState(0);
  const [, setPasteCount] = useState(0);
  const [announcements, setAnnouncements] = useState([]);
  const [showAnnouncementsModal, setShowAnnouncementsModal] = useState(false);
  const [activeNotification, setActiveNotification] = useState(null);
  const [lastSeenAnnouncementTime, setLastSeenAnnouncementTime] = useState(() => {
    return localStorage.getItem(`last-seen-announce:${attemptId}`) || new Date().toISOString();
  });
  const [showTabWarning, setShowTabWarning] = useState(false);
  const [securityWarningCount, setSecurityWarningCount] = useState(0);
  const [fsExitWarning, setFsExitWarning] = useState(false);
  const [fsWarningTimeLeft, setFsWarningTimeLeft] = useState(0);
  const [fsWarningReason, setFsWarningReason] = useState('');
  const fsIntervalRef = useRef(null);

  const [testCasesMap, setTestCasesMap] = useState({});
  const [activeTestCaseIdxMap, setActiveTestCaseIdxMap] = useState({});
  const [draftConflict, setDraftConflict] = useState(false);
  const finishAttempt = useCallback(async () => {
    if (finishStartedRef.current) return;
    finishStartedRef.current = true;
    try {
      await assessments.submitAttempt(attemptId);
      if (document.fullscreenElement) {
        await document.exitFullscreen().catch(() => {});
      }
      localStorage.removeItem(`assessment-draft:${attemptId}`);
      navigate(`/assessment-attempt/${attemptId}/result`);
    } catch (err) {
      finishStartedRef.current = false;
      setError(err.response?.data?.msg || 'Failed to submit assessment');
    }
  }, [attemptId, navigate]);

  const recordSecurityViolation = useCallback((eventType) => {
    assessments.logEvent(attemptId, eventType).catch(() => {});
    setSecurityWarningCount((prev) => prev + 1);
    setShowTabWarning(true);
    window.setTimeout(() => setShowTabWarning(false), 5000);
  }, [attemptId]);

  const startSecurityCountdown = useCallback((reason) => {
    setFsExitWarning(true);
    setFsWarningReason(reason);
    setFsWarningTimeLeft(20);
    if (fsIntervalRef.current) clearInterval(fsIntervalRef.current);
    fsIntervalRef.current = setInterval(() => {
      setFsWarningTimeLeft((prev) => {
        if (prev <= 1) {
          if (fsIntervalRef.current) {
            clearInterval(fsIntervalRef.current);
            fsIntervalRef.current = null;
          }
          finishAttempt();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, [finishAttempt]);

  useEffect(() => {
    if (securityWarningCount >= 10) {
      finishAttempt();
    }
  }, [securityWarningCount, finishAttempt]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const attemptRes = await assessments.getAttempt(attemptId);
        const attemptData = attemptRes.data;
        setAttempt(attemptData);

        if (attemptData.status !== 'Active') {
          navigate(`/assessment-attempt/${attemptId}/result`, { replace: true });
          return;
        }

        const assessmentId = attemptData.assessmentId?._id || attemptData.assessmentId;
        const assessmentData = (await assessments.get(assessmentId)).data;
        setAssessment(assessmentData);

        const problemPromises = assessmentData.problems.map(p => api.get(`/api/v1/problems/${p.problemId._id || p.problemId}`));
        const problemResponses = await Promise.all(problemPromises);
        const fullProblems = problemResponses.map(r => r.data);
        setProblems(fullProblems);

        const savedDraft = loadDraft(attemptId);
        // The local draft always wins on merge below, but if the server has a save newer
        // than this local snapshot (e.g. the student continued the attempt on another
        // device, or the tab crashed after a server sync but before this browser's
        // localStorage caught up), that newer server-side progress is about to be
        // silently discarded — surface it instead of merging quietly.
        if (
          savedDraft.savedAt &&
          Object.keys(savedDraft.codeMap || {}).length > 0 &&
          attemptData.updatedAt &&
          new Date(attemptData.updatedAt).getTime() > savedDraft.savedAt
        ) {
          setDraftConflict(true);
        }
        const initialCodeMap = { ...(attemptData.codeDrafts?.codeMap || {}), ...(savedDraft.codeMap || {}) };
        const initialLangMap = { ...(attemptData.codeDrafts?.langMap || {}), ...(savedDraft.langMap || {}) };
        const initialProblemIdx = typeof savedDraft.currentProblemIndex === 'number'
          ? savedDraft.currentProblemIndex
          : (typeof attemptData.codeDrafts?.currentProblemIndex === 'number'
             ? attemptData.codeDrafts.currentProblemIndex
             : 0);
        setCurrentProblemIndex(initialProblemIdx);
        const initialTestCasesMap = {};
        const initialActiveIdxMap = {};

        fullProblems.forEach(p => {
          const lang = assessmentData.allowedLanguages?.[0] || 'python';
          initialLangMap[p._id] = initialLangMap[p._id] || lang;
          initialCodeMap[p._id] = initialCodeMap[p._id]
            || starterCode(initialLangMap[p._id], p);

          initialTestCasesMap[p._id] = initialTestCases(p);
          initialActiveIdxMap[p._id] = 0;
        });
        
        setCodeMap(initialCodeMap);
        setLangMap(initialLangMap);
        setTestCasesMap(initialTestCasesMap);
        setActiveTestCaseIdxMap(initialActiveIdxMap);
        setTabSwitchCount(attemptData.tabSwitchCount || 0);
        setCopyCount(attemptData.copyCount || 0);
        setPasteCount(attemptData.pasteCount || 0);

        const startTime = new Date(attemptData.startedAt).getTime();
        const graceMs = (attemptData.graceMinutes || 0) * 60 * 1000;
        const durationMs = (assessmentData.durationMinutes * 60 * 1000) + graceMs;
        const endTime = Math.min(startTime + durationMs, new Date(assessmentData.endTime).getTime() + graceMs);
        if (!timeAnchorRef.current) {
          timeAnchorRef.current = { wallNow0: Date.now(), perfNow0: performance.now() };
        }
        const remaining = computeRemainingSeconds(endTime, timeAnchorRef.current);
        setTimeLeft(remaining);

      } catch (err) {
        setError(err.response?.data?.msg || 'Failed to load assessment workspace');
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [attemptId, navigate]);

  useEffect(() => {
    if (loading || Object.keys(codeMap).length === 0) return;
    localStorage.setItem(`assessment-draft:${attemptId}`, JSON.stringify({ codeMap, langMap, currentProblemIndex, savedAt: Date.now() }));

    const timeout = setTimeout(async () => {
      try {
        await assessments.saveDraft(attemptId, { codeMap, langMap, currentProblemIndex });
      } catch (err) {
        console.error('Failed to sync draft with server:', err);
      }
    }, 2000);

    return () => clearTimeout(timeout);
  }, [attemptId, codeMap, langMap, currentProblemIndex, loading]);

  useEffect(() => () => {
    Object.values(intervalRefs.current).forEach(clearInterval);
  }, []);

  const attemptActive = timeLeft !== null && timeLeft > 0;

  useEffect(() => {
    if (!attemptActive) return;

    // Anti-cheating: Tab Switching
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        recordSecurityViolation('TAB_SWITCH');
        setTabSwitchCount(prev => prev + 1);
        startSecurityCountdown('tab switch');
      }
    };

    // Anti-cheating: Copy/Paste
    const handleCopy = (e) => {
      e.preventDefault();
      recordSecurityViolation('COPY');
      setCopyCount(prev => prev + 1);
    };

    const handlePaste = (e) => {
      e.preventDefault();
      recordSecurityViolation('PASTE');
      setPasteCount(prev => prev + 1);
    };

    const handleCut = (e) => {
      e.preventDefault();
      recordSecurityViolation('COPY');
      setCopyCount(prev => prev + 1);
    };

    const handleContextMenu = (e) => {
      e.preventDefault();
      recordSecurityViolation('COPY');
    };

    const handleSelectStart = (e) => {
      e.preventDefault();
    };

    const handleKeyDown = (e) => {
      const key = (e.key || '').toLowerCase();
      const isDevToolsShortcut =
        key === 'f12' ||
        (e.ctrlKey && e.shiftKey && ['i', 'j', 'c'].includes(key)) ||
        (e.ctrlKey && ['u', 's', 'p'].includes(key));

      if (isDevToolsShortcut) {
        e.preventDefault();
        e.stopPropagation();
        recordSecurityViolation('FULLSCREEN_EXIT');
        return;
      }

      if (e.ctrlKey && key === 'c') {
        e.preventDefault();
        e.stopPropagation();
        recordSecurityViolation('COPY');
        setCopyCount(prev => prev + 1);
      } else if (e.ctrlKey && key === 'v') {
        e.preventDefault();
        e.stopPropagation();
        recordSecurityViolation('PASTE');
        setPasteCount(prev => prev + 1);
      } else if (e.ctrlKey && key === 'x') {
        e.preventDefault();
        e.stopPropagation();
        recordSecurityViolation('COPY');
        setCopyCount(prev => prev + 1);
      }
    };

    // Anti-cheating: Fullscreen
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement) {
        assessments.logEvent(attemptId, 'FULLSCREEN_EXIT').catch(() => {});
        startSecurityCountdown('fullscreen exit');
      } else {
        // returned to fullscreen: clear warning
        assessments.logEvent(attemptId, 'RETURN').catch(() => {});
        setFsExitWarning(false);
        setFsWarningReason('');
        setFsWarningTimeLeft(0);
        if (fsIntervalRef.current) { clearInterval(fsIntervalRef.current); fsIntervalRef.current = null; }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('copy', handleCopy);
    document.addEventListener('paste', handlePaste);
    document.addEventListener('cut', handleCut);
    document.addEventListener('contextmenu', handleContextMenu);
    document.addEventListener('selectstart', handleSelectStart);
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('fullscreenchange', handleFullscreenChange);

    // Try to enter fullscreen (user must have interacted first, so we do it on a slight delay or wait for interaction)
    // Actually, browser usually blocks automatic fullscreen. We can prompt the user.
    const enterFS = () => {
       if (document.documentElement.requestFullscreen) {
         document.documentElement.requestFullscreen().catch(() => {});
       }
       document.removeEventListener('click', enterFS);
    };
    document.addEventListener('click', enterFS);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.removeEventListener('copy', handleCopy);
      document.removeEventListener('paste', handlePaste);
      document.removeEventListener('cut', handleCut);
      document.removeEventListener('contextmenu', handleContextMenu);
      document.removeEventListener('selectstart', handleSelectStart);
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('click', enterFS);
      if (fsIntervalRef.current) { clearInterval(fsIntervalRef.current); fsIntervalRef.current = null; }
    };
  }, [attemptActive, attemptId, finishAttempt, recordSecurityViolation, startSecurityCountdown]);

  useEffect(() => {
    if (!attemptActive) return;

    const timer = setInterval(() => {
      setTimeLeft(prev => {
        if (prev <= 1) {
          clearInterval(timer);
          finishAttempt();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [attemptActive, finishAttempt]);

  const assessmentId = assessment?._id;

  useEffect(() => {
    if (!assessmentId) return;

    const fetchAnnouncements = async () => {
      try {
        const [announceRes, assessmentRes, attemptRes] = await Promise.all([
          api.get(`/api/v1/assessments/${assessmentId}/announcements`),
          assessments.get(assessmentId),
          assessments.getAttempt(attemptId)
        ]);
        const list = announceRes.data || [];
        setAnnouncements(list);

        const assessmentData = assessmentRes.data;
        setAssessment(assessmentData);

        const attemptData = attemptRes.data;
        setAttempt(attemptData);

        // Dynamic timer updates (graceMinutes sync). Reuses the anchor set on initial load
        // (not a fresh Date.now() sample) so a clock rollback mid-session can't re-inflate
        // the countdown at every resync - see computeRemainingSeconds.
        const startTime = new Date(attemptData.startedAt).getTime();
        const graceMs = (attemptData.graceMinutes || 0) * 60 * 1000;
        const durationMs = (assessmentData.durationMinutes * 60 * 1000) + graceMs;
        const endTime = Math.min(startTime + durationMs, new Date(assessmentData.endTime).getTime() + graceMs);
        const remaining = computeRemainingSeconds(endTime, timeAnchorRef.current);
        setTimeLeft(remaining);

        // Check if there's any new announcement since lastSeenAnnouncementTime
        const newAnnouncements = list.filter(a => new Date(a.sentAt) > new Date(lastSeenAnnouncementTime));
        if (newAnnouncements.length > 0) {
          const latest = newAnnouncements[newAnnouncements.length - 1];
          setActiveNotification(latest);
          
          const timer = setTimeout(() => {
            setActiveNotification(null);
          }, 6000);
          return () => clearTimeout(timer);
        }
      } catch (err) {
        console.error("Failed to sync announcements and assessment state:", err);
      }
    };

    fetchAnnouncements();
    const interval = setInterval(fetchAnnouncements, 10000);
    return () => clearInterval(interval);
  }, [assessmentId, attemptId, lastSeenAnnouncementTime]);

  const currentProblem = problems[currentProblemIndex];
  const unreadAnnouncementsCount = announcements.filter(a => new Date(a.sentAt) > new Date(lastSeenAnnouncementTime)).length;

  const dismissNotification = () => {
    setActiveNotification(null);
    const nowStr = new Date().toISOString();
    setLastSeenAnnouncementTime(nowStr);
    localStorage.setItem(`last-seen-announce:${attemptId}`, nowStr);
  };

  const openAnnouncements = () => {
    setShowAnnouncementsModal(true);
    const nowStr = new Date().toISOString();
    setLastSeenAnnouncementTime(nowStr);
    localStorage.setItem(`last-seen-announce:${attemptId}`, nowStr);
    setActiveNotification(null);
  };

  const handleLanguageChange = (problemId, lang) => {
    setLangMap(prev => ({ ...prev, [problemId]: lang }));
    setCodeMap(prev => ({ 
      ...prev, 
      [problemId]: starterCode(lang, currentProblem) 
    }));
  };

  const handleCodeChange = (problemId, code) => {
    setCodeMap(prev => ({ ...prev, [problemId]: code }));
  };

  const handleTestCaseChange = (problemId, idx, value) => {
    setTestCasesMap(prev => {
      const next = [...(prev[problemId] || [])];
      next[idx] = value;
      return { ...prev, [problemId]: next };
    });
  };

  const handleAddTestCase = (problemId) => {
    if ((testCasesMap[problemId] || []).length >= MAX_CUSTOM_TESTS) return;
    const problem = problems.find(p => p._id === problemId);
    setTestCasesMap(prev => ({ ...prev, [problemId]: [...(prev[problemId] || []), emptyTestCase(problem)] }));
    setActiveTestCaseIdxMap(prev => ({ ...prev, [problemId]: (testCasesMap[problemId] || []).length }));
  };

  const handleRemoveTestCase = (problemId, idx) => {
    setTestCasesMap(prev => {
      const next = [...(prev[problemId] || [])];
      if (next.length <= 1) return prev;
      next.splice(idx, 1);
      return { ...prev, [problemId]: next };
    });
    setActiveTestCaseIdxMap(prev => {
      const currentIdx = prev[problemId] || 0;
      return { ...prev, [problemId]: currentIdx >= idx ? Math.max(0, currentIdx - 1) : currentIdx };
    });
  };

  const checkStatus = async (submissionId, problemId) => {
    try {
      const res = await api.get(`/api/v1/submissions/${submissionId}`);
      const submission = res.data;
      setSubmissionMap(prev => ({ ...prev, [problemId]: submission }));

      if (['Success', 'Fail', 'Error'].includes(submission.status)) {
        clearInterval(intervalRefs.current[problemId]);
        delete intervalRefs.current[problemId];
      }
    } catch (err) {
      console.error(err);
      clearInterval(intervalRefs.current[problemId]);
      delete intervalRefs.current[problemId];
    }
  };

  const [isRunning, setIsRunning] = useState(false);
  const [runResultMap, setRunResultMap] = useState({});

  const handleRun = async () => {
    const currentProblem = problems[currentProblemIndex];
    if (!currentProblem) return;

    setIsRunning(true);
    setShowConsole(true);
    setConsoleTab('result');
    setRunResultMap(prev => ({ ...prev, [currentProblem._id]: null }));
    setSubmissionMap(prev => ({ ...prev, [currentProblem._id]: null }));

    let tests = [];
    const tcs = testCasesMap[currentProblem._id] || ['[]'];
    try {
      tests = buildCustomTests(tcs, currentProblem);
    } catch (err) {
      console.error(err);
      setRunResultMap(prev => ({ 
        ...prev, 
        [currentProblem._id]: { status: 'Error', error: 'Invalid JSON in one of the test cases.' }
      }));
      setIsRunning(false);
      return;
    }

    try {
      const res = await api.post(`/api/v1/problems/${currentProblem._id}/run`, {
        code: codeMap[currentProblem._id],
        language: langMap[currentProblem._id],
        customTests: tests
      });
      setRunResultMap(prev => ({ ...prev, [currentProblem._id]: res.data }));
    } catch (err) {
      console.error(err);
      setRunResultMap(prev => ({ ...prev, [currentProblem._id]: { status: 'Error', error: 'Failed to run code' } }));
    } finally {
      setIsRunning(false);
    }
  };

  // mcq resolves synchronously (Success/Fail is already final in the POST response) and
  // subjective sits at 'PendingReview' until a faculty member grades it later — neither
  // has anything for checkStatus's polling loop to wait on, unlike a coding submission
  // that's still Pending/Running in judge-service-go when this call returns.
  const handleMcqOptionToggle = (problemId, optionIndex, allowMultiple) => {
    setMcqAnswerMap(prev => {
      const current = prev[problemId] || [];
      if (!allowMultiple) return { ...prev, [problemId]: [optionIndex] };
      const next = current.includes(optionIndex)
        ? current.filter(i => i !== optionIndex)
        : [...current, optionIndex];
      return { ...prev, [problemId]: next };
    });
  };

  const handleSubjectiveAnswerChange = (problemId, text) => {
    setSubjectiveAnswerMap(prev => ({ ...prev, [problemId]: text }));
  };

  const handleSubmit = async () => {
    const problemId = currentProblem._id;
    if (intervalRefs.current[problemId]) return;

    setShowConsole(true);
    setConsoleTab('result');
    setRunResultMap(prev => ({ ...prev, [problemId]: null }));

    const problemType = currentProblem.problemType || 'function';
    const basePayload = { problemId, assessmentId: assessment._id, attemptId: attempt._id };
    const payload = problemType === 'mcq'
      ? { ...basePayload, selectedOptions: mcqAnswerMap[problemId] || [] }
      : problemType === 'subjective'
        ? { ...basePayload, answerText: subjectiveAnswerMap[problemId] || '' }
        : { ...basePayload, code: codeMap[problemId], language: langMap[problemId] };

    try {
      setSubmissionMap(prev => ({ ...prev, [problemId]: { status: 'Submitting...' } }));
      const res = await api.post('/api/v1/submissions', payload);
      const newSubmission = res.data;
      setSubmissionMap(prev => ({ ...prev, [problemId]: newSubmission }));
      if (problemType === 'function') {
        intervalRefs.current[problemId] = setInterval(() => checkStatus(newSubmission._id, problemId), 2000);
      }
    } catch (err) {
      console.error(err);
      setSubmissionMap(prev => ({
        ...prev,
        [problemId]: {
          status: 'Error',
          error: err.response?.data?.msg || 'Submission failed'
        }
      }));
    }
  };

  const formatTime = (seconds) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h > 0 ? h.toString().padStart(2, '0') + ':' : ''}${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const finishAssessment = async () => {
    if (window.confirm('Are you sure you want to finish the assessment?')) {
      await finishAttempt();
    }
  };

  if (loading) return <div className="container flex-center" style={{ height: '100vh' }}><Loader2 className="spin" size={48} color="var(--primary)" /></div>;
  if (error) return <div className="container error-box">{error}</div>;
  if (!currentProblem) return <div className="container">No problems found.</div>;

  const currentSubmission = submissionMap[currentProblem._id];
  const isJudging = currentSubmission && ['Submitting...', 'Pending', 'Running'].includes(currentSubmission.status);
  const currentRunResult = runResultMap[currentProblem._id];

  const currentTestCases = testCasesMap[currentProblem._id] || ['[]'];
  const currentActiveIdx = activeTestCaseIdxMap[currentProblem._id] || 0;

  return (
    <div className="ide-layout assessment-workspace fade-in">
      {/* Draft conflict warning: this browser's saved draft is older than the server's,
          meaning progress from another session may have been overwritten by the merge. */}
      {draftConflict && (
        <div style={{
          position: 'fixed',
          top: '24px',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 99999,
          width: '480px',
          maxWidth: '90%',
          background: 'var(--surface)',
          borderRadius: 'var(--radius-md)',
          border: '2px solid var(--warning)',
          boxShadow: '0 10px 30px rgba(245, 158, 11, 0.25), 0 0 20px rgba(245, 158, 11, 0.1)',
          display: 'flex',
          gap: '16px',
          padding: '16px 20px',
          alignItems: 'flex-start'
        }}>
          <div style={{
            background: 'rgba(245, 158, 11, 0.1)',
            color: 'var(--warning)',
            padding: '8px',
            borderRadius: '50%',
            display: 'flex',
            flexShrink: 0
          }}>
            <AlertTriangle size={18} />
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span style={{ fontWeight: '700', fontSize: '0.9rem', color: 'var(--warning)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Draft conflict</span>
            <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text)', lineHeight: '1.4', fontWeight: '500' }}>
              This browser has an older saved draft than your last synced progress on the server —
              if you worked on this attempt elsewhere, that progress may not be reflected here.
            </p>
          </div>
          <button
            onClick={() => setDraftConflict(false)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: '1.1rem',
              padding: '0 4px',
              lineHeight: 1
            }}
          >
            &times;
          </button>
        </div>
      )}
      {/* Assessment Locked Overlay */}
      {assessment?.locked && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          zIndex: 999999,
          background: 'rgba(9, 9, 11, 0.96)',
          backdropFilter: 'blur(10px)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          color: 'var(--text)'
        }}>
          <div style={{
            background: 'var(--surface)',
            padding: '40px',
            borderRadius: 'var(--radius-lg)',
            border: '2px solid var(--error)',
            boxShadow: '0 0 50px rgba(239, 68, 68, 0.25)',
            maxWidth: '500px',
            width: '100%',
            textAlign: 'center'
          }}>
            <AlertTriangle size={64} color="var(--error)" style={{ margin: '0 auto 20px auto', display: 'block' }} />
            <h2 style={{ fontSize: '1.5rem', fontWeight: '800', margin: '0 0 16px 0', color: 'var(--error)' }}>
              Assessment Temporarily Locked
            </h2>
            <p style={{ fontSize: '0.95rem', color: 'var(--text-secondary)', lineHeight: '1.6', margin: '0 0 24px 0' }}>
              The faculty coordinator has temporarily locked this assessment. Code editing, execution, and submissions are paused.
            </p>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              <span className="spin" style={{ display: 'inline-block', width: '12px', height: '12px', border: '2px solid var(--text-muted)', borderTopColor: 'transparent', borderRadius: '50%' }} />
              Waiting for faculty release...
            </div>
          </div>
        </div>
      )}

      {/* Floating Announcement Popup Notification */}
      {activeNotification && (
        <div style={{
          position: 'fixed',
          top: '24px',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 99999,
          width: '480px',
          maxWidth: '90%',
          background: 'var(--surface)',
          borderRadius: 'var(--radius-md)',
          border: '2px solid var(--success)',
          boxShadow: '0 10px 30px rgba(16, 185, 129, 0.25), 0 0 20px rgba(16, 185, 129, 0.1)',
          display: 'flex',
          gap: '16px',
          padding: '16px 20px',
          alignItems: 'flex-start',
          animation: 'slideDown 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards'
        }}>
          <div style={{
            background: 'rgba(16, 185, 129, 0.1)',
            color: 'var(--success)',
            padding: '8px',
            borderRadius: '50%',
            display: 'flex',
            flexShrink: 0
          }}>
            <Megaphone size={18} />
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ fontWeight: '700', fontSize: '0.9rem', color: 'var(--success)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>New Announcement</span>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                {new Date(activeNotification.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text)', lineHeight: '1.4', fontWeight: '500' }}>
              {activeNotification.message}
            </p>
          </div>
          <button 
            onClick={dismissNotification}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: '1.1rem',
              padding: '0 4px',
              lineHeight: 1
            }}
          >
            &times;
          </button>
        </div>
      )}

      {/* Announcements History Modal */}
      {showAnnouncementsModal && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          zIndex: 10000,
          background: 'rgba(2, 6, 23, 0.8)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '20px'
        }} onClick={() => setShowAnnouncementsModal(false)}>
          <div style={{
            background: 'var(--surface)',
            padding: '28px',
            borderRadius: 'var(--radius-lg)',
            maxWidth: '560px',
            width: '100%',
            border: '1px solid var(--border)',
            boxShadow: 'var(--shadow-lg), 0 0 30px rgba(16, 185, 129, 0.05)',
            maxHeight: '80vh',
            display: 'flex',
            flexDirection: 'column'
          }} onClick={e => e.stopPropagation()}>
            <h2 className="mb-4 flex-center gap-2" style={{ justifyContent: 'flex-start' }}>
              <Megaphone size={22} color="var(--success)" /> Exam Announcements
            </h2>
            
            <div style={{
              flex: 1,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
              paddingRight: '4px'
            }}>
              {announcements.length > 0 ? (
                [...announcements].reverse().map((announce, idx) => (
                  <div key={idx} style={{
                    padding: '14px 18px',
                    background: 'var(--bg)',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border)'
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: '0.75rem', marginBottom: '6px' }}>
                      <span style={{ fontWeight: '700', color: 'var(--success)' }}>OFFICIAL BROADCAST</span>
                      <span>{new Date(announce.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                    </div>
                    <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text)', lineHeight: '1.5' }}>
                      {announce.message}
                    </p>
                  </div>
                ))
              ) : (
                <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
                  No announcements broadcasted yet.
                </div>
              )}
            </div>
            
            <button className="button button-primary w-full mt-6" onClick={() => setShowAnnouncementsModal(false)}>
              Close
            </button>
          </div>
        </div>
      )}

      <style>{`
        @keyframes slideDown {
          from { transform: translate(-50%, -40px); opacity: 0; }
          to { transform: translate(-50%, 0); opacity: 1; }
        }
      `}</style>

      {/* Instructions Modal */}
      {showInstructions && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          zIndex: 10000,
          background: 'rgba(0,0,0,0.7)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '20px'
        }} onClick={() => setShowInstructions(false)}>
          <div style={{
            background: 'var(--surface)',
            padding: '32px',
            borderRadius: 'var(--radius-lg)',
            maxWidth: '600px',
            width: '100%',
            border: '1px solid var(--border)',
            boxShadow: '0 20px 50px rgba(0,0,0,0.5)'
          }} onClick={e => e.stopPropagation()}>
            <h2 className="mb-4 flex-center gap-2" style={{ justifyContent: 'flex-start' }}>
              <Info size={24} color="var(--primary)" /> Assessment Instructions
            </h2>
            <div style={{ fontSize: '0.95rem', color: 'var(--text-secondary)', lineHeight: '1.6' }}>
              <ul style={{ paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <li><strong>Environment:</strong> You are in a secure proctored environment.</li>
                <li><strong>Fullscreen:</strong> Do not exit fullscreen. Doing so will trigger a countdown to automatic submission.</li>
                <li><strong>Tab Switching:</strong> Switching tabs or applications is strictly prohibited and logged.</li>
                <li><strong>Copy/Paste:</strong> Copying and pasting is disabled and will be recorded as a violation.</li>
                <li><strong>Saving:</strong> Your code is automatically saved locally as you type.</li>
                <li><strong>Submission:</strong> You can submit each problem multiple times; only your last successful submission counts.</li>
                <li><strong>Auto-Submit:</strong> When the main timer reaches 00:00, your assessment will be submitted automatically.</li>
              </ul>
            </div>
            <button className="button button-primary w-full mt-8" onClick={() => setShowInstructions(false)}>
              Understood
            </button>
          </div>
        </div>
      )}

      {/* Fullscreen/Security Overlay Warning */}
      {fsExitWarning && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 9999,
          background: 'rgba(0, 0, 0, 0.85)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'white',
          padding: '40px',
          textAlign: 'center',
          backdropFilter: 'blur(8px)'
        }}>
          <AlertCircle size={80} color="var(--warning)" style={{ marginBottom: '24px' }} />
          <h1 style={{ fontSize: '2.5rem', marginBottom: '16px', color: 'var(--warning)' }}>Security Violation Detected</h1>
          <p style={{ fontSize: '1.25rem', maxWidth: '600px', marginBottom: '32px', lineHeight: '1.6' }}>
            {fsWarningReason === 'fullscreen exit'
              ? `You have exited fullscreen mode. Please return to fullscreen immediately.`
              : `A security violation (${fsWarningReason}) has been detected.`}
          </p>
          <div style={{ 
            background: 'var(--error)', 
            padding: '24px 48px', 
            borderRadius: '12px', 
            fontSize: '3rem', 
            fontWeight: '800',
            marginBottom: '16px',
            boxShadow: '0 0 30px rgba(239, 68, 68, 0.4)'
          }}>
            {fsWarningTimeLeft}s
          </div>
          <p style={{ fontSize: '1rem', color: 'rgba(255,255,255,0.7)' }}>
            Assessment will be automatically submitted when the timer reaches zero.
          </p>
          <button 
            className="button button-primary" 
            style={{ marginTop: '40px', padding: '12px 32px', fontSize: '1.1rem' }}
            onClick={() => {
              if (document.documentElement.requestFullscreen) {
                document.documentElement.requestFullscreen().catch(() => {});
              }
            }}
          >
            Return to Fullscreen
          </button>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0, minWidth: 0, flex: 1 }}>
        <div className="workspace-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0, flexWrap: 'wrap' }}>
            <div style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{assessment?.title || 'Assessment'}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              <span>Violations: <strong style={{ color: securityWarningCount >= 10 ? 'var(--error)' : 'var(--warning)' }}>{securityWarningCount}</strong>/10</span>
              <span style={{ color: tabSwitchCount > 0 ? 'var(--error)' : 'var(--text-muted)', fontWeight: 600 }}>Tabs: {tabSwitchCount}</span>
            </div>
          </div>
          <div className="flex-center gap-4">
            <button 
              className="button button-outline" 
              style={{ 
                padding: '6px 12px', 
                fontSize: '0.8rem', 
                borderColor: 'var(--success)', 
                color: 'var(--success)',
                position: 'relative'
              }}
              onClick={openAnnouncements}
            >
              <Megaphone size={14} /> Announcements
              {unreadAnnouncementsCount > 0 && (
                <span style={{
                  position: 'absolute',
                  top: '-6px',
                  right: '-6px',
                  background: 'var(--error)',
                  color: 'white',
                  borderRadius: '50%',
                  padding: '2px 6px',
                  fontSize: '0.7rem',
                  fontWeight: '800',
                  boxShadow: '0 0 10px var(--error)'
                }}>
                  {unreadAnnouncementsCount}
                </span>
              )}
            </button>
            <button 
              className="button button-outline" 
              style={{ padding: '6px 12px', fontSize: '0.8rem', borderColor: 'var(--primary)', color: 'var(--primary)' }}
              onClick={() => setShowInstructions(true)}
            >
              <Info size={14} /> Instructions
            </button>
            {timeLeft < 300 && (
              <div style={{ 
                color: 'var(--error)', 
                fontWeight: '800', 
                fontSize: '0.9rem', 
                background: 'rgba(239, 68, 68, 0.1)', 
                padding: '4px 12px', 
                borderRadius: '4px',
                animation: timeLeft < 60 ? 'pulse-red 1s infinite' : 'none'
              }}>
                CLOSING SOON
              </div>
            )}
            <div style={{ fontSize: '0.85rem', color: showTabWarning || securityWarningCount > 0 ? 'var(--warning)' : 'var(--text-muted)', whiteSpace: 'nowrap', fontWeight: 700 }}>
              {showTabWarning || securityWarningCount > 0 ? 'Warning active' : 'Monitoring active'}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {/* Sidebar: Navigation & Timer */}
          <div className="workspace-sidebar" style={{ width: '320px', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', background: 'var(--bg)', minHeight: 0 }}>
            <div style={{ padding: '24px', borderBottom: '1px solid var(--border)', textAlign: 'center', background: 'var(--surface)' }}>
              <div className="flex-center gap-2 mb-2" style={{ color: 'var(--text-muted)', fontSize: '0.75rem', textTransform: 'uppercase', fontWeight: '700', letterSpacing: '0.1em' }}>
                <Clock size={14} /> Time Remaining
              </div>
              <div style={{ fontSize: '2.5rem', fontWeight: '800', color: timeLeft < 300 ? 'var(--error)' : 'var(--primary)', fontFamily: 'monospace' }}>
                {formatTime(timeLeft)}
              </div>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
              <h4 style={{ margin: '0 0 16px', fontSize: '0.85rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Problems</h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {problems.map((p, idx) => (
                  <button
                    key={p._id}
                    onClick={() => setCurrentProblemIndex(idx)}
                    className={`button ${currentProblemIndex === idx ? '' : 'button-outline'}`}
                    style={{ 
                      textAlign: 'left', 
                      justifyContent: 'flex-start',
                      padding: '12px 16px',
                      fontWeight: '600',
                      fontSize: '0.9rem',
                      border: currentProblemIndex === idx ? 'none' : '1px solid var(--border)'
                    }}
                  >
                    <span style={{ marginRight: '10px', opacity: 0.6 }}>{idx + 1}.</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}</span>
                    {submissionMap[p._id]?.status === 'Success' && <CheckCircle2 size={16} color="var(--success)" style={{ marginLeft: 'auto' }} />}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ padding: '20px', borderTop: '1px solid var(--border)', background: 'var(--surface)' }}>
              <button 
                className="button" 
                style={{ width: '100%', background: 'var(--success)', padding: '14px', fontSize: '1rem', border: 'none', boxShadow: '0 4px 12px rgba(16, 185, 129, 0.2)' }}
                onClick={finishAssessment}
              >
                <CheckCircle2 size={20} />
                Finish Assessment
              </button>
            </div>
          </div>

          <div className="workspace-main" style={{ display: 'flex', flex: 1, overflow: 'auto', minHeight: 0 }}>
            {/* Problem Description */}
            <div className="workspace-description" style={{ width: '420px', minWidth: '320px', overflowY: 'auto', padding: '32px', borderRight: '1px solid var(--border)', background: 'var(--bg)', minHeight: 0 }}>
              <h2 style={{ fontSize: '1.5rem', fontWeight: '700', marginBottom: '1rem' }}>{currentProblem.title}</h2>
              <div className="flex-gap mb-6">
                <span className={`tag difficulty-${currentProblem.difficulty.toLowerCase()}`}>{currentProblem.difficulty}</span>
                <span className="tag">Score: {assessment.problems[currentProblemIndex]?.maxScore || 100}</span>
              </div>
              
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', lineHeight: '1.7', whiteSpace: 'pre-wrap', marginBottom: '2rem' }}>
                {currentProblem.description}
              </div>
              
              <div style={{ background: 'var(--surface)', padding: '20px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)' }}>
                <h4 style={{ fontSize: '0.85rem', color: 'var(--text-main)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '1rem' }}>Specs</h4>
                {isStdinProblem(currentProblem) ? (
                <div style={{ display: 'grid', gap: '10px', fontSize: '0.9rem' }}>
                  <p style={{ whiteSpace: 'pre-wrap' }}><strong>Input:</strong> {currentProblem.inputFormat || 'Read the input from standard input.'}</p>
                  <p style={{ whiteSpace: 'pre-wrap' }}><strong>Output:</strong> {currentProblem.outputFormat || 'Print the answer to standard output.'}</p>
                </div>
                ) : (
                <div style={{ display: 'grid', gap: '10px', fontSize: '0.9rem' }}>
                  <p><strong>Function:</strong> <code style={{ color: 'var(--primary)', background: 'transparent' }}>{currentProblem.functionName}</code></p>
                  <p><strong>Return:</strong> <code style={{ color: 'var(--success)', background: 'transparent' }}>{currentProblem.returnType}</code></p>
                  <p><strong>Params:</strong> {(currentProblem.parameters || []).map(p => `${p.name} (${p.type})`).join(', ')}</p>
                </div>
                )}
              </div>
            </div>

            {/* Editor Panel */}
            <div className="workspace-editor" style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--editor-bg)', boxShadow: 'inset 1px 1px 4px rgba(0,0,0,0.2)', minHeight: 0 }}>
              <div className="ide-toolbar">
                <div className="flex-center gap-4">
                  {(currentProblem.problemType || 'function') === 'function' && (
                    <div className="flex-center gap-2">
                      <span style={{ fontSize: '0.75rem', fontWeight: '700', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Language</span>
                      <select
                        value={langMap[currentProblem._id]}
                        onChange={(e) => handleLanguageChange(currentProblem._id, e.target.value)}
                        disabled={isJudging}
                        style={{ width: 'auto', padding: '4px 8px', fontSize: '0.85rem', background: 'var(--bg)' }}
                      >
                        {(assessment.allowedLanguages?.length > 0 ? assessment.allowedLanguages : SUPPORTED_LANGUAGES).map(lang => (
                          <option key={lang} value={lang}>{lang}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
                <div className="flex-center gap-2">
                  {(currentProblem.problemType || 'function') === 'function' && (
                    <button onClick={handleRun} disabled={isRunning || isJudging} className="button button-outline" style={{ height: '36px', padding: '0 16px', fontSize: '0.85rem', borderColor: 'rgba(255,255,255,0.1)' }}>
                      <Play size={14} /> Run
                    </button>
                  )}
                  <button onClick={handleSubmit} disabled={isRunning || isJudging} className="button button-primary" style={{ height: '36px', padding: '0 20px', fontSize: '0.85rem' }}>
                    <Send size={14} /> Submit
                  </button>
                </div>
              </div>

              <div style={{ flex: 1, position: 'relative', minHeight: 0, overflowY: 'auto' }}>
                {(currentProblem.problemType || 'function') === 'function' && (
                  <Editor
                    height="100%"
                    language={langMap[currentProblem._id] === 'python' ? 'python' : langMap[currentProblem._id] === 'javascript' ? 'javascript' : langMap[currentProblem._id]}
                    theme="modern-dark"
                    value={codeMap[currentProblem._id]}
                    onChange={(val) => handleCodeChange(currentProblem._id, val)}
                    beforeMount={defineModernDarkTheme}
                    options={MONACO_EDITOR_OPTIONS}
                  />
                )}

                {currentProblem.problemType === 'mcq' && (
                  <div style={{ padding: '32px', maxWidth: '640px' }}>
                    {currentSubmission && currentSubmission.status !== 'Submitting...' && (
                      <div
                        className={currentSubmission.status === 'Success' ? 'success-text' : 'error-text'}
                        style={{ marginBottom: '20px', fontWeight: '600' }}
                      >
                        {currentSubmission.status === 'Success' ? '✓ Correct' : currentSubmission.status === 'Fail' ? '✗ Incorrect' : currentSubmission.error || currentSubmission.status}
                      </div>
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      {(currentProblem.options || []).map((opt, idx) => (
                        <label
                          key={idx}
                          className="flex-center gap-2"
                          style={{
                            justifyContent: 'flex-start',
                            cursor: 'pointer',
                            padding: '14px 16px',
                            borderRadius: 'var(--radius-md)',
                            border: `1px solid ${(mcqAnswerMap[currentProblem._id] || []).includes(idx) ? 'var(--primary)' : 'var(--border)'}`,
                            background: (mcqAnswerMap[currentProblem._id] || []).includes(idx) ? 'var(--primary-glow)' : 'var(--surface)'
                          }}
                        >
                          <input
                            type={currentProblem.allowMultipleAnswers ? 'checkbox' : 'radio'}
                            name={`mcq-${currentProblem._id}`}
                            checked={(mcqAnswerMap[currentProblem._id] || []).includes(idx)}
                            onChange={() => handleMcqOptionToggle(currentProblem._id, idx, currentProblem.allowMultipleAnswers)}
                            disabled={isJudging}
                            style={{ width: 'auto' }}
                          />
                          <span>{opt.text}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {currentProblem.problemType === 'subjective' && (
                  <div style={{ padding: '32px', maxWidth: '720px', height: '100%', display: 'flex', flexDirection: 'column' }}>
                    {currentSubmission && currentSubmission.status !== 'Submitting...' && (
                      <div className="success-text" style={{ marginBottom: '16px', fontWeight: '600' }}>
                        {currentSubmission.status === 'PendingReview' && 'Submitted — awaiting grading by faculty.'}
                        {currentSubmission.status === 'Graded' && `Graded: ${currentSubmission.score} — ${currentSubmission.feedback || 'No feedback given'}`}
                        {currentSubmission.status === 'Error' && (currentSubmission.error || 'Submission failed')}
                      </div>
                    )}
                    <textarea
                      value={subjectiveAnswerMap[currentProblem._id] || ''}
                      onChange={(e) => handleSubjectiveAnswerChange(currentProblem._id, e.target.value)}
                      placeholder="Write your answer here..."
                      disabled={isJudging}
                      style={{ flex: 1, minHeight: '300px', fontSize: '0.95rem', lineHeight: '1.6', padding: '16px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', resize: 'vertical' }}
                    />
                    {currentProblem.maxWords && (
                      <p className="form-hint mt-2">
                        {(subjectiveAnswerMap[currentProblem._id] || '').trim().split(/\s+/).filter(Boolean).length} / {currentProblem.maxWords} words
                      </p>
                    )}
                  </div>
                )}
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
                    {(isRunning || isJudging) ? (
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
                                {currentTestCases.map((tc, idx) => (
                                  <button 
                                    key={idx} 
                                    onClick={() => setActiveTestCaseIdxMap(prev => ({ ...prev, [currentProblem._id]: idx }))} 
                                    className="button"
                                    style={{ 
                                      padding: '4px 12px', 
                                      fontSize: '0.8rem',
                                      borderRadius: '100px',
                                      background: currentActiveIdx === idx ? 'var(--primary-glow)' : 'var(--bg)',
                                      color: currentActiveIdx === idx ? 'var(--primary)' : 'var(--text-secondary)',
                                      border: `1px solid ${currentActiveIdx === idx ? 'var(--primary)' : 'var(--border)'}` 
                                    }}
                                  >
                                    Case {idx + 1}
                                  </button>
                                ))}
                                <button 
                                  onClick={() => handleAddTestCase(currentProblem._id)} 
                                  disabled={currentTestCases.length >= MAX_CUSTOM_TESTS}
                                  title={currentTestCases.length >= MAX_CUSTOM_TESTS ? `At most ${MAX_CUSTOM_TESTS} test cases` : undefined}
                                  className="button"
                                  style={{ padding: '4px 12px', fontSize: '0.8rem', borderRadius: '100px', background: 'var(--bg)', border: '1px dashed var(--border)', color: 'var(--text-secondary)' }}
                                >
                                  + Add Case
                                </button>
                              </div>
                              {currentTestCases.length > 1 && (
                                <button onClick={() => handleRemoveTestCase(currentProblem._id, currentActiveIdx)} className="text-muted" style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
                                  <Trash2 size={16} />
                                </button>
                              )}
                            </div>

                            <div>
                              <label style={{ fontSize: '0.75rem', fontWeight: '600', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px', display: 'block' }}>{isStdinProblem(currentProblem) ? 'Input (what your program reads)' : 'JSON Input Array'}</label>
                              <textarea
                                value={currentTestCases[currentActiveIdx] || ''}
                                onChange={(e) => handleTestCaseChange(currentProblem._id, currentActiveIdx, e.target.value)}
                                placeholder={isStdinProblem(currentProblem) ? 'e.g.\n3\n1 2 3' : 'e.g., [[2,7,11,15], 9]'}
                                style={{ height: '120px', fontSize: '0.9rem', fontFamily: "'JetBrains Mono', monospace", background: 'var(--bg)', width: '100%', padding: '12px', borderRadius: '8px', border: '1px solid var(--border)', color: 'var(--text)' }}
                              />
                            </div>
                          </div>
                        )}

                        {consoleTab === 'result' && (
                          <div className="fade-in">
                            {currentRunResult && <SubmissionOutput output={currentRunResult} />}
                            {currentSubmission && !currentRunResult && <SubmissionOutput output={currentSubmission} />}
                            {!currentRunResult && !currentSubmission && (
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
      
      </div>

    </div>
  );
};

export default AssessmentWorkspace;
