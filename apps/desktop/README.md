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

UDP / TCP calling works only inside this app's window. A normal browser can call only through wss / ws call servers.

Activate / deactivate (Call Servers page, per call server or per SIP account) works inside this app too: the page checks every few seconds,
and on deactivation the engine ends any call and unregisters.

Limits: no TLS/SRTP and no NAT traversal (STUN/ICE) in the UDP/TCP engine. The installer is unsigned (Windows SmartScreen will warn) and has the default icon.
