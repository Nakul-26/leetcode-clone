import React, { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import * as Y from 'yjs';
import { MonacoBinding } from 'y-monaco';
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate } from 'y-protocols/awareness';
import { Mic, MicOff, Video, VideoOff, PhoneOff } from 'lucide-react';
import { interviewSlots, resolveBaseUrl } from '../api';
import { getApiErrorMessage } from '../utils/assessmentForm';

// Without this, Monaco tries to run its language services on the main thread and can
// freeze the tab (confirmed live - see the "Could not create web worker(s)" console
// warning this fixes). The shared editor is a plain scratchpad, not a graded submission,
// so only the base editor worker is wired up - no per-language (ts/json/css/html) workers.
self.MonacoEnvironment = {
  getWorker: () => new EditorWorker()
};

// Optional - the interview room works fine on STUN alone for most networks (same-network,
// most home/mobile connections). TURN only matters for participants behind restrictive
// corporate/campus NATs; see docker-compose.prod.yml's coturn service and its VITE_TURN_*
// env vars for the self-hosted TURN option this soft-fails without.
function buildIceServers() {
  const servers = [{ urls: 'stun:stun.l.google.com:19302' }];
  const turnUrl = import.meta.env.VITE_TURN_URL;
  if (turnUrl) {
    servers.push({
      urls: turnUrl,
      username: import.meta.env.VITE_TURN_USERNAME,
      credential: import.meta.env.VITE_TURN_CREDENTIAL
    });
  }
  return servers;
}

const RATING_FIELDS = [
  { key: 'communication', label: 'Communication' },
  { key: 'problemSolving', label: 'Problem Solving' },
  { key: 'technicalDepth', label: 'Technical Depth' }
];

// Live interview room for one InterviewSlot (Phase D). Reached either via
// InterviewRoomPage (/interview-room/:slotId, cookie-authenticated staff/candidate) or
// from ExternalInterviewPage (external interviewer, carrying their signed slot token
// instead of a session). Mesh WebRTC (direct peer connections, no media server - see the
// Phase D plan notes on why that's the right call for ~1-4 participants) for
// audio/video, plus a Yjs-backed shared Monaco editor. The backend's realtime/signaling.js
// is a dumb relay: it only authorizes room membership, all WebRTC/Yjs logic is here.
const InterviewRoom = ({ slotId, accessToken }) => {
  const [status, setStatus] = useState('connecting'); // connecting | joined | error
  const [errorMsg, setErrorMsg] = useState('');
  const [identity, setIdentity] = useState(null);
  const [remoteTiles, setRemoteTiles] = useState([]);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [scorecard, setScorecard] = useState({ communication: '', problemSolving: '', technicalDepth: '', notes: '' });
  const [scorecardStatus, setScorecardStatus] = useState('idle'); // idle | saving | saved | error
  const [scorecardError, setScorecardError] = useState('');

  const socketRef = useRef(null);
  const localStreamRef = useRef(null);
  const localVideoRef = useRef(null);
  const pcsRef = useRef(new Map());
  const ydocRef = useRef(null);
  const awarenessRef = useRef(null);
  const editorContainerRef = useRef(null);
  const editorRef = useRef(null);
  const bindingRef = useRef(null);

  const setTile = useCallback((socketId, patch) => {
    setRemoteTiles((prev) => {
      const idx = prev.findIndex((t) => t.socketId === socketId);
      if (idx === -1) return [...prev, { socketId, identity: null, stream: null, ...patch }];
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  }, []);

  const removeTile = useCallback((socketId) => {
    setRemoteTiles((prev) => prev.filter((t) => t.socketId !== socketId));
    const pc = pcsRef.current.get(socketId);
    if (pc) {
      pc.close();
      pcsRef.current.delete(socketId);
    }
  }, []);

  const createPeerConnection = useCallback((socketId, remoteIdentity) => {
    const pc = new RTCPeerConnection({ iceServers: buildIceServers() });
    pcsRef.current.set(socketId, pc);

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => pc.addTrack(track, localStreamRef.current));
    }
    pc.ontrack = (event) => setTile(socketId, { identity: remoteIdentity, stream: event.streams[0] });
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current?.emit('signal', { to: socketId, data: { kind: 'ice', candidate: event.candidate } });
      }
    };
    return pc;
  }, [setTile]);

  useEffect(() => {
    let cancelled = false;

    const ydoc = new Y.Doc();
    const awareness = new Awareness(ydoc);
    ydocRef.current = ydoc;
    awarenessRef.current = awareness;

    ydoc.on('update', (update, origin) => {
      if (origin === 'remote') return;
      socketRef.current?.emit('editor-update', { kind: 'doc', update: Array.from(update) });
    });
    awareness.on('update', ({ added, updated, removed }) => {
      const update = encodeAwarenessUpdate(awareness, added.concat(updated, removed));
      socketRef.current?.emit('editor-update', { kind: 'awareness', update: Array.from(update) });
    });

    async function setup() {
      let stream = null;
      try {
        // Race against a timeout - an unanswered permission prompt (browser policy,
        // no hardware, or a user who just never clicks it) leaves getUserMedia's promise
        // pending forever with no rejection, which would otherwise block the whole room
        // indefinitely. Confirmed live: without this, the page hangs on "Connecting..."
        // permanently in that case instead of falling back to a no-media join.
        stream = await Promise.race([
          navigator.mediaDevices.getUserMedia({ video: true, audio: true }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('media-timeout')), 8000))
        ]);
      } catch {
        // Camera/mic denied, unavailable, or timed out - still let them join for the
        // shared editor and to be visible to peers as a no-video participant, rather
        // than blocking entry.
      }
      if (cancelled) {
        stream?.getTracks().forEach((t) => t.stop());
        return;
      }
      localStreamRef.current = stream;
      if (stream && localVideoRef.current) localVideoRef.current.srcObject = stream;

      const socket = io(resolveBaseUrl() || undefined, {
        path: '/ws/interview',
        withCredentials: true,
        auth: accessToken ? { accessToken } : undefined
      });
      socketRef.current = socket;

      socket.on('connect_error', () => {
        if (!cancelled) {
          setErrorMsg('Could not connect to the interview server');
          setStatus('error');
        }
      });

      socket.on('signal', async ({ from, identity: fromIdentity, data }) => {
        if (data.kind === 'offer') {
          const pc = pcsRef.current.get(from) || createPeerConnection(from, fromIdentity);
          setTile(from, { identity: fromIdentity });
          await pc.setRemoteDescription(data.sdp);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('signal', { to: from, data: { kind: 'answer', sdp: answer } });
        } else if (data.kind === 'answer') {
          const pc = pcsRef.current.get(from);
          if (pc) await pc.setRemoteDescription(data.sdp);
        } else if (data.kind === 'ice') {
          const pc = pcsRef.current.get(from);
          if (pc && data.candidate) {
            try { await pc.addIceCandidate(data.candidate); } catch { /* benign race if the connection already closed */ }
          }
        } else if (data.kind === 'yjs-full-state') {
          Y.applyUpdate(ydoc, new Uint8Array(data.update), 'remote');
        }
      });

      socket.on('peer-joined', ({ socketId, identity: peerIdentity }) => {
        setTile(socketId, { identity: peerIdentity });
        // Proactively share our current doc state with the newcomer rather than waiting
        // for a request - keeps the join protocol to a single relay primitive (`signal`).
        socket.emit('signal', { to: socketId, data: { kind: 'yjs-full-state', update: Array.from(Y.encodeStateAsUpdate(ydoc)) } });
      });

      socket.on('peer-left', ({ socketId }) => removeTile(socketId));

      socket.on('editor-update', (payload) => {
        if (payload.kind === 'doc') Y.applyUpdate(ydoc, new Uint8Array(payload.update), 'remote');
        else if (payload.kind === 'awareness') applyAwarenessUpdate(awareness, new Uint8Array(payload.update), 'remote');
      });

      socket.emit('join-room', { slotId }, async (res) => {
        if (cancelled) return;
        if (res?.error) {
          setErrorMsg(res.error);
          setStatus('error');
          return;
        }
        setIdentity(res.identity);
        setStatus('joined');

        // We're the newcomer - offer to everyone already in the room (they wait for our
        // offer rather than also offering, which avoids a signaling glare/collision).
        for (const peer of res.peers || []) {
          setTile(peer.socketId, { identity: peer.identity });
          const pc = createPeerConnection(peer.socketId, peer.identity);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('signal', { to: peer.socketId, data: { kind: 'offer', sdp: offer } });
        }
      });
    }

    setup();

    const pcs = pcsRef.current;
    return () => {
      cancelled = true;
      socketRef.current?.emit('leave-room');
      socketRef.current?.disconnect();
      pcs.forEach((pc) => pc.close());
      pcs.clear();
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      awareness.destroy();
      ydoc.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotId, accessToken]);

  // Mounted once the container exists; independent of the room-joining effect above so a
  // slow getUserMedia() prompt doesn't delay the editor from being usable.
  useEffect(() => {
    if (!editorContainerRef.current || editorRef.current) return;
    const editor = monaco.editor.create(editorContainerRef.current, {
      value: '',
      // Only the base editor worker is wired up (see MonacoEnvironment above) - plaintext
      // avoids requesting the separate TypeScript language-service worker, which would
      // silently get the wrong worker implementation instead of degrading gracefully.
      language: 'plaintext',
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 14
    });
    editorRef.current = editor;
    bindingRef.current = new MonacoBinding(ydocRef.current.getText('monaco'), editor.getModel(), new Set([editor]), awarenessRef.current);

    return () => {
      bindingRef.current?.destroy();
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  const toggleMic = () => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      setMicOn(track.enabled);
    }
  };

  const toggleCam = () => {
    const track = localStreamRef.current?.getVideoTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      setCamOn(track.enabled);
    }
  };

  const submitScorecard = async (e) => {
    e.preventDefault();
    setScorecardStatus('saving');
    setScorecardError('');
    try {
      const payload = {
        ratings: {
          communication: scorecard.communication || undefined,
          problemSolving: scorecard.problemSolving || undefined,
          technicalDepth: scorecard.technicalDepth || undefined
        },
        notes: scorecard.notes || undefined
      };
      if (accessToken) await interviewSlots.submitScorecardByToken(accessToken, payload);
      else await interviewSlots.submitScorecard(slotId, payload);
      setScorecardStatus('saved');
    } catch (err) {
      setScorecardStatus('error');
      setScorecardError(getApiErrorMessage(err, 'Failed to submit scorecard'));
    }
  };

  if (status === 'error') {
    return <div className="error-box">{errorMsg}</div>;
  }

  const canScore = identity && identity.kind !== 'candidate';

  return (
    <div className="fade-in">
      {status === 'connecting' && <p className="text-muted mb-4">Connecting to the interview room...</p>}

      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(remoteTiles.length + 1, 3)}, 1fr)`, gap: '12px', marginBottom: '16px' }}>
        <div style={{ position: 'relative', background: '#000', borderRadius: 'var(--radius-lg)', aspectRatio: '16/9', overflow: 'hidden' }}>
          <video ref={localVideoRef} autoPlay muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          <span style={{ position: 'absolute', bottom: 6, left: 8, color: '#fff', fontSize: '0.75rem', background: 'rgba(0,0,0,0.5)', padding: '2px 8px', borderRadius: '999px' }}>
            You{identity ? ` (${identity.kind})` : ''}
          </span>
        </div>
        {remoteTiles.map((tile) => (
          <RemoteTile key={tile.socketId} tile={tile} />
        ))}
      </div>

      <div className="flex-center gap-2 mb-4">
        <button className="button button-outline" onClick={toggleMic}>{micOn ? <Mic size={16} /> : <MicOff size={16} />} {micOn ? 'Mute' : 'Unmute'}</button>
        <button className="button button-outline" onClick={toggleCam}>{camOn ? <Video size={16} /> : <VideoOff size={16} />} {camOn ? 'Stop Video' : 'Start Video'}</button>
      </div>

      <div ref={editorContainerRef} style={{ height: '420px', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }} />

      {canScore && (
        <div className="problem-card mt-4" style={{ padding: '20px' }}>
          <h3 className="mb-2">Scorecard</h3>
          {scorecardStatus === 'saved' ? (
            <div className="error-box" style={{ background: 'rgba(16, 185, 129, 0.1)', color: 'var(--success)', borderColor: 'rgba(16, 185, 129, 0.2)' }}>
              Scorecard submitted.
            </div>
          ) : (
            <form onSubmit={submitScorecard}>
              {scorecardError && <div className="error-box">{scorecardError}</div>}
              {RATING_FIELDS.map((f) => (
                <div className="form-group" key={f.key}>
                  <label>{f.label} (1-5):</label>
                  <select value={scorecard[f.key]} onChange={(e) => setScorecard({ ...scorecard, [f.key]: e.target.value })}>
                    <option value="">—</option>
                    {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
              ))}
              <div className="form-group">
                <label>Notes:</label>
                <textarea value={scorecard.notes} onChange={(e) => setScorecard({ ...scorecard, notes: e.target.value })} />
              </div>
              <button type="submit" className="button" disabled={scorecardStatus === 'saving'}>
                {scorecardStatus === 'saving' ? 'Submitting...' : 'Submit Scorecard'}
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
};

const RemoteTile = ({ tile }) => {
  const videoRef = useRef(null);
  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = tile.stream || null;
  }, [tile.stream]);

  return (
    <div style={{ position: 'relative', background: '#000', borderRadius: 'var(--radius-lg)', aspectRatio: '16/9', overflow: 'hidden' }}>
      {tile.stream ? (
        <video ref={videoRef} autoPlay playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : (
        <div className="flex-center" style={{ width: '100%', height: '100%', color: 'var(--text-muted)' }}>
          <PhoneOff size={20} />
        </div>
      )}
      <span style={{ position: 'absolute', bottom: 6, left: 8, color: '#fff', fontSize: '0.75rem', background: 'rgba(0,0,0,0.5)', padding: '2px 8px', borderRadius: '999px' }}>
        {tile.identity?.name || 'Connecting...'}
      </span>
    </div>
  );
};

export default InterviewRoom;
