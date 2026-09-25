import React, { useState, useEffect, Suspense, lazy } from 'react';
import { useParams } from 'react-router-dom';
import { CalendarClock, Link as LinkIcon, Building2, User, Video } from 'lucide-react';
import { interviewSlots } from '../api';
import { getApiErrorMessage } from '../utils/assessmentForm';

// Lazy-loaded for the same reason as InterviewRoomPage - pulls in monaco-editor + yjs,
// which the rest of this public page doesn't need until the interviewer actually joins.
const InterviewRoom = lazy(() => import('../components/InterviewRoom'));

// Public page — no login required. An external interviewer reaches this via a
// signed, single-use-per-slot link emailed to them (see interviewSlots.service.js
// scheduleSlot's external-interviewer branch). Intentionally shows only what's needed
// to conduct the interview, not the full candidate/drive record.
const ExternalInterviewPage = () => {
  const { token } = useParams();
  const [slot, setSlot] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [joinedRoom, setJoinedRoom] = useState(false);

  useEffect(() => {
    interviewSlots.getByToken(token)
      .then((res) => setSlot(res.data))
      .catch((err) => setError(getApiErrorMessage(err, 'This link is invalid or has expired')))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) return <div className="container">Loading interview details...</div>;
  if (error) return <div className="container error-box">{error}</div>;
  if (!slot) return null;

  return (
    <div className="container fade-in" style={{ maxWidth: '560px' }}>
      <h1 className="mb-2">Interview Details</h1>
      <p className="text-muted mb-8">You've been invited to conduct this interview.</p>

      <div className="problem-card" style={{ padding: '24px' }}>
        <div className="flex-center gap-2 mb-4" style={{ justifyContent: 'flex-start' }}>
          <Building2 size={18} className="text-muted" />
          <div>
            <div style={{ fontWeight: 700, fontSize: '1.1rem' }}>{slot.companyName}</div>
            <div className="text-muted" style={{ fontSize: '0.85rem' }}>{slot.roundName}</div>
          </div>
        </div>

        <div className="flex-center gap-2 mb-3" style={{ justifyContent: 'flex-start' }}>
          <User size={16} className="text-muted" />
          <span>Candidate: {slot.candidateName}</span>
        </div>

        <div className="flex-center gap-2 mb-3" style={{ justifyContent: 'flex-start' }}>
          <CalendarClock size={16} className="text-muted" />
          <span>{new Date(slot.scheduledAt).toLocaleString()} · {slot.durationMinutes} min</span>
        </div>

        {slot.meetingLink && (
          <a href={slot.meetingLink} target="_blank" rel="noreferrer" className="button mt-4">
            <LinkIcon size={16} /> Join Meeting
          </a>
        )}

        {slot.status === 'Scheduled' && !joinedRoom && (
          <button className="button mt-4" onClick={() => setJoinedRoom(true)}>
            <Video size={16} /> Join Interview Room
          </button>
        )}

        <div className="text-muted mt-4" style={{ fontSize: '0.8rem' }}>Status: {slot.status}</div>
      </div>

      {joinedRoom && (
        <div className="mt-8">
          <Suspense fallback={<div className="container">Loading interview room...</div>}>
            <InterviewRoom slotId={slot._id} accessToken={token} />
          </Suspense>
        </div>
      )}
    </div>
  );
};

export default ExternalInterviewPage;
