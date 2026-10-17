import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { io as ioClient } from 'socket.io-client';
import request from 'supertest';
import app from '../app.js';
import College from '../../models/College.mjs';
import * as authService from '../services/auth.service.js';
import { attachSignaling } from './signaling.js';

// Real end-to-end tests of the WS relay itself (join-room auth, signal targeting, room
// membership, editor-update broadcast, peer-left on disconnect) - the piece that has zero
// coverage from interviewSlots.test.js, which only exercises the REST-adjacent
// resolveSlotForParticipant logic, not the socket.io event handlers themselves. This does
// NOT cover the browser-only half (actual WebRTC negotiation, getUserMedia, Yjs/Monaco
// mounting in InterviewRoom.jsx) - that still needs a real two-tab browser smoke test.
describe('Interview room signaling (realtime/signaling.js)', () => {
  let httpServer;
  let baseUrl;
  let adminToken;
  let facultyToken;
  let facultyId;
  let studentToken;
  let studentId;
  let collegeId;
  let slotId;
  const sockets = [];

  beforeEach(async () => {
    httpServer = http.createServer();
    attachSignaling(httpServer);
    await new Promise((resolve) => httpServer.listen(0, resolve));
    baseUrl = `http://localhost:${httpServer.address().port}`;

    const college = await College.create({ name: 'Signal College', slug: `signal-college-${Date.now()}` });
    collegeId = college._id.toString();

    const admin = await authService.register({
      name: 'Admin', email: `admin-${Date.now()}@test.com`, password: 'password123', role: 'admin', collegeId
    });
    adminToken = admin.token;

    const faculty = await authService.register({
      name: 'Faculty', email: `faculty-${Date.now()}@test.com`, password: 'password123', role: 'faculty', collegeId
    });
    facultyToken = faculty.token;
    facultyId = faculty.user.id;

    const student = await authService.register({
      name: 'Student', email: `student-${Date.now()}@test.com`, password: 'password123', role: 'student', collegeId, section: 'CSE-A'
    });
    studentToken = student.token;
    studentId = student.user.id;

    const driveRes = await request(app)
      .post('/api/drives')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ companyName: 'Signal Co', rounds: [{ name: 'Tech', type: 'interview' }], status: 'Active' });

    await request(app)
      .post(`/api/drives/${driveRes.body._id}/candidates`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ studentIds: [student.user.id] });

    const list = await request(app)
      .get(`/api/drives/${driveRes.body._id}/candidates`)
      .set('Authorization', `Bearer ${adminToken}`);

    const slotRes = await request(app)
      .post(`/api/interview-slots/candidate/${list.body[0]._id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ interviewerId: facultyId, scheduledAt: new Date(Date.now() + 3600000).toISOString() });
    slotId = slotRes.body.slot._id;
  });

  afterEach(async () => {
    sockets.forEach((s) => s.disconnect());
    sockets.length = 0;
    await new Promise((resolve) => httpServer.close(resolve));
  });

  function connectClient({ token, accessToken } = {}) {
    return new Promise((resolve, reject) => {
      const socket = ioClient(baseUrl, {
        path: '/ws/interview',
        transports: ['websocket'],
        extraHeaders: token ? { Cookie: `token=${token}` } : undefined,
        auth: accessToken ? { accessToken } : undefined,
        forceNew: true
      });
      sockets.push(socket);
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', reject);
    });
  }

  function joinRoom(socket, targetSlotId = slotId) {
    return new Promise((resolve) => socket.emit('join-room', { slotId: targetSlotId }, resolve));
  }

  it('two participants join the same room, see each other, and can leave', async () => {
    const a = await connectClient({ token: facultyToken });
    const ackA = await joinRoom(a);
    expect(ackA.ok).toBe(true);
    expect(ackA.identity.kind).toBe('interviewer');
    expect(ackA.peers).toEqual([]);

    const peerJoinedOnA = new Promise((resolve) => a.once('peer-joined', resolve));
    const b = await connectClient({ token: studentToken });
    const ackB = await joinRoom(b);
    expect(ackB.ok).toBe(true);
    expect(ackB.identity.kind).toBe('candidate');
    expect(ackB.peers.length).toBe(1);
    expect(ackB.peers[0].socketId).toBe(ackA.selfId);

    const peerJoinedEvent = await peerJoinedOnA;
    expect(peerJoinedEvent.socketId).toBe(ackB.selfId);
    expect(peerJoinedEvent.identity.kind).toBe('candidate');

    const peerLeftOnA = new Promise((resolve) => a.once('peer-left', resolve));
    b.disconnect();
    const leftEvent = await peerLeftOnA;
    expect(leftEvent.socketId).toBe(ackB.selfId);
  });

  it('relays a targeted signal only to its intended recipient', async () => {
    const a = await connectClient({ token: facultyToken });
    const ackA = await joinRoom(a);
    const peerJoinedOnA = new Promise((resolve) => a.once('peer-joined', resolve));
    const b = await connectClient({ token: studentToken });
    await joinRoom(b);
    const bSocketId = (await peerJoinedOnA).socketId;

    const gotSignal = new Promise((resolve) => b.once('signal', resolve));
    a.emit('signal', { to: bSocketId, data: { kind: 'offer', sdp: 'fake-sdp' } });
    const sig = await gotSignal;
    expect(sig.data).toEqual({ kind: 'offer', sdp: 'fake-sdp' });
    expect(sig.from).toBe(ackA.selfId);
    expect(sig.identity.kind).toBe('interviewer');
  });

  it('broadcasts editor-update to roommates but not back to the sender', async () => {
    const a = await connectClient({ token: facultyToken });
    await joinRoom(a);
    const b = await connectClient({ token: studentToken });
    await joinRoom(b);

    let aReceived = false;
    a.once('editor-update', () => { aReceived = true; });
    const gotOnB = new Promise((resolve) => b.once('editor-update', resolve));

    a.emit('editor-update', { kind: 'doc', update: [1, 2, 3] });
    const payload = await gotOnB;
    expect(payload).toEqual({ kind: 'doc', update: [1, 2, 3] });
    expect(aReceived).toBe(false);
  });

  it('rejects joining without any credentials', async () => {
    const anon = await connectClient({});
    const ack = await joinRoom(anon);
    expect(ack.error).toBeTruthy();
  });

  it('lets an external interviewer join with their signed token, but rejects a mismatched slotId', async () => {
    const driveRes = await request(app)
      .post('/api/drives')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ companyName: 'External Co', rounds: [{ name: 'Tech', type: 'interview' }], status: 'Active' });

    await request(app)
      .post(`/api/drives/${driveRes.body._id}/candidates`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ studentIds: [studentId] });
    const list = await request(app)
      .get(`/api/drives/${driveRes.body._id}/candidates`)
      .set('Authorization', `Bearer ${adminToken}`);

    const slotRes = await request(app)
      .post(`/api/interview-slots/candidate/${list.body[0]._id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        externalInterviewerName: 'External Bob',
        externalInterviewerEmail: 'bob@partner.com',
        scheduledAt: new Date(Date.now() + 3600000).toISOString()
      });
    const externalSlotId = slotRes.body.slot._id;
    const accessToken = slotRes.body.accessToken;

    const externalSocket = await connectClient({ accessToken });

    const wrongSlot = await joinRoom(externalSocket, slotId);
    expect(wrongSlot.error).toBeTruthy();

    const rightSlot = await joinRoom(externalSocket, externalSlotId);
    expect(rightSlot.ok).toBe(true);
    expect(rightSlot.identity).toEqual({ kind: 'external', name: 'External Bob' });
  });
});
