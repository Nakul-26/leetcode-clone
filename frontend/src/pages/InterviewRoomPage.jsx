import React from 'react';
import { useParams } from 'react-router-dom';
import InterviewRoom from '../components/InterviewRoom';

// Cookie-authenticated entry point for staff/candidates. Lazy-loaded from App.jsx since
// this pulls in the full monaco-editor + yjs bundle, which nothing else in the app needs.
const InterviewRoomPage = () => {
  const { slotId } = useParams();
  return (
    <div className="container fade-in">
      <h1 className="mb-4">Interview Room</h1>
      <InterviewRoom slotId={slotId} />
    </div>
  );
};

export default InterviewRoomPage;
