# Roles, modules and screens

Two kinds of accounts:

| Kind | Where it lives | What it is |
|---|---|---|
| **Platform Super Admin** | The single *platform* tenant, listed in `platform_admins` | Runs the SaaS: creates, suspends and manages client companies. Has **no tenant permissions** (empty permission list in the token), so it can never open tenant modules such as users, providers or calls. Platform routes re-check `platform_admins` on every request. |
| **Tenant users** | A client company (tenant) | Everything else. What each user can do is decided by roles/permissions. They can never reach platform routes. |

Sign-in: the super admin uses the platform company ID; tenant users use their own company ID. After sign-in a super admin lands on the **Platform Console**; tenant users land on the tenant dashboard.

## Platform Super Admin
| Screen / module | Status |
|---|---|
| Tenants: list, create, edit plan/domain/limits, suspend, reactivate | **Built** |
| Subscription plans and usage per tenant | Planned (Phase 7) |
| System health (database, NATS, Asterisk, providers) | Planned (Phase 7) |
| Platform audit log / cross-tenant support access | Planned |
| Platform staff accounts (more than one super admin) | Planned (CLI today: `provision --platform`) |

## Tenant roles (system roles seeded in every tenant)
Permission sets as implemented in `packages/shared-types/src/rbac.ts`.

| Screen / module | Tenant Admin | Supervisor | Team Leader | Agent | Auditor | Billing Admin |
|---|---|---|---|---|---|---|
| Dashboard | yes | yes | yes | yes | yes | yes |
| Softphone (register own SIP account, dial with prefix, own calls) | yes | yes | yes | **yes** | – | – |
| Caller Excel Import | yes | yes | – | – | – | – |
| Processes (view) | yes | view | view | – | – | – |
| SIP Providers / Trunks (view) | yes | view | view | – | – | – |
| DIDs (view) | yes | view | view | – | – | – |
| Call Servers (view) | yes | view | view | – | – | – |
| Processes / assignments (manage) | yes | – | – | – | – | – |
| SIP Providers / Trunks / DIDs (manage, verify, activate) | yes | – | – | – | – | – |
| Call Servers (manage, test, activate) | yes | – | – | – | – | – |
| Users (view) | yes | view | view | – | view | – |
| Users (manage) | yes | – | – | – | – | – |
| Teams (view / manage) | yes / yes | view | view | – | view | – |
| Roles & permissions (manage) | yes | – | – | – | – | – |
| Branding | yes | – | – | – | – | – |
| Call statistics (`/dialer/stats`), all-calls history | yes | yes | yes | own calls only | all calls | – |

Notes:
- Custom roles can be built from the 31 permissions by a Tenant Admin; nobody can grant or manage permissions they do not hold themselves.
- Agents get their dial options (process + prefix) from the softphone config endpoint, so they need no master-data access (fixed in this change: previously the Dialer screen failed for agents).
- Supervisors can approve Excel-import proposals (records are created as *Pending*) but cannot activate or verify anything.

## Screens required but not built yet (from the product spec)
| Screen | Needed by | Phase |
|---|---|---|
| Agent workspace (softphone, scripts, dispositions) | Agent | 3-4 |
| Supervisor dashboard and live call monitoring | Supervisor, Team Leader | 4 |
| Campaign management, contacts, queues | Supervisor, Admin | 4 |
| Call history and recordings | Supervisor, Team Leader, Auditor | 2-4 |
| Reports and analytics | Supervisor, Auditor, Billing Admin | 4 |
| Audit log viewer | Auditor, Admin | 1-7 |
| Subscription and usage | Billing Admin, Admin | 7 |
| AI agent configuration, AI testing, knowledge bases | Admin, Supervisor | 5-6 |
| Self-service password reset | everyone | 7 |
| Auditor and Billing Admin have no working screens beyond the dashboard today | Auditor, Billing Admin | – |

## Home screen per role (what each account sees after sign-in)
| Account type | Lands on | Sidebar |
|---|---|---|
| Platform super admin | Platform overview (client companies, active/suspended, users, plans, newest companies) | Overview, Tenants only |
| Tenant Admin | Calling-setup checklist, latest calls, last 24 h, people | all tenant screens |
| Supervisor / Team Leader | Setup status (read-only, "Ask an administrator"), latest calls, last 24 h, people | Dashboard, Users, Softphone, Caller Excel Import (supervisor), Processes, SIP Providers, DIDs, Call Servers, Teams |
| Agent | My recent calls + Open softphone | Dashboard, Softphone |
| Auditor | Last 24 h, people | Dashboard, Users, Teams |
| Billing Admin | Explains that billing screens are not available yet | Dashboard |

Sign-in uses the company ID: the platform super admin signs in with the platform company ID (`platform`), every other account with its own company ID (for example `demo`, `dgtd`). A tenant user who opens a platform address is refused (UI and API); a super admin who opens a tenant address is redirected to the overview.
