# Live Audio Share

One host shares live audio from a browser tab, window, or screen. Anyone who opens the same URL can click **Listen** and hear it. There is one fixed URL, no rooms, and no per-listener links. Only one host can be live at a time.

Audio goes peer to peer over WebRTC. The server only relays connection setup (offers, answers, ICE candidates) over a WebSocket. It never sees, stores, or records audio. The microphone is never requested.

## Stack

- **Server:** Node.js with Express (static files) and `ws` (signaling). Plain ES modules, no build step.
- **Client:** Vanilla HTML, CSS, and JavaScript in `public/`. No framework and no bundler.
- **Media:** WebRTC, one `RTCPeerConnection` per listener, audio only.

## Run locally

Requires Node.js 18 or newer.

```bash
npm install
npm start            # http://localhost:3000  (set PORT to change it)
npm test             # signaling tests, no browser needed
```

To try both roles, open `http://localhost:3000` in two windows. In one, click **Start sharing** and pick a Chrome tab with audio. In the other, click **Listen**. `localhost` counts as a secure context, so sharing works without HTTPS during development.

## How it works

1. The host clicks **Start sharing**. The browser shows its picker (`getDisplayMedia`). The host picks a tab, window, or screen and ticks the audio option.
2. The client drops the video track and keeps only the audio, then tells the server it is the host. If another host is live, the server refuses.
3. Each listener who clicks **Listen** subscribes. The server tells the host, which creates an offer for that listener. Offers, answers, and ICE candidates are relayed through the server.
4. Once connected, audio flows directly between host and listener. Listeners play it through an `<audio>` element.
5. If the host stops, closes the tab, or the browser's own "Stop sharing" control is used, listeners are told the host went offline. When a host starts again, waiting listeners reconnect automatically.

Listeners who are waiting keep their subscription across short network drops and reconnect on their own. The host's share does not survive a dropped connection and must be started again.

## Deploy

The app is one long-running Node process with an open WebSocket. Pick a host that supports long-lived connections.

**Requirements**
- Node.js 18+ and a single process. The "one host" rule lives in memory, so do not run several instances behind a load balancer. If you need more than one instance, move the host and listener state to a shared store such as Redis first.
- HTTPS on a public domain. This is mandatory, see below.
- WebSocket support at `/ws`.

**Examples**
- **Render, Railway, Fly.io:** create a Node web service, build command `npm install`, start command `npm start`. The platform provides HTTPS and WebSocket proxying.
- **A VPS with nginx:** run the app under systemd or pm2 on `127.0.0.1:3000`, then proxy both HTTP and WebSocket traffic:

```nginx
server {
  listen 443 ssl http2;
  server_name share.example.com;
  # ssl_certificate / ssl_certificate_key from Let's Encrypt or similar

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;     # required for /ws
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;                    # keep idle sockets open
  }
}
```

**Networking for listeners.** The app uses a public STUN server, which works for most home and office networks. Some corporate or mobile networks block peer-to-peer UDP. Those listeners will see "Could not connect to the host." To support them, run a TURN server (for example coturn) and add it to `RTC_CONFIG` in `public/app.js`:

```js
iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' },
]
```

## Browser and OS limitations

Browser support for capturing audio from a shared tab or screen is the main constraint. The app checks what it can and shows a helpful message when sharing is unavailable. Browser support changes over time, so test the host setup on the exact browser and OS you plan to use.

| Environment | Listen | Host (share audio) |
|---|---|---|
| Desktop Chrome or Edge, Windows | Yes | Yes. Tab audio, or **Entire screen** with "Share system audio" |
| Desktop Chrome or Edge, Linux or ChromeOS | Yes | Tab audio (Chrome's "Share tab audio") |
| Desktop Chrome, macOS | Yes | Tab audio. System-wide audio is limited and depends on the Chrome version |
| Firefox (desktop) | Yes | Limited. Firefox does not reliably capture tab or system audio through this API, so the app shows a message |
| Safari (desktop, macOS) | Yes | Limited. Audio capture from a screen or tab is restricted, so use Chrome or Edge |
| Android and iOS, phones and tablets | Yes | No. The browser cannot share tab or screen audio |

Notes:
- **Only audio that is playing in the chosen source is shared.** Choose the tab that makes the sound. Other tabs and notifications are not included.
- **The host must tick the audio option** in the picker. The app detects a missing audio track and explains what to tick.
- **Operating system audio capture** depends on the OS and browser. Windows is the most reliable for system audio.
- **Autoplay:** listeners click **Listen**, which starts playback. Browsers can still pause audio, so the native player controls on the page can resume it.
- **Echo:** the host cannot listen on the same device, because it would hear its own audio twice. The Listen button is disabled while hosting.

## HTTPS and secure context

`getDisplayMedia` and `RTCPeerConnection` only run in a secure context: HTTPS, or `localhost`. If you open the page over plain `http://` on another machine, the host panel shows a message and sharing does not start. Listening also needs a secure context in most browsers, so always deploy with HTTPS. The page switches to `wss://` automatically when served over HTTPS.

## Privacy

- The server stores nothing about audio. It holds in-memory connection state only: which socket is host and which sockets are listeners. That state disappears on restart.
- The app never requests the microphone and never calls `MediaRecorder`.
- The host's video track is stopped immediately after the picker, so the screen contents are not transmitted.

## Limits to know about

- **One host at a time.** This is intentional. A second host gets a clear "already hosting" message.
- **Listener count is limited by the host's upload bandwidth.** Each listener is a separate peer connection, so the host sends one audio stream per listener. Audio is capped at about 96 kbps per listener. A typical home upload connection can serve a few dozen listeners. For larger audiences, add an SFU such as LiveKit, mediasoup, or Janus.
- **Latency** is usually under a second on a good connection, but it varies with the network.
- **The host tab must stay open.** Closing it or stopping the share ends the broadcast.

## Project layout

```
server.js               Express static server and WebSocket signaling
public/index.html       Single page with Listen and Host panels
public/app.js           WebRTC, signaling client, and UI logic
public/style.css        Styles with light and dark themes
test/signaling.test.js  Signaling tests (npm test)
```
