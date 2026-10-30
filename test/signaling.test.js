// Run with: npm test
// Verifies the signaling rules without a browser: one host, relayed signals, host-offline notices.
import assert from 'node:assert/strict';
import { createServer } from '../server.js';
import { WebSocket } from 'ws';

const { server } = createServer();
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

function client() {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const inbox = [];
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  const next = (type, timeout = 2000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return resolve(inbox.splice(i, 1)[0]);
      if (Date.now() - started > timeout) return reject(new Error(`timeout waiting for ${type}`));
      setTimeout(tick, 10);
    };
    tick();
  });
  const send = (m) => ws.send(JSON.stringify(m));
  return new Promise((r) => ws.on('open', () => r({ ws, send, next, inbox, close: () => ws.close() })));
}

const log = (name) => console.log('  ok -', name);

// 1. Host claims successfully; a second host is refused.
const host = await client();
const host2 = await client();
host.send({ type: 'host-claim' });
const hostOk = await host.next('host-ok');
assert.equal(hostOk.type, 'host-ok'); log('first host claims the slot');
const hostId = hostOk.id;
host2.send({ type: 'host-claim' });
assert.equal((await host2.next('host-busy')).type, 'host-busy'); log('second host is refused while one is live');

// 2. Listener subscribes before/after host; host gets listener-joined with the id.
const l1 = await client();
l1.send({ type: 'subscribe' });
const sub1 = await l1.next('subscribed');
assert.equal(sub1.hostOnline, true); log('listener sees host is online');
const joined = await host.next('listener-joined');
assert.equal(joined.id, sub1.id); log('host receives listener-joined for that listener');

// 3. Signals relay host -> listener and listener -> host only.
host.send({ type: 'signal', to: sub1.id, data: { description: { type: 'offer', sdp: 'x' } } });
const offer = await l1.next('signal');
assert.equal(offer.data.description.type, 'offer'); assert.equal(offer.from, hostId); log('offer relayed host -> listener with sender id');

// 4. Listener answers the host (relay works in the other direction).
l1.send({ type: 'signal', to: hostId, data: { description: { type: 'answer', sdp: 'y' } } });
const answer = await host.next('signal');
assert.equal(answer.from, sub1.id); assert.equal(answer.data.description.type, 'answer'); log('answer relayed listener -> host');

// 4b. A listener cannot address another listener (no listener-to-listener leakage).
const l2 = await client();
l2.send({ type: 'subscribe' });
const sub2 = await l2.next('subscribed'); await host.next('listener-joined');
l1.send({ type: 'signal', to: sub2.id, data: { candidate: {} } });
await new Promise((r) => setTimeout(r, 100));
assert.equal(l2.inbox.length, 0); log('listener cannot signal another listener');

// 5. Host stops -> listeners are told; a new host can claim again.
host.send({ type: 'host-stop' });
assert.equal((await l1.next('host-offline')).type, 'host-offline'); log('listeners notified when host stops');
host2.send({ type: 'host-claim' });
assert.equal((await host2.next('host-ok')).type, 'host-ok'); log('slot is free again after host stops');
assert.equal((await host2.next('listener-joined')).id, sub1.id); log('new host picks up the waiting listener');

// 6. Host disconnect (no explicit stop) also frees the slot and notifies listeners.
host2.close();
assert.equal((await l1.next('host-offline')).type, 'host-offline'); log('host socket closing counts as host-offline');

// 7. Listener leaving notifies the host (host is online again first).
l1.send({ type: 'unsubscribe' });
// no host online now, so nothing to notify; verify the server still accepts new hosts cleanly
const host3 = await client();
host3.send({ type: 'host-claim' });
assert.equal((await host3.next('host-ok')).type, 'host-ok'); log('a fresh host can start after everyone left');

// 8. HTTP: the page and health check are served.
const page = await fetch(`http://localhost:${port}/`).then((r) => r.text());
assert.match(page, /Live Audio Share/); log('index page is served');
assert.equal(await fetch(`http://localhost:${port}/healthz`).then((r) => r.text()), 'ok'); log('health check responds');

for (const c of [host, host2, host3, l1, l2]) c.close();
server.close();
console.log('\nAll signaling checks passed.');
process.exit(0);
