import React, { useState, useEffect, useCallback } from 'react';
import { Activity, Server, Database, Users, Code2, RefreshCw, AlertCircle, BookOpen, History, Target, TrendingUp, Trophy, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { admin, submissions, system } from '../api';
import LanguageStatsCard from '../components/LanguageStatsCard';

function formatTimestamp(ts) {
  if (!ts) return 'N/A';
  const d = new Date(ts);
  if (isNaN(d)) return ts;
  const localeStr = d.toLocaleString();
  const diff = Date.now() - d.getTime();
  const seconds = Math.floor(diff / 1000);
  try {
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    if (seconds < 60) return `${localeStr} (${rtf.format(-seconds, 'second')})`;
    if (seconds < 3600) return `${localeStr} (${rtf.format(-Math.floor(seconds / 60), 'minute')})`;
    if (seconds < 86400) return `${localeStr} (${rtf.format(-Math.floor(seconds / 3600), 'hour')})`;
    return `${localeStr} (${rtf.format(-Math.floor(seconds / 86400), 'day')})`;
  } catch {
    return localeStr;
  }
}

const SystemDashboardPage = ({ user }) => {
  const [stats, setStats] = useState(null);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshInterval, setRefreshInterval] = useState(5000);

  // System Settings state
  const [bannerActive, setBannerActive] = useState(false);
  const [bannerMessage, setBannerMessage] = useState("");
  const [bannerType, setBannerType] = useState("info");
  const [bannerSaving, setBannerSaving] = useState(false);

  const [backupLoading, setBackupLoading] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [restoreError, setRestoreError] = useState(null);
  const [restoreSuccess, setRestoreSuccess] = useState(null);

  const fetchBannerStatus = async () => {
    try {
      const res = await system.getBanner();
      if (res.data) {
        setBannerActive(res.data.active || false);
        setBannerMessage(res.data.message || "");
        setBannerType(res.data.type || "info");
      }
    } catch (err) {
      console.error("Failed to load banner status", err);
    }
  };

  useEffect(() => {
    fetchBannerStatus();
  }, []);

  const handleSaveBanner = async (e) => {
    e.preventDefault();
    setBannerSaving(true);
    try {
      await admin.updateBanner({
        active: bannerActive,
        message: bannerMessage,
        type: bannerType
      });
      alert("Incident banner updated successfully!");
      window.dispatchEvent(new Event("refresh-banner"));
    } catch (err) {
      alert(err.response?.data?.error || "Failed to update incident banner");
    } finally {
      setBannerSaving(false);
    }
  };

  const handleDownloadBackup = async () => {
    setBackupLoading(true);
    try {
      const response = await admin.downloadBackup();
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `leetcode_clone_backup_${new Date().toISOString().slice(0, 10)}.json`);
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err) {
      console.error("Failed to download database backup", err);
      alert("Failed to download database backup.");
    } finally {
      setBackupLoading(false);
    }
  };

  const handleRestoreDatabase = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!window.confirm("WARNING: This will overwrite current database state with backup file. Are you sure you want to proceed?")) {
      e.target.value = null;
      return;
    }

    setRestoreLoading(true);
    setRestoreError(null);
    setRestoreSuccess(null);

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const backupData = JSON.parse(evt.target.result);
        const res = await admin.restoreDatabase(backupData);
        setRestoreSuccess(`Successfully restored: ${Object.entries(res.data.results).map(([k, v]) => `${k} (${v})`).join(", ")}`);
        fetchStats();
      } catch (err) {
        console.error(err);
        setRestoreError(err.response?.data?.error || err.message || "Failed to parse or restore backup file.");
      } finally {
        setRestoreLoading(false);
        e.target.value = null;
      }
    };
    reader.readAsText(file);
  };

  const fetchStats = useCallback(async () => {
    try {
      if (user?.role === 'student') {
        const res = await submissions.getAnalytics();
        setStats(res.data);
      } else {
        const [statsRes, logsRes] = await Promise.all([
          admin.getSystemStats(),
          admin.getAuditLogs({ limit: 20 })
        ]);
        setStats(statsRes.data);
        setLogs(logsRes.data);
      }
      setError(null);
    } catch (err) {
      console.error('Failed to fetch stats', err);
      setError(err.response?.data?.error || err.response?.data?.msg || 'Failed to fetch dashboard data');
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchStats();
    const interval = refreshInterval ? setInterval(fetchStats, refreshInterval) : null;
    return () => { if (interval) clearInterval(interval); };
  }, [fetchStats, refreshInterval]);

  if (loading && !stats) return <div className="container">Loading system dashboard...</div>;

  const getHealthColor = (status) => {
    switch (status) {
      case 'healthy':
      case 'connected':
        return 'var(--success)';
      case 'error':
      case 'unhealthy':
        return 'var(--error)';
      case 'disconnected':
      case 'offline':
        return 'var(--text-muted)';
      default:
        return 'var(--warning)';
    }
  };

  return (
    <div className="container fade-in">
      <div className="flex-between mb-8">
        <div>
          <h1 className="mb-2">System Dashboard</h1>
          <p className="text-muted">Live monitoring of platform infrastructure and metrics.</p>
        </div>
        <div className="flex-center gap-4">
          <div className="flex-center gap-2">
            <span className="text-muted" style={{ fontSize: '0.85rem' }}>Auto-refresh:</span>
            <select 
              value={refreshInterval} 
              onChange={(e) => setRefreshInterval(Number(e.target.value))}
              style={{ width: 'auto', padding: '6px 12px', fontSize: '0.85rem' }}
            >
              <option value={2000}>2s</option>
              <option value={5000}>5s</option>
              <option value={10000}>10s</option>
              <option value={30000}>30s</option>
              <option value={0}>Off</option>
            </select>
          </div>
          <button className="button button-outline" onClick={fetchStats} disabled={loading} style={{ padding: '8px 16px' }}>
            <RefreshCw size={16} className={loading ? 'spin' : ''} />
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div className="error-box mb-8 flex-center gap-2" style={{ justifyContent: 'flex-start' }}>
          <AlertCircle size={18} /> {error}
        </div>
      )}

      {user?.role === 'student' ? (
        // STUDENT ANALYTICS VIEW
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <div className="grid grid-cols-4 gap-6" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
            <div className="problem-card" style={{ textAlign: 'center' }}>
              <div className="text-muted mb-2 flex-center gap-2" style={{ fontSize: '0.8rem', textTransform: 'uppercase', fontWeight: '700' }}>
                <Code2 size={14} /> Problems Attempted
              </div>
              <div style={{ fontSize: '2rem', fontWeight: '800' }}>{stats?.totalAttempted || 0}</div>
            </div>
            <div className="problem-card" style={{ textAlign: 'center' }}>
              <div className="text-muted mb-2 flex-center gap-2" style={{ fontSize: '0.8rem', textTransform: 'uppercase', fontWeight: '700' }}>
                <CheckCircle2 size={14} color="var(--success)" /> Problems Solved
              </div>
              <div style={{ fontSize: '2rem', fontWeight: '800', color: 'var(--success)' }}>{stats?.totalSolved || 0}</div>
            </div>
            <div className="problem-card" style={{ textAlign: 'center' }}>
              <div className="text-muted mb-2 flex-center gap-2" style={{ fontSize: '0.8rem', textTransform: 'uppercase', fontWeight: '700' }}>
                <Target size={14} /> Overall Success
              </div>
              <div style={{ fontSize: '2rem', fontWeight: '800', color: 'var(--primary)' }}>
                {stats?.totalAttempted > 0 ? Math.round((stats.totalSolved / stats.totalAttempted) * 100) : 0}%
              </div>
            </div>
            <div className="problem-card" style={{ textAlign: 'center' }}>
              <div className="text-muted mb-2 flex-center gap-2" style={{ fontSize: '0.8rem', textTransform: 'uppercase', fontWeight: '700' }}>
                <TrendingUp size={14} /> Avg. Difficulty
              </div>
              <div style={{ fontSize: '2rem', fontWeight: '800' }} className={`text-difficulty-${stats?.averageDifficulty?.toLowerCase() || 'medium'}`}>
                {stats?.averageDifficulty || 'Medium'}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-6" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
            <div className="problem-card" style={{ borderLeft: '4px solid var(--success)' }}>
              <h3 className="mb-4 flex-center gap-2" style={{ justifyContent: 'flex-start', margin: 0 }}>
                <Trophy size={20} color="var(--success)" /> Strong Areas
              </h3>
              <p className="text-muted mb-6" style={{ fontSize: '0.85rem' }}>Topics where you consistently succeed.</p>
              {stats?.strongAreas && stats.strongAreas.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  {stats.strongAreas.map(area => (
                    <div key={area.tag}>
                      <div className="flex-between mb-2">
                        <span style={{ fontWeight: '600' }}>{area.tag}</span>
                        <span style={{ color: 'var(--success)', fontWeight: '700' }}>{area.successRate}%</span>
                      </div>
                      <div style={{ width: '100%', height: '8px', background: 'var(--bg)', borderRadius: '4px', overflow: 'hidden' }}>
                        <div style={{ width: `${area.successRate}%`, height: '100%', background: 'var(--success)' }}></div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-6 text-muted" style={{ background: 'var(--bg)', borderRadius: 'var(--radius-md)', border: '1px dashed var(--border)' }}>
                  Keep practicing to identify your strong areas!
                </div>
              )}
            </div>

            <div className="problem-card" style={{ borderLeft: '4px solid var(--error)' }}>
              <h3 className="mb-4 flex-center gap-2" style={{ justifyContent: 'flex-start', margin: 0 }}>
                <AlertTriangle size={20} color="var(--error)" /> Areas to Improve
              </h3>
              <p className="text-muted mb-6" style={{ fontSize: '0.85rem' }}>Topics that need more focus and practice.</p>
              {stats?.weakAreas && stats.weakAreas.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  {stats.weakAreas.map(area => (
                    <div key={area.tag}>
                      <div className="flex-between mb-2">
                        <span style={{ fontWeight: '600' }}>{area.tag}</span>
                        <span style={{ color: 'var(--error)', fontWeight: '700' }}>{area.successRate}%</span>
                      </div>
                      <div style={{ width: '100%', height: '8px', background: 'var(--bg)', borderRadius: '4px', overflow: 'hidden' }}>
                        <div style={{ width: `${area.successRate}%`, height: '100%', background: 'var(--error)' }}></div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-6 text-muted" style={{ background: 'var(--bg)', borderRadius: 'var(--radius-md)', border: '1px dashed var(--border)' }}>
                  You don't have enough data for weak areas yet. Great job!
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        // ADMIN / FACULTY DASHBOARD VIEW
        <>
          {/* Judge Service Metrics - Only for Staff */}
          <div className="problem-card judge-card mb-8">
            <h3 className="mb-6 flex-center gap-2" style={{ justifyContent: 'flex-start' }}>
              <Code2 size={20} color="var(--primary)" /> Judge Service Metrics
            </h3>
            {stats?.judgeStats ? (() => {
              const js = stats.judgeStats;
              const poolRoot = js.pool || { available: js.available || js.Available || {}, in_use: js.in_use || js.InUse || {}, expected: js.expected || js.Expected || {} };
              const poolAvailable = poolRoot.available || poolRoot.Available || {};
              const poolInUse = poolRoot.in_use || poolRoot.InUse || {};
              const poolExpected = poolRoot.expected || poolRoot.Expected || {};
              
              const langs = Array.from(new Set([
                ...Object.keys(poolAvailable),
                ...Object.keys(poolInUse),
                ...Object.keys(poolExpected)
              ])).sort();

              if (langs.length === 0) return <p className="text-muted py-4">Judge pool data unavailable.</p>;

              return (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '24px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div className="stat-card">
                      <div className="flex-between mb-2"><span className="text-muted" style={{ fontSize: '0.8rem' }}>Last GC</span><strong>{formatTimestamp(js.metrics?.last_gc_run)}</strong></div>
                      <div className="flex-between mb-2"><span className="text-muted" style={{ fontSize: '0.8rem' }}>GC Removed</span><strong>{js.metrics?.gc_removed_total || 0}</strong></div>
                      <div className="flex-between"><span className="text-muted" style={{ fontSize: '0.8rem' }}>GC Exited</span><strong>{js.metrics?.gc_removed_exited || 0}</strong></div>
                    </div>
                    <div className="stat-card">
                      <div className="flex-between mb-2"><span className="text-muted" style={{ fontSize: '0.8rem' }}>Last Reconcile</span><strong>{formatTimestamp(js.metrics?.last_reconcile_run)}</strong></div>
                      <div className="flex-between mb-2"><span className="text-muted" style={{ fontSize: '0.8rem' }}>Reconcile Repairs</span><strong>{js.metrics?.reconcile_repairs_total || 0}</strong></div>
                      <div className="flex-between"><span className="text-muted" style={{ fontSize: '0.8rem' }}>Container Replacements</span><strong>{js.metrics?.container_replacements_total || 0}</strong></div>
                    </div>
                  </div>
                  <div className="table-container" style={{ border: 'none', background: 'var(--bg)', flex: 1 }}>
                    <table className="table" style={{ border: 'none' }}>
                      <thead>
                        <tr>
                          <th style={{ background: 'transparent' }}>Language Pool</th>
                          <th style={{ background: 'transparent', textAlign: 'center' }}>Available</th>
                          <th style={{ background: 'transparent', textAlign: 'center' }}>Busy</th>
                          <th style={{ background: 'transparent', textAlign: 'center' }}>Expected</th>
                        </tr>
                      </thead>
                      <tbody>
                        {langs.map((lang) => (
                          <tr key={lang} style={{ background: 'transparent' }}>
                            <td style={{ textTransform: 'capitalize', fontWeight: '600' }}>{lang}</td>
                            <td style={{ textAlign: 'center', color: (poolAvailable[lang] || 0) > 0 ? 'var(--success)' : 'var(--text-muted)' }}>{poolAvailable[lang] || 0}</td>
                            <td style={{ textAlign: 'center', color: (poolInUse[lang] || 0) > 0 ? 'var(--warning)' : 'var(--text-muted)' }}>{poolInUse[lang] || 0}</td>
                            <td style={{ textAlign: 'center' }}>{poolExpected[lang] ?? '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })() : <p className="text-muted text-center py-4">Judge stats unavailable</p>}
          </div>

          <LanguageStatsCard />

          {/* System Settings & Utilities */}
          <div className="grid grid-cols-2 gap-6 mb-8" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '24px' }}>
            {/* Incident Banner Card */}
            <div className="problem-card">
              <h3 className="mb-4 flex-center gap-2" style={{ justifyContent: 'flex-start' }}>
                <AlertTriangle size={20} color="var(--warning)" /> System Incident Banner
              </h3>
              <p className="text-muted mb-4" style={{ fontSize: '0.85rem' }}>
                Display a global system-wide notice banner for outages or maintenance.
              </p>
              <form onSubmit={handleSaveBanner} style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '100%' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input
                    type="checkbox"
                    id="bannerActive"
                    checked={bannerActive}
                    onChange={(e) => setBannerActive(e.target.checked)}
                    style={{ width: 'auto' }}
                  />
                  <label htmlFor="bannerActive" style={{ fontWeight: '600', cursor: 'pointer' }}>Active (Show Banner)</label>
                </div>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <label style={{ fontSize: '0.8rem', fontWeight: '600' }}>Banner Message</label>
                  <input
                    type="text"
                    value={bannerMessage}
                    onChange={(e) => setBannerMessage(e.target.value)}
                    placeholder="e.g. Scheduled database maintenance at 6:00 PM UTC."
                    disabled={!bannerActive}
                    required={bannerActive}
                    style={{ width: '100%' }}
                  />
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <label style={{ fontSize: '0.8rem', fontWeight: '600' }}>Banner Severity / Type</label>
                  <select
                    value={bannerType}
                    onChange={(e) => setBannerType(e.target.value)}
                    disabled={!bannerActive}
                    style={{ padding: '8px 12px' }}
                  >
                    <option value="info">Info (Blue)</option>
                    <option value="warning">Warning (Amber/Yellow)</option>
                    <option value="error">Critical Incident (Red)</option>
                  </select>
                </div>

                <button type="submit" className="button" disabled={bannerSaving} style={{ marginTop: '8px', alignSelf: 'flex-start' }}>
                  {bannerSaving ? "Saving..." : "Save Banner Configuration"}
                </button>
              </form>
            </div>

            {/* Backup & Restore Card */}
            <div className="problem-card">
              <h3 className="mb-4 flex-center gap-2" style={{ justifyContent: 'flex-start' }}>
                <Database size={20} color="var(--primary)" /> Database Backup & Restore
              </h3>
              <p className="text-muted mb-4" style={{ fontSize: '0.85rem' }}>
                Export all collections to JSON or restore system state from a previous JSON backup file.
              </p>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', width: '100%' }}>
                <div>
                  <h4 style={{ margin: '0 0 8px 0', fontSize: '0.9rem' }}>Export Data</h4>
                  <button 
                    className="button button-outline" 
                    onClick={handleDownloadBackup} 
                    disabled={backupLoading}
                    style={{ width: '100%', justifyContent: 'center' }}
                  >
                    {backupLoading ? "Generating Export..." : "Download Database JSON Backup"}
                  </button>
                </div>

                <div style={{ borderTop: '1px solid var(--border)', paddingTop: '16px' }}>
                  <h4 style={{ margin: '0 0 8px 0', fontSize: '0.9rem' }}>Restore Data</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <label className="button button-outline" style={{ display: 'flex', justifyContent: 'center', cursor: 'pointer', margin: 0, borderColor: 'rgba(239, 68, 68, 0.2)', color: 'var(--error)' }}>
                      <span>{restoreLoading ? "Restoring..." : "Upload JSON Backup to Restore"}</span>
                      <input 
                        type="file" 
                        accept=".json" 
                        onChange={handleRestoreDatabase} 
                        disabled={restoreLoading}
                        style={{ display: 'none' }}
                      />
                    </label>
                    {restoreSuccess && <div style={{ color: 'var(--success)', fontSize: '0.85rem', fontWeight: '600', marginTop: '4px' }}>{restoreSuccess}</div>}
                    {restoreError && <div style={{ color: 'var(--error)', fontSize: '0.85rem', fontWeight: '600', marginTop: '4px' }}>{restoreError}</div>}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-6 mb-8" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '24px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
              <div className="problem-card">
                <h3 className="mb-6 flex-center gap-2" style={{ justifyContent: 'flex-start' }}>
                  <Activity size={20} color="var(--primary)" /> System Health
                </h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  {stats?.health ? Object.entries(stats.health).map(([service, status]) => (
                    <div key={service} className="flex-between" style={{ padding: '12px 16px', borderRadius: 'var(--radius-md)', background: 'var(--bg)', border: '1px solid var(--border)' }}>
                      <span style={{ fontSize: '0.8rem', fontWeight: '600', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>{service}</span>
                      <span style={{ fontSize: '0.8rem', fontWeight: '700', color: getHealthColor(status) }}>{status.toUpperCase()}</span>
                    </div>
                  )) : <p className="text-muted">Loading...</p>}
                </div>
              </div>
              <div className="problem-card" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <h3 className="mb-6 flex-center gap-2" style={{ justifyContent: 'flex-start' }}>
                  <History size={20} color="var(--primary)" /> Audit Logs
                </h3>
                <div style={{ flex: 1, maxHeight: '500px', overflowY: 'auto' }}>
                  {logs.map((log) => (
                    <div key={log._id} className="mb-4 pb-4" style={{ borderBottom: '1px solid var(--border)', fontSize: '0.85rem' }}>
                      <div className="flex-between mb-1">
                        <span className={`tag ${log.event.includes('FAILED') || log.event.includes('TIMEOUT') ? 'difficulty-hard' : 'difficulty-easy'}`} style={{ fontSize: '0.7rem' }}>{log.event}</span>
                        <span className="text-muted" style={{ fontSize: '0.75rem' }}>{new Date(log.createdAt).toLocaleString()}</span>
                      </div>
                      <div className="flex-between">
                        <span style={{ fontWeight: '600' }}>{log.userId?.name || 'System'}</span>
                        <span className="text-muted" style={{ fontSize: '0.75rem' }}>{log.ip}</span>
                      </div>
                    </div>
                  ))}
                  {logs.length === 0 && <p className="text-muted text-center py-8">No logs found.</p>}
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
              <div className="problem-card">
                <h3 className="mb-6 flex-center gap-2" style={{ justifyContent: 'flex-start' }}>
                  <Server size={20} color="var(--primary)" /> Queue Monitoring
                </h3>
                <div style={{ textAlign: 'center', padding: '24px 0', background: 'var(--bg)', borderRadius: 'var(--radius-md)' }}>
                  <div style={{ fontSize: '3.5rem', fontWeight: '800', color: (stats?.queueLength || 0) > 50 ? 'var(--error)' : 'var(--primary)', lineHeight: 1 }}>{stats?.queueLength || 0}</div>
                  <p style={{ color: 'var(--text-muted)', marginTop: '8px', fontWeight: '600', textTransform: 'uppercase', fontSize: '0.75rem' }}>Pending Submissions</p>
                </div>
              </div>
              <div className="problem-card">
                <h3 className="mb-6 flex-center gap-2" style={{ justifyContent: 'flex-start' }}>
                  <Database size={20} color="var(--primary)" /> Metrics
                </h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                  <div style={{ background: 'var(--bg)', padding: '16px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
                    <div className="flex-between mb-2"><span className="text-muted" style={{ fontSize: '0.8rem' }}>Problems</span><strong>{stats?.metrics?.totalProblems || 0}</strong></div>
                    <div className="flex-between mb-2"><span className="text-muted" style={{ fontSize: '0.8rem' }}>Assessments</span><strong>{stats?.metrics?.totalAssessments || 0}</strong></div>
                    <div className="flex-between"><span className="text-muted" style={{ fontSize: '0.8rem' }}>Users</span><strong>{stats?.metrics?.totalUsers || 0}</strong></div>
                  </div>
                  <div style={{ background: 'var(--bg)', padding: '16px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
                    <div className="flex-between mb-2"><span className="text-muted" style={{ fontSize: '0.8rem' }}>Today</span><strong>{stats?.metrics?.submissionsToday || 0}</strong></div>
                    <div className="flex-between mb-2"><span className="text-muted" style={{ fontSize: '0.8rem' }}>Accepted</span><strong style={{ color: 'var(--success)' }}>{stats?.metrics?.acceptedToday || 0}</strong></div>
                    <div className="flex-between"><span className="text-muted" style={{ fontSize: '0.8rem' }}>Rate</span><strong>{stats?.metrics?.submissionsToday > 0 ? ((stats.metrics.acceptedToday / stats.metrics.submissionsToday) * 100).toFixed(1) : 0}%</strong></div>
                  </div>
                </div>
                <div className="submissions-hero" style={{ marginTop: '20px', width: '100%' }}>
                  <div className="label">Submissions (All Time)</div>
                  <div className="value">{stats?.metrics?.totalSubmissions || 0}</div>
                </div>
              </div>
            </div>
          </div>

          <div className="problem-card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '20px', borderBottom: '1px solid var(--border)' }}>
              <h3 style={{ margin: 0 }}>Live Submission Feed</h3>
            </div>
            <div className="table-container" style={{ border: 'none', borderRadius: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Student</th>
                    <th>Problem</th>
                    <th>Lang</th>
                    <th>Verdict</th>
                    <th style={{ textAlign: 'right' }}>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {stats?.recentSubmissions?.map((s) => (
                    <tr key={s._id}>
                      <td>
                        <div style={{ fontWeight: '600' }}>{s.userId?.name || 'Anonymous'}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{s.userId?.email}</div>
                      </td>
                      <td>{s.problemId?.title || 'Unknown'}</td>
                      <td style={{ textTransform: 'capitalize' }}>{s.language}</td>
                      <td><span className={`tag ${s.status === 'Success' ? 'difficulty-easy' : (['Fail', 'Error'].includes(s.status) ? 'difficulty-hard' : '')}`}>{s.status}</span></td>
                      <td style={{ textAlign: 'right', color: 'var(--text-muted)', fontSize: '0.8rem' }}>{new Date(s.createdAt).toLocaleTimeString()}</td>
                    </tr>
                  )) || <tr><td colSpan="5" className="text-center py-8">No recent activity</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <style>{`
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { 100% { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
};

export default SystemDashboardPage;
