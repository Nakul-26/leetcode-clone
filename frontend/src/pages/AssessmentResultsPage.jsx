import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Download, Users, CheckCircle, Clock, AlertCircle, Search, RefreshCw, BarChart3, ChevronRight, FileSpreadsheet, MonitorOff, Copy, ClipboardPaste, Maximize, AlertTriangle, Trophy, Megaphone, Lock, Unlock, PenLine } from 'lucide-react';
import { downloadRowsAsExcel } from '../utils/excel';
import api, { assessments } from '../api';

const AssessmentResultsPage = () => {
  const { id } = useParams();
  const [assessment, setAssessment] = useState(null);
  const [attendance, setAttendance] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [riskFilter, setRiskFilter] = useState('');
  const [announcementText, setAnnouncementText] = useState('');
  const [activeTab, setActiveTab] = useState('attendance'); // 'attendance' or 'analytics'
  const [selectedChallengeAttempt, setSelectedChallengeAttempt] = useState(null);
  const [resolveComment, setResolveComment] = useState('');
  const [resolving, setResolving] = useState(false);

  const fetchData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    
    try {
      const [assessmentRes, attendanceRes, analyticsRes] = await Promise.all([
        assessments.get(id),
        assessments.getAttendance(id),
        assessments.getAnalytics(id)
      ]);
      setAssessment(assessmentRes.data);
      setAttendance(attendanceRes.data);
      setAnalytics(analyticsRes.data);
    } catch (err) {
      setError(err.response?.data?.msg || 'Failed to fetch results');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  const handleSendAnnouncement = async () => {
    if (!announcementText.trim()) return;
    try {
      await api.post(`/api/v1/assessments/${id}/announcements`, { message: announcementText });
      setAnnouncementText('');
      fetchData(true);
    } catch (err) {
      alert(err.response?.data?.msg || 'Failed to send announcement');
    }
  };

  const handleRejudgeAssessment = async () => {
    if (!window.confirm("Are you sure you want to rejudge all submissions for this entire assessment? This will reset all student scores and queue them for evaluation. This action is irreversible.")) {
      return;
    }
    try {
      setRefreshing(true);
      await api.post(`/api/v1/admin/rejudge/assessment/${id}`);
      alert("Rejudging scheduled successfully for all submissions. Dashboard stats will refresh dynamically as tests complete.");
      fetchData(true);
    } catch (err) {
      alert(err.response?.data?.error || "Failed to trigger rejudge");
    } finally {
      setRefreshing(false);
    }
  };

  const handleRejudgeProblem = async (problemId, problemTitle) => {
    if (!window.confirm(`Are you sure you want to rejudge all submissions for "${problemTitle}" in this assessment?`)) {
      return;
    }
    try {
      setRefreshing(true);
      await api.post(`/api/v1/admin/rejudge/problem/${problemId}?assessmentId=${id}`);
      alert(`Rejudging scheduled successfully for challenge: ${problemTitle}.`);
      fetchData(true);
    } catch (err) {
      alert(err.response?.data?.error || "Failed to trigger rejudge");
    } finally {
      setRefreshing(false);
    }
  };

  const handleToggleLock = async () => {
    const isLocking = !assessment.locked;
    const confirmMessage = isLocking
      ? "Are you sure you want to LOCK this assessment? Students will be blocked from editing code, running tests, or making submissions immediately."
      : "Are you sure you want to UNLOCK this assessment? Students will be allowed to resume work.";
    
    if (!window.confirm(confirmMessage)) return;

    try {
      setRefreshing(true);
      if (isLocking) {
        await assessments.lock(id);
      } else {
        await assessments.unlock(id);
      }
      alert(`Assessment ${isLocking ? 'locked' : 'unlocked'} successfully.`);
      fetchData(true);
    } catch (err) {
      alert(err.response?.data?.msg || `Failed to ${isLocking ? 'lock' : 'unlock'} assessment`);
    } finally {
      setRefreshing(false);
    }
  };

  const handleAddGrace = async (attemptId, studentName) => {
    const minsStr = window.prompt(`Add grace time for ${studentName} (minutes):`, "10");
    if (minsStr === null) return;
    const mins = parseInt(minsStr, 10);
    if (isNaN(mins) || mins <= 0) {
      alert("Please enter a valid positive number of minutes.");
      return;
    }

    try {
      setRefreshing(true);
      await assessments.addGraceTime(attemptId, mins);
      alert(`Successfully added +${mins} minutes of grace time to ${studentName}.`);
      fetchData(true);
    } catch (err) {
      alert(err.response?.data?.msg || "Failed to add grace time");
    } finally {
      setRefreshing(false);
    }
  };

  const handleOpenReviewChallenge = (studentAttempt) => {
    setSelectedChallengeAttempt(studentAttempt);
    setResolveComment(studentAttempt.challenge?.facultyComment || '');
  };

  const handleResolveChallenge = async (status) => {
    if (!selectedChallengeAttempt) return;
    setResolving(true);
    try {
      await assessments.resolveChallenge(selectedChallengeAttempt.attemptId, status, resolveComment);
      alert(`Appeal successfully ${status.toLowerCase()}!`);
      setSelectedChallengeAttempt(null);
      fetchData(true);
    } catch (err) {
      alert(err.response?.data?.msg || `Failed to resolve challenge`);
    } finally {
      setResolving(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(() => fetchData(true), 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const calculateRiskLevel = (a) => {
    let score = 0;
    if (a.tabSwitchCount > 5) score += 2;
    if (a.tabSwitchCount > 15) score += 3;
    if (a.copyCount > 10) score += 1;
    if (a.pasteCount > 5) score += 2;
    if (a.fullscreenExitCount > 0) score += 3;

    if (score >= 5) return 'High';
    if (score >= 2) return 'Medium';
    return 'Low';
  };

  const exportToExcel = () => {
    const data = attendance.map(a => {
      const timeUsed = a.submittedAt && a.startedAt
        ? `${Math.floor((new Date(a.submittedAt) - new Date(a.startedAt)) / 60000)} min`
        : 'N/A';
      const percentage = maxPossibleScore > 0 ? `${Math.round(((a.score || 0) / maxPossibleScore) * 100)}%` : '0%';
      return {
        'USN': a.usn || 'N/A',
        'Name': a.name,
        'Section': a.section || 'N/A',
        'Score': a.score || 0,
        'Percentage': percentage,
        'Start Time': a.startedAt ? new Date(a.startedAt).toLocaleString() : 'N/A',
        'End Time': a.submittedAt ? new Date(a.submittedAt).toLocaleString() : 'N/A',
        'Duration': timeUsed,
        'Tab Switches': a.tabSwitchCount || 0,
        'Fullscreen Exits': a.fullscreenExitCount || 0,
        'Risk Score': calculateRiskLevel(a),
        'Status': a.status
      };
    });

    downloadRowsAsExcel(`${assessment.title.replace(/\s+/g, '_')}_Results.xlsx`, "Assessment Results", data, { autoSizeColumns: true });
  };

  if (loading && !assessment) return <div className="container">Loading results dashboard...</div>;
  if (error) return <div className="container error-box">{error}</div>;

  const filteredAttendance = attendance.filter(a => {
    const name = a.name || '';
    const email = a.email || '';
    const matchesSearch = name.toLowerCase().includes(search.toLowerCase()) || email.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === '' || a.status === statusFilter;
    const matchesRisk = riskFilter === '' || calculateRiskLevel(a) === riskFilter;
    return matchesSearch && matchesStatus && matchesRisk;
  });

  const activeOrCompleted = attendance.filter(a => a.status !== 'Not Started');
  const completedAttempts = attendance.filter(a => a.status === 'Submitted' || a.status === 'TimedOut');
  
  const maxPossibleScore = assessment.problems?.reduce((acc, p) => acc + (p.maxScore || 100), 0) || 100;
  
  const stats = {
    total: attendance.length,
    started: activeOrCompleted.length,
    submitted: completedAttempts.length,
    avgScore: completedAttempts.length > 0
      ? (completedAttempts.reduce((acc, a) => acc + (a.score || 0), 0) / completedAttempts.length).toFixed(1)
      : 0,
    passRate: completedAttempts.length > 0
      ? ((completedAttempts.filter(a => (a.score || 0) >= (maxPossibleScore * 0.4)).length / completedAttempts.length) * 100).toFixed(0)
      : 0,
    highRisk: attendance.filter(a => calculateRiskLevel(a) === 'High').length
  };

  // Top Performers (Top 3)
  const topPerformers = [...attendance]
    .filter(a => a.status === 'Submitted' || a.status === 'TimedOut')
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 3);

  const getStatusTagClass = (status) => {
    switch (status) {
      case 'Submitted': return 'difficulty-easy';
      case 'Active': return 'difficulty-medium';
      case 'TimedOut': return 'difficulty-hard';
      case 'Not Started': return '';
      default: return '';
    }
  };

  const getRiskTagStyle = (risk) => {
    switch (risk) {
      case 'High': return { background: 'rgba(239, 68, 68, 0.1)', color: 'var(--error)', border: '1px solid rgba(239, 68, 68, 0.3)' };
      case 'Medium': return { background: 'rgba(245, 158, 11, 0.1)', color: 'var(--warning)', border: '1px solid rgba(245, 158, 11, 0.3)' };
      case 'Low': return { background: 'rgba(16, 185, 129, 0.1)', color: 'var(--success)', border: '1px solid rgba(16, 185, 129, 0.3)' };
      default: return {};
    }
  };

  return (
    <div className="container fade-in">
      <div className="flex-between mb-8">
        <div>
          <div className="flex-center gap-2 mb-2" style={{ justifyContent: 'flex-start' }}>
            <span className="tag" style={{ background: 'var(--primary-glow)', color: 'var(--primary)', fontWeight: '700' }}>
              {new Date() <= new Date(assessment.endTime) ? 'LIVE MONITORING' : 'FINAL RESULTS'}
            </span>
            <h1 style={{ margin: 0 }}>{assessment.title}</h1>
          </div>
          <p className="text-muted">Real-time attendance and performance tracking.</p>
        </div>
        <div className="flex-center gap-3">
          <button className="button button-outline" onClick={() => fetchData(true)} disabled={refreshing}>
            <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
            Refresh
          </button>
          <Link to={`/admin/assessments/${id}/grading`} className="button button-outline">
            <PenLine size={16} />
            Grade Subjective Answers
          </Link>
          <button 
            className="button button-outline" 
            onClick={handleRejudgeAssessment} 
            disabled={refreshing}
            style={{ color: 'var(--warning)', borderColor: 'rgba(245, 158, 11, 0.4)' }}
          >
            <RefreshCw size={16} />
            Rejudge All
          </button>
          {assessment.locked ? (
            <button 
              className="button button-outline" 
              onClick={handleToggleLock} 
              disabled={refreshing}
              style={{ color: 'var(--success)', borderColor: 'rgba(16, 185, 129, 0.4)', background: 'rgba(16, 185, 129, 0.05)' }}
            >
              <Unlock size={16} />
              Unlock Assessment
            </button>
          ) : (
            <button 
              className="button button-outline" 
              onClick={handleToggleLock} 
              disabled={refreshing}
              style={{ color: 'var(--error)', borderColor: 'rgba(239, 68, 68, 0.4)', background: 'rgba(239, 68, 68, 0.05)' }}
            >
              <Lock size={16} />
              Lock Assessment
            </button>
          )}
          <button className="button button-primary" onClick={exportToExcel}>
            <FileSpreadsheet size={16} />
            Export to Excel
          </button>
        </div>
      </div>

      {/* Stats Overview */}
      <div className="grid grid-cols-4 gap-6 mb-8" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '24px' }}>
        <div className="problem-card" style={{ textAlign: 'center' }}>
          <div className="text-muted mb-2 flex-center gap-2" style={{ fontSize: '0.8rem', textTransform: 'uppercase', fontWeight: '700' }}>
            <Users size={14} /> Total Candidates
          </div>
          <div style={{ fontSize: '2rem', fontWeight: '800' }}>{stats.total}</div>
        </div>
        <div className="problem-card" style={{ textAlign: 'center' }}>
          <div className="text-muted mb-2 flex-center gap-2" style={{ fontSize: '0.8rem', textTransform: 'uppercase', fontWeight: '700' }}>
            <Clock size={14} /> Participation
          </div>
          <div style={{ fontSize: '2rem', fontWeight: '800', color: 'var(--primary)' }}>
            {stats.started} <span style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>/ {stats.total}</span>
          </div>
        </div>
        <div className="problem-card" style={{ textAlign: 'center' }}>
          <div className="text-muted mb-2 flex-center gap-2" style={{ fontSize: '0.8rem', textTransform: 'uppercase', fontWeight: '700' }}>
            <CheckCircle size={14} /> Submissions
          </div>
          <div style={{ fontSize: '2rem', fontWeight: '800', color: 'var(--success)' }}>{stats.submitted}</div>
        </div>
        <div className="problem-card" style={{ textAlign: 'center' }}>
          <div className="text-muted mb-2 flex-center gap-2" style={{ fontSize: '0.8rem', textTransform: 'uppercase', fontWeight: '700' }}>
            <BarChart3 size={14} /> Avg. Score
          </div>
          <div style={{ fontSize: '2rem', fontWeight: '800' }}>{stats.avgScore} <span style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>/ {maxPossibleScore}</span></div>
        </div>
      </div>

      {/* Insights Section */}
      <div className="grid grid-cols-3 gap-6 mb-8" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.2fr', gap: '24px' }}>
        <div className="problem-card" style={{ borderLeft: '4px solid var(--warning)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div>
            <div className="flex-between mb-4">
              <h3 className="flex-center gap-2" style={{ margin: 0 }}><AlertTriangle size={18} color="var(--warning)" /> Integrity Insights</h3>
              <span className="tag" style={getRiskTagStyle('High')}>{stats.highRisk} High Risk</span>
            </div>
            <p className="text-secondary mb-4" style={{ fontSize: '0.9rem' }}>
              {stats.highRisk > 0 
                ? `${stats.highRisk} student(s) flagged for highly suspicious activity. We recommend reviewing their detailed attempts.`
                : 'No students flagged for high-risk behavior. Academic integrity appears strong.'}
            </p>
          </div>
          <button 
            className="button button-outline" 
            style={{ padding: '6px 12px', fontSize: '0.85rem', width: 'fit-content' }}
            onClick={() => setRiskFilter('High')}
          >
            Filter High Risk
          </button>
        </div>

        <div className="problem-card" style={{ borderLeft: '4px solid var(--primary)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div>
            <div className="flex-between mb-4">
              <h3 className="flex-center gap-2" style={{ margin: 0 }}><Trophy size={18} color="var(--primary)" /> Performance Insights</h3>
              <span className="tag difficulty-easy">{stats.passRate}% Pass Rate</span>
            </div>
            <p className="text-secondary mb-3" style={{ fontSize: '0.9rem' }}>
              Top Performers:
            </p>
            {topPerformers.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {topPerformers.map((p, idx) => (
                  <div key={p.studentId} className="flex-between" style={{ background: 'var(--bg)', padding: '8px 12px', borderRadius: 'var(--radius-sm)' }}>
                    <div className="flex-center gap-2">
                      <span style={{ color: 'var(--text-muted)', fontWeight: '600' }}>#{idx + 1}</span>
                      <span style={{ fontWeight: '600', fontSize: '0.9rem' }}>{p.name}</span>
                    </div>
                    <span style={{ fontWeight: '700', color: 'var(--primary)' }}>{p.score} pts</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted" style={{ fontSize: '0.9rem' }}>No submissions yet.</p>
            )}
          </div>
        </div>

        <div className="problem-card" style={{ borderLeft: '4px solid var(--success)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div>
            <div className="flex-between mb-4">
              <h3 className="flex-center gap-2" style={{ margin: 0 }}>
                <Megaphone size={18} color="var(--success)" /> Live Announcements
              </h3>
              <span className="tag" style={{ background: 'rgba(16, 185, 129, 0.1)', color: 'var(--success)' }}>
                {assessment.announcements?.length || 0} Sent
              </span>
            </div>
            
            <div style={{
              overflowY: 'auto',
              maxHeight: '140px',
              height: '140px',
              marginBottom: '16px',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              padding: '8px',
              background: 'var(--bg)'
            }}>
              {assessment.announcements && assessment.announcements.length > 0 ? (
                [...assessment.announcements].reverse().map((announce, idx) => (
                  <div key={idx} style={{ fontSize: '0.85rem', borderBottom: idx < assessment.announcements.length - 1 ? '1px solid var(--border)' : 'none', paddingBottom: '6px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: '0.75rem', marginBottom: '2px' }}>
                      <span style={{ fontWeight: '700' }}>Broadcast</span>
                      <span>{new Date(announce.sentAt).toLocaleTimeString()}</span>
                    </div>
                    <div style={{ color: 'var(--text)', fontWeight: '500' }}>{announce.message}</div>
                  </div>
                ))
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                  No announcements sent yet.
                </div>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', gap: '8px' }}>
            <input 
              type="text" 
              placeholder="Send announcement..." 
              value={announcementText}
              onChange={(e) => setAnnouncementText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSendAnnouncement(); }}
              style={{ flex: 1, padding: '8px 12px', fontSize: '0.85rem', background: 'var(--bg)' }}
            />
            <button 
              className="button button-primary" 
              style={{ padding: '8px 16px', fontSize: '0.85rem' }}
              onClick={handleSendAnnouncement}
            >
              Send
            </button>
          </div>
        </div>
      </div>

      {/* Problems & Administrative Actions */}
      <div className="problem-card mb-8">
        <h3 className="mb-4">Assessment Challenges & Rejudge Control</h3>
        <p className="text-secondary mb-6" style={{ fontSize: '0.9rem' }}>
          Rejudge submissions if verification logic, correct answers, or templates were updated during the assessment window.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px' }}>
          {assessment.problems?.map((p) => {
            const probId = p.problemId?._id || p.problemId;
            const probTitle = p.problemId?.title || 'Unknown Challenge';
            return (
              <div key={probId} className="flex-between" style={{ background: 'var(--bg)', padding: '16px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
                <div>
                  <h4 style={{ margin: '0 0 4px 0', fontSize: '0.95rem', fontWeight: '700' }}>{probTitle}</h4>
                  <span className="text-muted" style={{ fontSize: '0.8rem' }}>Max Score: {p.maxScore || 100} pts</span>
                </div>
                <button
                  className="button button-outline"
                  onClick={() => handleRejudgeProblem(probId, probTitle)}
                  style={{ padding: '6px 12px', fontSize: '0.8rem', color: 'var(--warning)', borderColor: 'rgba(245, 158, 11, 0.3)' }}
                >
                  <RefreshCw size={14} style={{ marginRight: '4px' }} /> Rejudge Problem
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Navigation Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: '24px', gap: '8px' }}>
        <button
          className={`button ${activeTab === 'attendance' ? 'button-primary' : 'button-outline'}`}
          onClick={() => setActiveTab('attendance')}
          style={{ borderBottomLeftRadius: 0, borderBottomRightRadius: 0, borderBottom: activeTab === 'attendance' ? 'none' : '1px solid var(--border)', padding: '10px 20px', display: 'flex', alignItems: 'center', gap: '8px' }}
        >
          <Users size={16} /> Candidates Table
        </button>
        <button
          className={`button ${activeTab === 'analytics' ? 'button-primary' : 'button-outline'}`}
          onClick={() => setActiveTab('analytics')}
          style={{ borderBottomLeftRadius: 0, borderBottomRightRadius: 0, borderBottom: activeTab === 'analytics' ? 'none' : '1px solid var(--border)', padding: '10px 20px', display: 'flex', alignItems: 'center', gap: '8px' }}
        >
          <BarChart3 size={16} /> Analytics Dashboard
        </button>
      </div>

      {activeTab === 'attendance' ? (
        <div className="problem-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '20px', borderBottom: '1px solid var(--border)', display: 'flex', gap: '20px', alignItems: 'center', background: 'var(--surface-hover)' }}>
            <div style={{ flex: 1, position: 'relative' }}>
              <Search size={18} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <input 
                type="text" 
                placeholder="Search students..." 
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ paddingLeft: '40px', background: 'var(--bg)' }}
              />
            </div>
            <select 
              value={statusFilter} 
              onChange={(e) => setStatusFilter(e.target.value)}
              style={{ width: '200px', background: 'var(--bg)' }}
            >
              <option value="">All Statuses</option>
              <option value="Not Started">Not Started</option>
              <option value="Active">Active</option>
              <option value="Submitted">Submitted</option>
              <option value="TimedOut">Timed Out</option>
            </select>
            <select 
              value={riskFilter} 
              onChange={(e) => setRiskFilter(e.target.value)}
              style={{ width: '150px', background: 'var(--bg)' }}
            >
              <option value="">All Risks</option>
              <option value="High">High Risk</option>
              <option value="Medium">Medium Risk</option>
              <option value="Low">Low Risk</option>
            </select>
          </div>

          <div className="table-container" style={{ border: 'none', borderRadius: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Status</th>
                  <th>Score</th>
                  <th>Risk Level</th>
                  <th>Security Metrics</th>
                  <th>Timeline</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredAttendance.map((a) => (
                  <tr key={a.studentId}>
                    <td>
                      <div style={{ fontWeight: '600' }}>{a.name}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        {a.usn ? `${a.usn} | ` : ''}{a.email}{a.section ? ` | Sec ${a.section}` : ''}
                      </div>
                    </td>
                     <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-start' }}>
                        <span className={`tag ${getStatusTagClass(a.status)}`} style={{ fontSize: '0.7rem', textTransform: 'uppercase', fontWeight: '700' }}>
                          {a.status}
                        </span>
                        {a.challenge && a.challenge.status !== 'None' && (
                          <span 
                            className="tag" 
                            style={{ 
                              fontSize: '0.65rem', 
                              fontWeight: '700', 
                              textTransform: 'uppercase',
                              backgroundColor: 
                                a.challenge.status === 'Raised' ? 'rgba(245, 158, 11, 0.15)' :
                                a.challenge.status === 'Accepted' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                              color: 
                                a.challenge.status === 'Raised' ? 'var(--warning)' :
                                a.challenge.status === 'Accepted' ? 'var(--success)' : 'var(--error)',
                              border: `1px solid ${
                                a.challenge.status === 'Raised' ? 'rgba(245, 158, 11, 0.3)' :
                                a.challenge.status === 'Accepted' ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'
                              }`
                            }}
                          >
                            Appeal: {a.challenge.status}
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <div style={{ fontSize: '1.1rem', fontWeight: '700', color: a.score > 0 ? 'var(--text)' : 'var(--text-muted)' }}>
                        {a.score}
                      </div>
                    </td>
                    <td>
                      <span className="tag" style={{ ...getRiskTagStyle(calculateRiskLevel(a)), fontSize: '0.7rem', textTransform: 'uppercase', fontWeight: '700' }}>
                        {calculateRiskLevel(a)}
                      </span>
                    </td>
                    <td>
                      <div className="flex-center gap-3" style={{ justifyContent: 'flex-start' }}>
                        <div className="flex-center gap-1" title="Tab Switches" style={{ color: a.tabSwitchCount > 5 ? 'var(--error)' : 'inherit' }}>
                          <MonitorOff size={14} /> <span style={{ fontSize: '0.85rem' }}>{a.tabSwitchCount}</span>
                        </div>
                        <div className="flex-center gap-1" title="Copies" style={{ color: a.copyCount > 10 ? 'var(--warning)' : 'inherit' }}>
                          <Copy size={14} /> <span style={{ fontSize: '0.85rem' }}>{a.copyCount}</span>
                        </div>
                        <div className="flex-center gap-1" title="Pastes" style={{ color: a.pasteCount > 5 ? 'var(--error)' : 'inherit' }}>
                          <ClipboardPaste size={14} /> <span style={{ fontSize: '0.85rem' }}>{a.pasteCount}</span>
                        </div>
                        <div className="flex-center gap-1" title="Fullscreen Exits" style={{ color: a.fullscreenExitCount > 0 ? 'var(--error)' : 'inherit' }}>
                          <Maximize size={14} /> <span style={{ fontSize: '0.85rem' }}>{a.fullscreenExitCount}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                        {a.startedAt ? (
                          <div className="flex-center gap-2" style={{ justifyContent: 'flex-start' }}>
                            <Clock size={12} /> {new Date(a.startedAt).toLocaleTimeString()} 
                            {a.submittedAt && (
                              <>
                                <ChevronRight size={12} /> 
                                {new Date(a.submittedAt).toLocaleTimeString()}
                              </>
                            )}
                          </div>
                        ) : '—'}
                      </div>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                        {a.attemptId && a.challenge && a.challenge.status !== 'None' && (
                          <button
                            onClick={() => handleOpenReviewChallenge(a)}
                            className="button button-outline"
                            style={{
                              padding: '6px 12px',
                              fontSize: '0.8rem',
                              color: a.challenge.status === 'Raised' ? 'var(--warning)' : 'var(--text-secondary)',
                              borderColor: a.challenge.status === 'Raised' ? 'rgba(245, 158, 11, 0.4)' : 'var(--border)'
                            }}
                          >
                            {a.challenge.status === 'Raised' ? 'Review Appeal' : 'View Appeal'}
                          </button>
                        )}
                        {a.attemptId && (a.status === 'Active' || a.status === 'TimedOut') && (
                          <button
                            onClick={() => handleAddGrace(a.attemptId, a.name)}
                            className="button button-outline"
                            style={{ padding: '6px 12px', fontSize: '0.8rem', color: 'var(--success)', borderColor: 'rgba(16, 185, 129, 0.4)' }}
                          >
                            + Grace Time
                          </button>
                        )}
                        {a.attemptId ? (
                          <Link to={`/admin/assessment-attempt/${a.attemptId}`} className="button button-outline" style={{ padding: '6px 12px', fontSize: '0.8rem' }}>
                            View Detailed Results
                          </Link>
                        ) : (
                          <span className="text-muted" style={{ fontSize: '0.8rem' }}>No attempt yet</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {filteredAttendance.length === 0 && (
                  <tr>
                    <td colSpan="7" style={{ textAlign: 'center', padding: '60px', color: 'var(--text-muted)' }}>
                      No students match the current filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        analytics && (
          <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '30px' }}>
            
            {/* Top Performance Analytics Row */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '24px' }}>
              {/* Average Score Progress Card */}
              <div className="problem-card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '24px' }}>
                <div>
                  <h4 style={{ margin: '0 0 16px 0', color: 'var(--text-secondary)', fontSize: '0.9rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Average Score Performance</h4>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '12px' }}>
                    <span style={{ fontSize: '2.5rem', fontWeight: '800', color: 'var(--primary)' }}>{analytics.overallStats.avgScore}</span>
                    <span style={{ fontSize: '1.2rem', color: 'var(--text-muted)' }}>/ {analytics.overallStats.maxPossibleScore}</span>
                  </div>
                  <div style={{ background: 'var(--bg)', height: '10px', borderRadius: '5px', overflow: 'hidden', marginBottom: '8px' }}>
                    <div style={{ 
                      background: 'var(--primary)', 
                      width: `${(analytics.overallStats.avgScore / analytics.overallStats.maxPossibleScore) * 100}%`,
                      height: '100%',
                      borderRadius: '5px',
                      boxShadow: '0 0 8px var(--primary)'
                    }} />
                  </div>
                </div>
                <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                  Average performance of submitted candidates is {Math.round((analytics.overallStats.avgScore / analytics.overallStats.maxPossibleScore) * 100)}%
                </p>
              </div>

              {/* Score Range Card */}
              <div className="problem-card" style={{ display: 'flex', flexDirection: 'column', padding: '24px' }}>
                <h4 style={{ margin: '0 0 16px 0', color: 'var(--text-secondary)', fontSize: '0.9rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Score Extrema</h4>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', height: '100%', alignItems: 'center' }}>
                  <div style={{ borderRight: '1px solid var(--border)', paddingRight: '16px' }}>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '4px' }}>HIGHEST SCORE</div>
                    <div style={{ fontSize: '2rem', fontWeight: '800', color: 'var(--success)' }}>{analytics.overallStats.highestScore}</div>
                  </div>
                  <div style={{ paddingLeft: '16px' }}>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '4px' }}>LOWEST SCORE</div>
                    <div style={{ fontSize: '2rem', fontWeight: '800', color: 'var(--error)' }}>{analytics.overallStats.lowestScore}</div>
                  </div>
                </div>
              </div>

              {/* Pass Rate Gauge Card */}
              <div className="problem-card" style={{ display: 'flex', alignItems: 'center', gap: '20px', padding: '24px' }}>
                <div style={{ position: 'relative', width: '90px', height: '90px', flexShrink: 0 }}>
                  <svg width="90" height="90" viewBox="0 0 36 36" style={{ transform: 'rotate(-90deg)' }}>
                    <path
                      className="circle-bg"
                      d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                      fill="none"
                      stroke="var(--border)"
                      strokeWidth="3.5"
                    />
                    <path
                      className="circle"
                      strokeDasharray={`${analytics.overallStats.passRate}, 100`}
                      d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                      fill="none"
                      stroke="var(--success)"
                      strokeWidth="3.5"
                      strokeLinecap="round"
                      style={{ transition: 'stroke-dasharray 0.5s ease' }}
                    />
                  </svg>
                  <div style={{
                    position: 'absolute',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                    fontSize: '1.2rem',
                    fontWeight: '800',
                    color: 'var(--success)'
                  }}>
                    {analytics.overallStats.passRate}%
                  </div>
                </div>
                <div>
                  <h4 style={{ margin: '0 0 4px 0', fontSize: '1rem', fontWeight: '700' }}>Overall Pass Rate</h4>
                  <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: '1.4' }}>
                    Percentage of candidates scoring 40% or more of max points.
                  </p>
                </div>
              </div>
            </div>

            {/* Section-wise Performance Reports */}
            <div className="problem-card" style={{ padding: '24px' }}>
              <h3 style={{ margin: '0 0 16px 0', fontSize: '1.2rem', fontWeight: '700' }}>Section-wise Performance Breakdown</h3>
              <div className="table-container" style={{ border: 'none', borderRadius: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Section</th>
                      <th style={{ textAlign: 'center' }}>Total Candidates</th>
                      <th style={{ textAlign: 'center' }}>Started Assessment</th>
                      <th style={{ textAlign: 'center' }}>Submitted / Completed</th>
                      <th style={{ textAlign: 'center' }}>Average Score</th>
                      <th style={{ textAlign: 'right' }}>Pass Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analytics.sectionReports?.map((sec) => (
                      <tr key={sec.section}>
                        <td>
                          <span style={{ fontWeight: '700', fontSize: '1rem' }}>{sec.section}</span>
                        </td>
                        <td style={{ textAlign: 'center' }}>{sec.total}</td>
                        <td style={{ textAlign: 'center' }}>
                          <span className="tag" style={{ background: 'rgba(59, 130, 246, 0.1)', color: 'var(--primary)' }}>{sec.started}</span>
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <span className="tag" style={{ background: 'rgba(16, 185, 129, 0.1)', color: 'var(--success)' }}>{sec.submitted}</span>
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <div style={{ fontWeight: '700' }}>
                            {sec.avgScore} <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 'normal' }}>/ {analytics.overallStats.maxPossibleScore}</span>
                          </div>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px' }}>
                            <span style={{ fontWeight: '700', color: sec.passRate >= 70 ? 'var(--success)' : sec.passRate >= 40 ? 'var(--warning)' : 'var(--error)' }}>
                              {sec.passRate}%
                            </span>
                            <div style={{ background: 'var(--bg)', width: '60px', height: '6px', borderRadius: '3px', overflow: 'hidden' }}>
                              <div style={{ 
                                background: sec.passRate >= 70 ? 'var(--success)' : sec.passRate >= 40 ? 'var(--warning)' : 'var(--error)', 
                                width: `${sec.passRate}%`, 
                                height: '100%' 
                              }} />
                            </div>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {(!analytics.sectionReports || analytics.sectionReports.length === 0) && (
                      <tr>
                        <td colSpan="6" style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)' }}>
                          No section data available.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Question Analytics / Difficulty Reports */}
            <div className="problem-card" style={{ padding: '24px' }}>
              <h3 style={{ margin: '0 0 8px 0', fontSize: '1.2rem', fontWeight: '700' }}>Question-wise Analytics</h3>
              <p className="text-secondary mb-6" style={{ fontSize: '0.85rem' }}>
                Track correct submissions per problem. Use this data to identify broken challenges, verify difficulty, or adjust scoring weight.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '20px' }}>
                {analytics.questionReports?.map((q) => {
                  const getDifficultyStyle = (diff) => {
                    switch (diff.toLowerCase()) {
                      case 'easy': return { background: 'rgba(16, 185, 129, 0.1)', color: 'var(--success)', border: '1px solid rgba(16, 185, 129, 0.3)' };
                      case 'hard': return { background: 'rgba(239, 68, 68, 0.1)', color: 'var(--error)', border: '1px solid rgba(239, 68, 68, 0.3)' };
                      default: return { background: 'rgba(245, 158, 11, 0.1)', color: 'var(--warning)', border: '1px solid rgba(245, 158, 11, 0.3)' };
                    }
                  };

                  const getAlertStatus = (rate) => {
                    if (rate > 85) return { text: 'Too Easy', color: 'var(--success)', bg: 'rgba(16, 185, 129, 0.05)' };
                    if (rate > 0 && rate < 20) return { text: 'Too Hard / Broken', color: 'var(--error)', bg: 'rgba(239, 68, 68, 0.05)' };
                    return { text: 'Balanced', color: 'var(--primary)', bg: 'rgba(59, 130, 246, 0.05)' };
                  };

                  const alertStatus = getAlertStatus(q.solvedRate);

                  return (
                    <div key={q.problemId} style={{ 
                      background: 'var(--bg)', 
                      padding: '20px', 
                      borderRadius: 'var(--radius-md)', 
                      border: '1px solid var(--border)',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between'
                    }}>
                      <div>
                        <div className="flex-between mb-3">
                          <span className="tag" style={getDifficultyStyle(q.difficulty)}>{q.difficulty}</span>
                          <span className="tag" style={{ background: alertStatus.bg, color: alertStatus.color }}>{alertStatus.text}</span>
                        </div>
                        <h4 style={{ margin: '0 0 12px 0', fontSize: '1.05rem', fontWeight: '800' }}>{q.title}</h4>
                        
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' }}>
                          <div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '2px' }}>ATTEMPTED BY</div>
                            <div style={{ fontSize: '1.1rem', fontWeight: '700' }}>{q.attemptCount} students</div>
                          </div>
                          <div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '2px' }}>SOLVED BY</div>
                            <div style={{ fontSize: '1.1rem', fontWeight: '700' }}>{q.solvedCount} students</div>
                          </div>
                        </div>
                      </div>

                      <div>
                        <div className="flex-between mb-2" style={{ fontSize: '0.8rem' }}>
                          <span className="text-muted">Solved Rate (of attempts):</span>
                          <span style={{ fontWeight: '700', color: 'var(--primary)' }}>{q.solvedRate}%</span>
                        </div>
                        <div style={{ background: 'var(--surface-hover)', height: '8px', borderRadius: '4px', overflow: 'hidden', marginBottom: '12px' }}>
                          <div style={{ 
                            background: 'var(--primary)', 
                            width: `${q.solvedRate}%`, 
                            height: '100%', 
                            borderRadius: '4px' 
                          }} />
                        </div>
                        <div className="flex-between" style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                          <span>Overall pass share:</span>
                          <span>{q.overallSolvedRate}% of all submissions</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

          </div>
        )
      )}
      {/* Faculty Appeal Review Modal */}
      {selectedChallengeAttempt && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(2, 6, 23, 0.8)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: '24px'
        }}>
          <div className="problem-card" style={{
            maxWidth: '600px',
            width: '100%',
            backgroundColor: 'var(--surface)',
            border: '1px solid var(--border-bright)',
            borderRadius: 'var(--radius-lg)',
            padding: '24px',
            boxShadow: 'var(--shadow-lg)'
          }}>
            <div className="flex-between mb-6" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '12px' }}>
              <h3 style={{ margin: 0, fontSize: '1.25rem' }}>Review Score Appeal</h3>
              <button 
                onClick={() => setSelectedChallengeAttempt(null)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  fontSize: '1.5rem',
                  lineHeight: '1'
                }}
              >
                &times;
              </button>
            </div>

            <div className="mb-4">
              <h4 style={{ fontSize: '0.9rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '8px' }}>Candidate Details</h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', background: 'var(--bg)', padding: '12px 16px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' }}>
                <div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>NAME</div>
                  <div style={{ fontWeight: '600', fontSize: '0.95rem' }}>{selectedChallengeAttempt.name}</div>
                </div>
                <div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>USN / EMAIL</div>
                  <div style={{ fontWeight: '600', fontSize: '0.95rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {selectedChallengeAttempt.usn || selectedChallengeAttempt.email}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>CURRENT SCORE</div>
                  <div style={{ fontWeight: '700', fontSize: '0.95rem', color: 'var(--primary)' }}>
                    {selectedChallengeAttempt.score} / {maxPossibleScore} points
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>STATUS</div>
                  <div style={{ fontWeight: '600', fontSize: '0.95rem' }}>{selectedChallengeAttempt.status}</div>
                </div>
              </div>
            </div>

            <div className="mb-4">
              <h4 style={{ fontSize: '0.9rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '8px' }}>Student Appeal Reason</h4>
              <div style={{ 
                backgroundColor: 'var(--surface-hover)', 
                padding: '16px', 
                borderRadius: 'var(--radius-sm)', 
                border: '1px solid var(--border)',
                maxHeight: '120px',
                overflowY: 'auto'
              }}>
                <p style={{ fontSize: '0.95rem', margin: 0, whiteSpace: 'pre-wrap' }}>{selectedChallengeAttempt.challenge?.reason}</p>
              </div>
            </div>

            <div className="mb-6">
              <h4 style={{ fontSize: '0.9rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '8px' }}>Faculty Decision Comment</h4>
              {selectedChallengeAttempt.challenge?.status === 'Raised' ? (
                <textarea
                  placeholder="Provide a reason for accepting or rejecting this appeal (e.g. 'Verified submission. Found server-side run timeout. Score adjusted.' or 'Code has compiling issues or fails hidden edge cases.')"
                  value={resolveComment}
                  onChange={(e) => setResolveComment(e.target.value)}
                  rows={3}
                  style={{
                    width: '100%',
                    padding: '12px',
                    borderRadius: 'var(--radius-md)',
                    backgroundColor: 'var(--bg)',
                    border: '1px solid var(--border)',
                    color: 'var(--text)',
                    fontSize: '0.95rem',
                    resize: 'vertical'
                  }}
                />
              ) : (
                <div style={{ 
                  backgroundColor: selectedChallengeAttempt.challenge?.status === 'Accepted' ? 'rgba(16, 185, 129, 0.05)' : 'rgba(239, 68, 68, 0.05)',
                  padding: '16px', 
                  borderRadius: 'var(--radius-sm)', 
                  border: `1px solid ${selectedChallengeAttempt.challenge?.status === 'Accepted' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)'}`
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', alignItems: 'center' }}>
                    <span className="tag" style={{
                      backgroundColor: selectedChallengeAttempt.challenge?.status === 'Accepted' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                      color: selectedChallengeAttempt.challenge?.status === 'Accepted' ? 'var(--success)' : 'var(--error)',
                      border: `1px solid ${selectedChallengeAttempt.challenge?.status === 'Accepted' ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
                      fontSize: '0.75rem',
                      fontWeight: '700'
                    }}>
                      {selectedChallengeAttempt.challenge?.status}
                    </span>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      {selectedChallengeAttempt.challenge?.resolvedAt && new Date(selectedChallengeAttempt.challenge.resolvedAt).toLocaleString()}
                    </span>
                  </div>
                  <p style={{ fontSize: '0.95rem', margin: 0, whiteSpace: 'pre-wrap', fontWeight: '500' }}>
                    {selectedChallengeAttempt.challenge?.facultyComment || 'No explanation comment left.'}
                  </p>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button 
                onClick={() => setSelectedChallengeAttempt(null)}
                className="button button-outline"
              >
                Close
              </button>
              {selectedChallengeAttempt.challenge?.status === 'Raised' && (
                <>
                  <button
                    onClick={() => handleResolveChallenge('Rejected')}
                    disabled={resolving}
                    className="button"
                    style={{
                      backgroundColor: 'rgba(239, 68, 68, 0.1)',
                      color: 'var(--error)',
                      border: '1px solid rgba(239, 68, 68, 0.3)',
                      cursor: 'pointer'
                    }}
                  >
                    Reject Appeal
                  </button>
                  <button
                    onClick={() => handleResolveChallenge('Accepted')}
                    disabled={resolving}
                    className="button button-primary"
                    style={{
                      backgroundColor: 'var(--success)',
                      border: 'none',
                      cursor: 'pointer'
                    }}
                  >
                    {resolving ? 'Accepting...' : 'Accept Appeal'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AssessmentResultsPage;
