import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { getAllowedOrigins } from "../config/corsOrigins.js";
import { resolveSlotForParticipant } from "../services/interviewSlots.service.js";

// Mesh WebRTC ceiling (see the Phase D plan notes) - every participant connects directly
// to every other, which stops scaling gracefully well before this, but real interview
// panels top out around here.
const MAX_ROOM_SIZE = 4;

function parseCookie(header, name) {
  if (!header) return null;
  const match = header.split(";").map((p) => p.trim()).find((p) => p.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

// Mirrors auth.mjs's extractToken/normalizeUser (cookie first, since that's how the
// browser session actually authenticates) but this is a raw WS handshake, not an Express
// request, so it can't reuse that middleware directly. An external interviewer has no
// JWT at all - they carry the Phase C signed slot token instead, passed explicitly since
// it's already public-ish (scoped to one slot, not a session credential).
function authenticateSocket(socket) {
  const { accessToken, token: authToken } = socket.handshake.auth || {};
  if (accessToken) return { accessToken };

  const raw = parseCookie(socket.handshake.headers.cookie, "token") || authToken;
  if (!raw) return {};

  try {
    const decoded = jwt.verify(raw, env.JWT_SECRET);
    return { user: decoded.id ? { ...decoded, _id: decoded.id } : decoded };
  } catch {
    return {};
  }
}

function roomName(slotId) {
  return `interview:${slotId}`;
}

function leaveRoom(socket) {
  if (socket.roomId) {
    socket.to(socket.roomId).emit("peer-left", { socketId: socket.id });
    socket.leave(socket.roomId);
    socket.roomId = null;
  }
}

// Deliberately a dumb relay: the server never inspects WebRTC SDP/ICE payloads or Yjs
// document contents, it just authorizes room membership and forwards opaque messages
// between sockets already confirmed to be in the same room. All CRDT merge logic (Yjs)
// and media negotiation (WebRTC) logic lives client-side.
export function attachSignaling(httpServer) {
  const io = new Server(httpServer, {
    path: "/ws/interview",
    cors: { origin: getAllowedOrigins(), credentials: true }
  });

  io.on("connection", (socket) => {
    socket.authContext = authenticateSocket(socket);

    socket.on("join-room", async ({ slotId } = {}, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      try {
        if (!slotId) return reply({ error: "slotId is required" });
        const { slot, identity } = await resolveSlotForParticipant(slotId, socket.authContext);
        if (slot.status !== "Scheduled") return reply({ error: "This interview is not active" });

        const room = roomName(slotId);
        const existing = await io.in(room).fetchSockets();
        if (existing.length >= MAX_ROOM_SIZE) return reply({ error: "This interview room is full" });

        socket.join(room);
        socket.roomId = room;
        socket.identity = identity;

        reply({
          ok: true,
          selfId: socket.id,
          identity,
          peers: existing.map((s) => ({ socketId: s.id, identity: s.identity }))
        });
        socket.to(room).emit("peer-joined", { socketId: socket.id, identity });
      } catch (err) {
        reply({ error: err.message || "Failed to join room" });
      }
    });

    // Targeted relay used for WebRTC offer/answer/ICE exchange and for sharing full Yjs
    // document state with a newly-joined peer (data.kind distinguishes these client-side).
    socket.on("signal", ({ to, data } = {}) => {
      if (!socket.roomId || !to) return;
      const target = io.sockets.sockets.get(to);
      if (!target || !target.rooms.has(socket.roomId)) return;
      io.to(to).emit("signal", { from: socket.id, identity: socket.identity, data });
    });

    // Broadcast relay for incremental Yjs updates (doc + awareness/cursor presence).
    socket.on("editor-update", (payload) => {
      if (!socket.roomId) return;
      socket.to(socket.roomId).emit("editor-update", payload);
    });

    socket.on("leave-room", () => leaveRoom(socket));
    socket.on("disconnect", () => leaveRoom(socket));
  });

  return io;
}
