/** View shapes of the master-data, import and dialer APIs (see docs/api.md). Credentials never appear here. */
export interface Paged<T> { items: T[]; total: number; limit: number; offset: number }

export interface ProviderView {
  id: string; name: string; description: string | null; status: string; priority: number; weight: number; maxConcurrentCalls: number;
  trunkCount: number; activeTrunks: number; didCount: number;
}
export interface TrunkView {
  id: string; name: string; serviceProviderId: string; host: string; port: number; transport: 'udp' | 'tcp' | 'tls'; authMode: 'registration' | 'ip';
  username: string | null; hasPassword: boolean; status: string; healthStatus: string; registrationStatus: string; verificationStatus: string;
  maxConcurrentCalls: number; priority: number; lastTestError: string | null;
}
export interface DidView {
  id: string; did: string; serviceProviderId: string; providerName: string; trunkId: string | null; trunkName: string | null; callerId: string; prefix: string | null;
  verificationStatus: string; maxConcurrentCalls: number; status: string;
}
export interface ProcessView {
  id: string; name: string; code: string; description: string | null; defaultServiceProviderId: string | null; routingStrategy: string; maxConcurrentCalls: number; status: string;
  providerCount: number; didCount: number; serverCount: number; callerAssignmentCount: number;
  dialPlan: { stripLeadingZeros: boolean; minLength: number; maxLength: number; allowedDestinationPrefixes: string[]; blockedDestinationPrefixes: string[] };
}
export interface CallServerView {
  id: string; name: string; host: string | null; port: number | null; sipTransport: string; sipWsPath: string; sipRealm: string | null; addressUpdatedAt: string | null; webrtcUrl: string | null; instanceId: string | null; ariUrl: string | null; ariUsername: string | null; hasPassword: boolean;
  environment: string; connectionStatus: string; connectionError: string | null; maxConcurrentCalls: number; status: string;
}
export interface AssignmentsView {
  processId: string; providerIds: string[]; didIds: string[]; serverIds: string[]; defaultProviderId: string | null;
  callerAssignments: { id: string; provider: string; did: string; prefix: string; callServer: string; status: string }[];
}

export interface ImportSummary { totalExcelRecords: number; validRecords: number; invalidRecords: number; duplicateRecords: number; successfullyImported: number; failedImports: number }
export interface ProposalItem { key: string; name: string; rows: number; providerName?: string; prefix?: string }
export interface Proposals { processes: ProposalItem[]; providers: ProposalItem[]; callServers: ProposalItem[]; dids: ProposalItem[]; missingLinks: { processProvider: number; processDid: number; processServer: number } }
export interface BatchRow { id: string; fileName: string; status: string; mode: string | null; totalRows: number; importedRows: number; createdAt: string }
export interface ImportRecord { rowNumber: number; processName: string; serviceProvider: string; did: string; prefix: string; callServer: string; status: string; errors: { code: string; message: string }[] }
export interface BatchDetail {
  batch: BatchRow; summary: ImportSummary;
  discovery: { existing: { processes: number; providers: number; callServers: number; dids: number } | null; proposals: Proposals | null };
  alreadyImported?: boolean; rows?: Paged<ImportRecord>; warnings?: { code: string; message: string }[];
}

export interface RouteCandidate { provider: string; trunk: string | null; did: string; callServer: string; prefix: string; dialedNumber: string | null; operational: boolean; reasons: string[] }
export interface RoutePreview { process: string; strategy: string; selected: { provider: string; did: string; callServer: string; prefix: string } | null; candidates: RouteCandidate[] }
export interface CallView {
  id: string; status: string; destination: string; callerId: string; startedAt: string; endedAt: string | null;
  route: { process: string; provider: string; trunk: string; did: string; prefix: string; callServer: string };
  attempts: { attempt: number; provider: string; status: string; failureCode: string | null }[]; warning?: string;
}

export interface SoftphoneCallView {
  id: string; status: string; from: string; dialed: string; entered: string | null; prefix: string | null; startedAt: string; answeredAt: string | null; endedAt: string | null;
  durationSeconds: number | null; hangupCause: string | null;
}
export interface SipAccountView {
  id: string; userId: string; userEmail: string; userName: string; callServerId: string; callServerName: string; sipId: string; displayName: string | null; status: string;
  hasPassword: boolean; registrationStatus: string; registeredAt: string | null; lastSeenAt: string | null; lastError: string | null;
}
