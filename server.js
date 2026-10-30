// Live audio share: static file server + WebSocket signaling.
// Media never passes through this server. It only relays WebRTC offers,
// answers and ICE candidates between the single host and each listener.

import express from 'express';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

export function createServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
  app.get('/healthz', (_req, res) => res.type('text').send('ok'));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

  // State lives in memory. This is a single-process app by design.
  let host = null;                 // the one active host socket, or null
  const listeners = new Map();     // id -> socket, for every subscribed listener

  const isOpen = (ws) => ws && ws.readyState === WebSocket.OPEN;
  const send = (ws, msg) => { if (isOpen(ws)) ws.send(JSON.stringify(msg)); };
  const hostOnline = () => isOpen(host);

  function announceHostOffline() {
    for (const l of listeners.values()) send(l, { type: 'host-offline' });
  }

  function handleHostClaim(ws) {
    if (hostOnline() && host !== ws) return send(ws, { type: 'host-busy' });
    host = ws;
    ws.role = 'host';
    send(ws, { type: 'host-ok', id: ws.id });
    for (const [id, l] of listeners) {
      send(l, { type: 'host-online' });
      send(ws, { type: 'listener-joined', id });  // host opens a peer for each waiting listener
    }
  }

  function handleHostStop(ws) {
    if (host !== ws) return;
    host = null;
    ws.role = 'idle';
    announceHostOffline();
  }

  function handleSubscribe(ws) {
    ws.role = 'listener';
    listeners.set(ws.id, ws);
    send(ws, { type: 'subscribed', id: ws.id, hostOnline: hostOnline() });
    if (hostOnline()) send(host, { type: 'listener-joined', id: ws.id });
  }

  function handleUnsubscribe(ws) {
    if (!listeners.delete(ws.id)) return;
    ws.role = 'idle';
    send(host, { type: 'listener-left', id: ws.id });
  }

  function handleSignal(ws, msg) {
    if (typeof msg.to !== 'string' || !msg.data) return;
    // Host may signal a subscribed listener. A listener may signal only the host.
    let target = null;
    if (ws === host) target = listeners.get(msg.to) || null;
    else if (listeners.has(ws.id) && host && msg.to === host.id) target = host;
    if (!target) return;
    send(target, { type: 'signal', from: ws.id, data: msg.data });
  }

  wss.on('connection', (ws) => {
    ws.id = crypto.randomUUID();
    ws.role = 'idle';
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      switch (msg?.type) {
        case 'host-claim':   return handleHostClaim(ws);
        case 'host-stop':    return handleHostStop(ws);
        case 'subscribe':    return handleSubscribe(ws);
        case 'unsubscribe':  return handleUnsubscribe(ws);
        case 'signal':       return handleSignal(ws, msg);
      }
    });

    ws.on('close', () => {
      if (host === ws) { host = null; ws.role = 'idle'; announceHostOffline(); }
      handleUnsubscribe(ws);
    });
  });

  // Drop dead sockets so a vanished host does not block others forever.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();
  server.on('close', () => clearInterval(heartbeat));

  return { app, server, wss, getState: () => ({ hostOnline: hostOnline(), listeners: listeners.size }) };
}

// Start only when run directly, so tests can import createServer().
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server } = createServer();
  server.listen(PORT, () => {
    console.log(`Live audio share running on http://localhost:${PORT}`);
  });
}
