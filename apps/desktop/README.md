# Project Dialer - Windows desktop app

Electron shell that hosts the web softphone (`/softphone`) from **your** Dialer server in a locked-down window
(no Node in the page, sandboxed, navigation restricted to the configured server, microphone allowed only for it).

```bash
pnpm install
pnpm --filter @dialer/desktop start   # run in development
pnpm --filter @dialer/desktop dist    # build release/Project Dialer Setup <version>.exe (NSIS, unsigned)
```
First run asks for the server address (https://…; http only for localhost). Change it later from the Dialer menu.

Call servers set to **wss / ws** use the same SIP-over-WebSocket/WebRTC stack as the browser. Call servers set to **udp / tcp** use the
built-in SIP engine (`sip/sip-ua.js`, G.711 and DTMF) running on this computer.

## Calling from a normal browser (local bridge, since 0.3.0)
For udp / tcp call servers the Dialer website, open in a browser **on the same PC**, can use this app's SIP engine: keep the app running
(closing the window leaves it in the system tray; the tray menu has "Start with Windows"). The browser provides the screen, microphone and
speaker; the app does SIP and call audio. `sip/bridge.js` is a WebSocket server on `127.0.0.1:17654` only. It accepts a website only if it
is the configured server address or the user chose **Allow** in the app's question; it checks the Origin and Host headers and stores no SIP
password. One softphone at a time per PC (the app window or one browser tab). The website's CSP (`vercel.json`) must allow
`ws://127.0.0.1:17654`. The browser may ask for permission to access the local network. Phones and non-Windows computers cannot use this.

Activate / deactivate (Call Servers page, per call server or per SIP account) works inside this app too: the page checks every few seconds,
and on deactivation the engine ends any call and unregisters.

Limits: no TLS/SRTP and no NAT traversal (STUN/ICE) in the UDP/TCP engine. The installer is unsigned (Windows SmartScreen will warn) and has the default icon.
