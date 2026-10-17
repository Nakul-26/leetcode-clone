import React, { useEffect, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { admin } from '../api';

// Which languages the judge spends its time on, so optimisation follows real traffic. Rows are
// ordered by total compute (volume x run time): the top row is where faster compiles, warmer
// pools or runtime tuning would save the most. Platform-wide data, so superadmin only.
const WINDOWS = [7, 30, 90];

const fmtMs = (ms) => {
  if (ms == null) return '-';
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} s` : `${ms} ms`;
};

const fmtHours = (ms) => {
  if (!ms) return '0 min';
  const minutes = ms / 60000;
  return minutes >= 120 ? `${(minutes / 60).toFixed(1)} h` : `${Math.round(minutes)} min`;
};

const getStoredRole = () => {
  try {
    return JSON.parse(localStorage.getItem('user'))?.role;
  } catch {
    return null;
  }
};

const LanguageStatsCard = () => {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const isSuperadmin = getStoredRole() === 'superadmin';

  useEffect(() => {
    if (!isSuperadmin) return undefined;
    let cancelled = false;
    setError(null);
    admin.getLanguageStats(days)
      .then((res) => { if (!cancelled) setData(res.data); })
      .catch((err) => { if (!cancelled) setError(err.response?.data?.error || err.message); });
    return () => { cancelled = true; };
  }, [days, isSuperadmin]);

  if (!isSuperadmin) return null;

  return (
    <div className="problem-card mb-8">
      <div className="flex-between mb-4" style={{ flexWrap: 'wrap', gap: '12px' }}>
        <h3 className="flex-center gap-2" style={{ justifyContent: 'flex-start', margin: 0 }}>
          <BarChart3 size={20} color="var(--primary)" /> Submissions by language
        </h3>
        <div style={{ display: 'flex', gap: '6px' }}>
          {WINDOWS.map((d) => (
            <button
              key={d}
              type="button"
              className={d === days ? 'button' : 'button button-outline'}
              style={{ padding: '4px 10px', fontSize: '0.8rem' }}
              onClick={() => setDays(d)}
            >
              {d} days
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-muted">Could not load language statistics: {error}</p>}
      {!error && !data && <p className="text-muted">Loading...</p>}
      {!error && data && data.languages.length === 0 && (
        <p className="text-muted">No submissions in the last {data.windowDays} days.</p>
      )}
      {!error && data && data.languages.length > 0 && (
        <>
          <p className="text-muted" style={{ fontSize: '0.85rem', marginTop: 0 }}>
            {data.totalSubmissions.toLocaleString()} submissions in {data.windowDays} days
            ({data.totalPerDay.toLocaleString()} per day). Sorted by total judge time: optimise the top rows first.
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ border: 'none' }}>
              <thead>
                <tr>
                  <th>Language</th>
                  <th>Submissions</th>
                  <th>Per day</th>
                  <th>Share</th>
                  <th>Median run</th>
                  <th>p95 run</th>
                  <th>Judge time</th>
                  <th>Compile errors</th>
                </tr>
              </thead>
              <tbody>
                {data.languages.map((l) => (
                  <tr key={l.language}>
                    <td style={{ fontWeight: 600 }}>{l.language}</td>
                    <td>{l.submissions.toLocaleString()}</td>
                    <td>{l.perDay.toLocaleString()}</td>
                    <td>{l.share}%</td>
                    <td>{fmtMs(l.p50ElapsedMs)}</td>
                    <td>{fmtMs(l.p95ElapsedMs)}</td>
                    <td>{fmtHours(l.totalComputeMs)} ({l.computeShare}%)</td>
                    <td>{l.statuses['Compilation Error'] || 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
};

export default LanguageStatsCard;
