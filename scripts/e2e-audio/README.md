# Headless two-agent audio test

Registers two agents over WSS with **JsSIP** (the library the Dialer softphone uses) and a Node WebRTC stack, calls one from the other, sends a pure
tone from each side and **measures the tone it receives** (Goertzel). It proves what a registration or a ringing phone cannot: ICE, DTLS-SRTP and RTP
really carry audio **in both directions**. It can also force the media through a TURN relay.

```bash
cd scripts/e2e-audio && npm install          # once (not part of the pnpm workspace)

# agent to agent (direct path)
A_EXT=4991 A_PW=... B_EXT=4992 B_PW=... PBX_WSS=wss://pbx.example.org:8089/ws node run.mjs p2p

# the same call, forced through coturn (proves the relay and the short-lived credentials)
... TURN_URL="turn:pbx.example.org:3478?transport=udp" TURN_SECRET=... FORCE_RELAY=1 node run.mjs p2p

# simulated trunk numbers of the LOCAL test PBX (answer + echo, busy, refused, no answer)
... node run.mjs sim
```

* `INSECURE_TLS=1` only for a PBX with a self-signed certificate (local tests). Production uses a real certificate: leave it unset.
* Use dedicated test agents: registering the same extension as a real user replaces that user's registration.
* `ops/pbx-new/deploy-remote.sh` runs these checks automatically after a deployment.
* A test fails when the received tone is below a threshold, so silence (or only the sender's own tone) is a FAIL, not a pass.

Lesson built into `harness.mjs`: for an **outgoing** call JsSIP creates the peer connection inside `ua.call()`, so audio hooks must be passed in the
call's `eventHandlers`; a listener added after `call()` returns never fires (the Dialer softphone had exactly this bug: callers heard nothing).
