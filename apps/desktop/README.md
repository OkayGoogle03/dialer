# Project Dialer - Windows desktop app

Electron shell that hosts the web softphone (`/softphone`) from **your** Dialer server in a locked-down window
(no Node in the page, sandboxed, navigation restricted to the configured server, microphone allowed only for it).

```bash
pnpm install
pnpm --filter @dialer/desktop start   # run in development
pnpm --filter @dialer/desktop dist    # build release/Project Dialer Setup <version>.exe (NSIS, unsigned)
```
First run asks for the server address (https://…; http only for localhost). Change it later from the Dialer menu.

Limits: it uses the same SIP-over-WebSocket/WebRTC stack as the browser, so the call server must offer WSS + WebRTC.
Native UDP/TCP/TLS SIP (PJSIP) is not included. The installer is unsigned (Windows SmartScreen will warn) and has the default icon.
