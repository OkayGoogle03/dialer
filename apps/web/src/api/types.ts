/** View shapes of the master-data, import and dialer APIs (see docs/api.md). Credentials never appear here. */
export interface Paged<T> { items: T[]; total: number; limit: number; offset: number }

export interface CallServerView {
  id: string; name: string; host: string | null; port: number | null; sipTransport: string; connectionMode?: 'direct' | 'bridge'; sipWsPath: string; sipRealm: string | null; addressUpdatedAt: string | null; autoCutEnabled?: boolean; autoCutSeconds?: number | null; webrtcUrl: string | null; instanceId: string | null; ariUrl: string | null; ariUsername: string | null; hasPassword: boolean;
  environment: string; connectionStatus: string; connectionError: string | null; maxConcurrentCalls: number; status: string;
}

export interface ProposalItem { key: string; name: string; rows: number; providerName?: string; prefix?: string }
export interface Proposals { processes: ProposalItem[]; providers: ProposalItem[]; callServers: ProposalItem[]; dids: ProposalItem[]; missingLinks: { processProvider: number; processDid: number; processServer: number } }

export interface SoftphoneCallView {
  id: string; status: string; from: string; dialed: string; entered: string | null; prefix: string | null; processName?: string | null; startedAt: string; answeredAt: string | null; endedAt: string | null;
  durationSeconds: number | null; hangupCause: string | null;
  /** Business result of a finished call (same rule as the call lists); null while the call is still running or for older calls. */
  outcome?: { status: 'success' | 'not_success'; note: string } | null;
}
export interface SipAccountView {
  id: string; userId: string; userEmail: string; userName: string; callServerId: string; callServerName: string; sipId: string; displayName: string | null; status: string;
  hasPassword: boolean; registrationStatus: string; registeredAt: string | null; lastSeenAt: string | null; lastError: string | null;
}

export interface CallListSummary { processNames: string[]; id: string; name: string; fileName: string | null; agentId: string; agentName: string; total: number; invalid: number; createdAt: string; counts: Record<string, number> }
export interface CallListItem {
  id: string; row: number; processName: string | null; serviceProvider: string | null; serverHost: string | null; sipId: string | null; prefix: string | null; phone: string | null; dialed: string | null; status: string; result: string | null;
  sipCode: number | null; attempts: number; calledAt: string | null; answeredAt: string | null; endedAt: string | null; durationSeconds: number | null;
}

export interface CallListSummary { id: string; name: string; fileName: string | null; agentId: string; agentName: string; total: number; invalid: number; createdAt: string; counts: Record<string, number> }
export interface CallListItem {
  id: string; row: number; serverHost: string | null; sipId: string | null; prefix: string | null; phone: string | null; dialed: string | null; status: string; result: string | null;
  sipCode: number | null; attempts: number; calledAt: string | null; answeredAt: string | null; endedAt: string | null; durationSeconds: number | null;
}

export interface CallDashboard {
  days: number;
  counts: Record<string, number>;
  daily: { date: string; status: string; n: number }[];
  byProcess: { name: string; success: number; notSuccess: number }[];
  byProvider: { name: string; success: number; notSuccess: number }[];
  answered: number;
  avgTalkSeconds: number | null;
  recent: { id: string; phone: string | null; processName: string | null; serviceProvider: string | null; status: string; result: string | null; calledAt: string | null; listName: string }[];
}
