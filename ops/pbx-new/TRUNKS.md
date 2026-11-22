# SIP trunk providers: what the kit supports now, and what would need development

The Dialer contains **no provider-specific code**. Browsers only ever talk to the PBX; the phone-network side (trunks, numbers, routing) is entirely PBX configuration. So a different provider never needs a change to the Dialer web app or the API. What differs is how much of the provider's settings the **kit script** `add-trunk.sh` can express. This page is based on reading `add-trunk.sh` and the dial plan in `pbx-setup.sh`; no trunk has been connected to a real provider.

## Supported now (one provider at a time, by script, no code change)

| Capability | How | Where |
|---|---|---|
| A provider that **registers** you (username + password) | `add-trunk.sh --host <host> --user <name> --inbound-ext <ext>` (password asked, hidden) | `add-trunk.sh` |
| A provider that authenticates **by your server's IP** | `add-trunk.sh --host <host> --ip-auth --inbound-ext <ext>` | `add-trunk.sh` |
| UDP signalling on port 5060, G.711 audio (`ulaw`, `alaw`) | fixed in the generated trunk | `add-trunk.sh` (`transport=transport-udp`, `allow=ulaw,alaw`) |
| Incoming calls from the provider | all of them ring one agent extension you choose | `add-trunk.sh` (`extensions_trunk_in.conf`) |
| Outgoing calls | agents dial 6+ digits; `STRIP_PREFIX` removes leading digits for the provider | `pbx-setup.sh` dial plan |
| Destination restrictions, call limits | `ALLOW_PREFIXES`, `DENY_PREFIXES`, `MAX_OUTBOUND`, `MAX_PER_AGENT`, `MAX_CALL_SECONDS` apply to **every** trunk call | `pbx-setup.sh` dial plan |
| Replacing the provider | `add-trunk.sh --remove`, then add the new one | `add-trunk.sh` |

## Not supported by the scripts (needs a hand edit of `/etc/asterisk/pjsip_trunk.conf` and the dial plan, or further development)

| Need | Why the scripts cannot do it today | Evidence |
|---|---|---|
| **Two or more providers at the same time** | the objects have fixed names (`trunk-out`, `trunk-auth`, `trunk-reg`, `trunk-aor`, `trunk-identify`) and a second `add-trunk.sh` is refused | `add-trunk.sh` line with `grep -q '^\[trunk-out\]'` |
| Routing between providers (by country / prefix, least cost, **failover** when one is down) | the dial plan dials one hard-coded endpoint (`PJSIP/${NUM}@trunk-out`) | `pbx-setup.sh` `[to-trunk]` |
| A provider on a **non-standard port** | `--host` accepts only a host name, no `:port` | `add-trunk.sh` host check |
| **TCP / TLS / SRTP** to the provider | the trunk uses the UDP transport and no media encryption | `add-trunk.sh` |
| A different **authentication user** than the account user, or a different SIP domain / realm / outbound proxy | `from_user`, `client_uri` and `server_uri` are derived from `--user` and `--host` | `add-trunk.sh` |
| Codecs other than G.711 (G.729, Opus), transcoding, fax (T.38) | only `ulaw,alaw` are offered | `add-trunk.sh` |
| **Per-number routing of incoming calls** (several DIDs to different agents, IVR, queues, hours) | every incoming call rings the one extension | `extensions_trunk_in.conf` template |
| Provider-specific **number formats** (adding a prefix, `+` handling, national 0) per trunk | `STRIP_PREFIX` is one global number | `pbx-setup.sh` |
| Caller-ID presentation (From / P-Asserted-Identity / privacy) | not configured | - |
| Several provider source addresses for IP authentication | `identify` matches one host | `add-trunk.sh` |
| Per-trunk concurrency limits, health monitoring and alerts, call cost / CDR reporting | only global limits exist, no monitoring | - |

## What a second provider would take (design, not built)

Smallest change that keeps the "no code in the Dialer" property: extend `add-trunk.sh` with `--name`, `--port`, `--transport`, `--auth-user`, `--codecs`, `--route-prefix` and generate objects named after the trunk; generate the dial plan from a small table (`prefix -> trunk[,failover trunk]`) instead of the single `trunk-out`; keep the destination rules and limits global or make them per trunk. About one to two days including tests in a scratch folder; real-provider tests need that provider's account. Advanced needs (least-cost routing, DID-based call flows, monitoring) are separate projects.

## If you need a second provider before that development exists

Copy the generated objects in `pjsip_trunk.conf`, give every object a new name (`trunk2-auth`, `trunk2-reg`, `trunk2-aor`, `trunk2-out`, `trunk2-identify`), and add a dial-plan branch that selects it by prefix before the `Dial()` in `[to-trunk]`. Keep the `ALLOW_PREFIXES` / limits checks in front of both. This is not scripted, not tested here, and is easy to get wrong: ask for it to be done properly instead.
