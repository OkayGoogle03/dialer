# New personal PBX for the browser dialer (Asterisk + WSS + WebRTC + DuckDNS + Let's Encrypt)

For this project's **own** PBX, on a **new** server you rent or own for it. Nothing here touches any other network, server or phone system, and there is no existing configuration to overwrite: a fresh Ubuntu server. Your Windows System Application is not involved and is not changed.

What you end up with: `pbx-name.duckdns.org` → your server → Asterisk accepting **SIP over WSS** (trusted Let's Encrypt certificate, renewed automatically) and **WebRTC audio (DTLS-SRTP, ICE/STUN)** on `8089/tcp` + `10000-20000/udp`; one extension + username + password per browser agent; optional phone-network trunk. The Dialer (on Vercel) only tells each signed-in agent's browser which PBX to connect to; the browser connects **directly** to the PBX.

> **Read `AUDIT.md` first**: it lists the bugs found and fixed in this kit, what still needs a real server, and the deployment checklist.
>
> Step-by-step with expected output: `DEPLOY.md`. Phone-network providers: what works now and what needs development: `TRUNKS.md`.
>
> New settings in `/etc/pbx-setup.env`: `ALLOW_PREFIXES` / `DENY_PREFIXES` (outgoing calls through a trunk are refused until you set `ALLOW_PREFIXES`), `MAX_OUTBOUND`, `MAX_PER_AGENT`, `MAX_CALL_SECONDS`, `FAIL2BAN_IGNORE` (see the header of `pbx-setup.sh`). The file is read as plain `KEY=VALUE` lines, never executed.
>
> Written from Asterisk's documented behaviour and checked only by generating the files in a test folder here (no live Asterisk, certificate or call was possible). Every stage verifies itself and undoes itself on failure; run the stages one at a time and read the output.

## 0. What you need (nothing is bought for you)

| Need | Notes |
|---|---|
| A server | Ubuntu 22.04 or 24.04 LTS, a **public IPv4 address**, 1 vCPU / 1 GB RAM is enough for a few agents. Any VPS provider; free tiers exist but their terms change, check the current offer yourself. SSH access as a sudo user. |
| The provider's own firewall / security group | Must allow `22/tcp` (SSH), `8089/tcp`, `10000-20000/udp`. This is separate from the server's firewall (ufw) and a very common reason for "nothing connects". |
| A DuckDNS account | duckdns.org → create a name such as `my-pbx-name` (you get `my-pbx-name.duckdns.org`) and copy your **token**. Free. |
| An e-mail address | for Let's Encrypt expiry notices. |
| A SIP trunk (only for real phone numbers) | A paid service from a provider of your choice. They give you: SIP server host, username, password and whether they use registration or IP authentication. Agent-to-agent calls need none. |

## 1. Copy the kit to the server

From your PC (replace the user and host with your server's own):

```bash
scp -r ops user@YOUR_SERVER:~/
ssh user@YOUR_SERVER
cd ~/ops/pbx-new
```

Create the settings file (mode 600):

```bash
sudo sh -c 'umask 077; cat > /etc/pbx-setup.env' <<'EOF'
DOMAIN=my-pbx-name.duckdns.org
EMAIL=you@example.com
DUCKDNS_TOKEN=paste-your-token-here
# CERTBOT_STAGING=1     # practice certificate first (no rate limits, browsers will not trust it). Before going live:  sudo certbot delete --cert-name <name>, remove this line, rerun the certificate stage.
EOF
```

The script refuses the file unless it is owned by root with mode 600 (it holds the DuckDNS token): `sudo chown root:root /etc/pbx-setup.env && sudo chmod 600 /etc/pbx-setup.env`.

## 2. Stages (each one on its own; stop if anything fails)

```bash
sudo sh pbx-setup.sh preflight      # READ-ONLY: OS, public IP, NAT yes/no, ports in use, what is installed. Changes nothing.
sudo sh pbx-setup.sh install        # installs asterisk, certbot, curl, ufw, fail2ban; refuses to continue if Asterisk < 16.2 or WSS/SRTP modules are missing
sudo sh pbx-setup.sh dns            # DuckDNS points your name at this server (and a cron job keeps it current)
sudo sh pbx-setup.sh certificate    # Let's Encrypt via DNS-01 through DuckDNS (no port 80 needed) + renewal hook, tested with --dry-run
sudo sh pbx-setup.sh configure      # writes OUR files, includes them, verifies, auto-reverts if the check fails
sudo sh pbx-setup.sh harden         # fail2ban: bans addresses that guess SIP passwords (add your own fixed address to ignoreip first)
sudo sh pbx-setup.sh firewall       # prints the plan (SSH allowed + rate-limited first); apply with:  sudo sh pbx-setup.sh firewall --yes   (keep a 2nd SSH session open)
sudo sh pbx-setup.sh status
```

What `preflight` tells you (so nothing is guessed): the **OS**, whether the server has the **public IP itself or sits behind NAT** (cloud VMs usually do: `configure` then sets `external_media_address`, `external_signaling_address`, `local_net`), and whether ports 8089 / 5060 are already used.

What `configure` changes, exactly: it creates `http_dialer.conf`, `pjsip_dialer.conf`, `rtp_dialer.conf`, `extensions_dialer.conf` (plus empty `pjsip_agents.conf`, `pjsip_trunk.conf`, `extensions_trunk_in.conf`) in `/etc/asterisk` and adds **one `#include` line** to each of `http.conf`, `pjsip.conf`, `rtp.conf`, `extensions.conf` (`logger.conf` and `acl.conf` in the harden / agent steps), after a timestamped snapshot of `/etc/asterisk` and saving the original of each file as `<file>.before-pbx-setup`. The includes for `http.conf` and `rtp.conf` are placed inside their `[general]` section, because Asterisk only reads the first `[general]` of a file.

## 3. Agents: one extension, username and password each

```bash
sudo sh add-agent.sh 4001 "Asha Verma"
sudo sh add-agent.sh 4002 "Ravi Kumar"
sudo sh add-agent.sh 4003 "Fixed-office agent" --allow-ip 203.0.113.0/24   # optional PBX-side source-IP restriction (extra layer)
```

It prints each password **once**. In the Dialer: **Call Servers → Add call server** (name, host `my-pbx-name.duckdns.org`, transport *Direct browser-to-PBX: WSS*, port `8089`, path `/ws`), then **SIP accounts → Add SIP account** per agent with that username/password. Each agent registers independently from their own browser and can call at the same time as the others. Remove an agent with `sudo sh add-agent.sh --remove 4002`.

## 4. Verify from OUTSIDE (not from the server, not from the same Wi-Fi)

From a phone on mobile data tethered to a laptop, or any other network:

```bash
node scripts/check-pbx-wss.mjs my-pbx-name.duckdns.org 8089 /ws --origin https://YOUR-VERCEL-SITE
```

You need: certificate trusted, WebSocket accepted with the `sip` sub-protocol, SIP answer. Then sign in to the Dialer from two different networks as two agents, open the Softphone (it shows *Direct browser-to-PBX*, the extension and **Registered**) and call between their extensions: you should hear audio both ways.

## 5. Phone numbers (only if you have a trunk)

```bash
sudo sh add-trunk.sh --host sip.provider.example --user 1234567 --inbound-ext 4001     # asks for the password without showing it (preferred: nothing in shell history)
# or, if the provider authenticates by your server's IP:   sudo sh add-trunk.sh --host sip.provider.example --ip-auth --inbound-ext 4001
```

Outgoing: an agent dials a number of 6 or more digits (or `+` and the number) and it leaves through the trunk. Incoming calls to your number ring the extension you chose. If your provider wants a prefix removed or added, say so and the dial plan is adjusted from the provider's own instructions (nothing is guessed here).

## 6. If an agent connects but hears nothing (one-way or no audio)

Almost always NAT or a firewall: check the provider firewall has `10000-20000/udp`, that `sudo sh pbx-setup.sh status` shows the public IP you expect, and, for agents behind strict corporate firewalls, add a TURN server (see `docs/pbx-wss-letsencrypt.md`, section 6) and set `WEBRTC_TURN_*` on the Dialer's API host.

## 7. Rollback (each piece independently)

| What | Command |
|---|---|
| One agent | `sudo sh add-agent.sh --remove 4002` |
| The trunk | `sudo sh add-trunk.sh --remove` |
| Everything this kit added | `sudo sh pbx-setup.sh rollback` (removes our includes and files, firewall rules, DuckDNS cron, hooks; keeps the originals `*.before-pbx-setup`; asks before deleting the certificate) |
| Back to the first backup of one file | `sudo cp -a /etc/asterisk/pjsip.conf.before-pbx-setup /etc/asterisk/pjsip.conf && sudo asterisk -rx "module reload res_pjsip.so"` |

## 8. Testing without a server (optional)

The generators can be run in a scratch folder without Asterisk: `ASTERISK_ETC=/tmp/aeta PBX_STATE=/tmp/aeta-state ENV_FILE=/tmp/aeta.env DRY_RUN=1 sh pbx-setup.sh configure` (create the folder, a fake `keys/pbx.crt` and the env file first). That is how these scripts were checked here.
