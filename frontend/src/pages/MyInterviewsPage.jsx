import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, AlertCircle, Link as LinkIcon, Video } from 'lucide-react';
import { interviewSlots } from '../api';
import { getApiErrorMessage } from '../utils/assessmentForm';

const STATUS_STYLE = {
  Scheduled: { color: 'var(--primary)', bg: 'rgba(99, 102, 241, 0.1)' },
  Completed: { color: 'var(--success)', bg: 'rgba(16, 185, 129, 0.1)' },
  Cancelled: { color: 'var(--error)', bg: 'rgba(239, 68, 68, 0.1)' },
  NoShow: { color: 'var(--error)', bg: 'rgba(239, 68, 68, 0.1)' }
};

const MyInterviewsPage = () => {
  const [slots, setSlots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    interviewSlots.my()
      .then((res) => setSlots(res.data))
      .catch((err) => setError(getApiErrorMessage(err, 'Failed to fetch your interviews')))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="container">Loading your interviews...</div>;
  if (error) return <div className="container error-box">{error}</div>;

  return (
    <div className="container fade-in">
      <h1 className="mb-2">My Interviews</h1>
      <p className="text-muted mb-8">Interviews scheduled for you across all placement drives.</p>

      {slots.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '80px', background: 'var(--surface)', borderRadius: 'var(--radius-xl)', border: '1px dashed var(--border)' }}>
          <AlertCircle size={48} className="text-muted mb-4" style={{ margin: '0 auto' }} />
          <p className="text-muted" style={{ fontSize: '1.1rem' }}>No interviews scheduled yet.</p>
        </div>
      ) : (
        <div className="problem-card-grid" style={{ gridTemplateColumns: '1fr' }}>
          {slots.map((s) => {
            const style = STATUS_STYLE[s.status] || STATUS_STYLE.Scheduled;
            return (
              <div key={s._id} className="problem-card" style={{ padding: '20px' }}>
                <div className="flex-between">
                  <div>
                    <div className="flex-center gap-2" style={{ justifyContent: 'flex-start', fontSize: '0.85rem' }} title="Scheduled time">
                      <CalendarClock size={16} className="text-muted" />
                      <span>{new Date(s.scheduledAt).toLocaleString()} · {s.durationMinutes} min</span>
                    </div>
                    <div className="text-muted mt-2" style={{ fontSize: '0.85rem' }}>
                      Interviewer: {s.interviewerId?.name || s.externalInterviewerName || 'TBD'}
                    </div>
                    {s.meetingLink && (
                      <a href={s.meetingLink} target="_blank" rel="noreferrer" className="flex-center gap-2 mt-2" style={{ justifyContent: 'flex-start', fontSize: '0.85rem' }}>
                        <LinkIcon size={14} /> Join meeting
                      </a>
                    )}
                    {s.status === 'Scheduled' && (
                      <Link to={`/interview-room/${s._id}`} className="button button-outline mt-2" style={{ padding: '4px 10px', fontSize: '0.8rem' }}>
                        <Video size={14} /> Join Room
                      </Link>
                    )}
                  </div>
                  <span style={{
                    padding: '4px 12px',
                    borderRadius: '999px',
                    color: style.color,
                    backgroundColor: style.bg,
                    fontWeight: 700,
                    fontSize: '0.75rem',
                    letterSpacing: '0.03em',
                    height: 'fit-content'
                  }}>
                    {s.status.toUpperCase()}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default MyInterviewsPage;
