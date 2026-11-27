/* Records one received call for the call history. The reports are sent one after another, so "ended" can never overtake "answered" or
 * the creation of the record. Saving history must never get in the way of the call: failures are ignored. */

interface Api {
  post<T>(path: string, body: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
}

export function recordIncoming(api: Api, accountId: string, from: string, callerName?: string) {
  let chain: Promise<string | null> = api
    .post<{ callId: string }>('/softphone/calls/incoming', { accountId, from: (from || 'unknown').slice(0, 32), ...(callerName ? { callerName: callerName.slice(0, 100) } : {}) })
    .then((r) => r.callId, () => null);
  let done = false;
  const report = (status: 'answered' | 'completed' | 'failed', cause?: string) => {
    chain = chain.then(async (id) => {
      if (id) await api.patch(`/softphone/calls/${id}`, { status, ...(cause ? { cause: cause.slice(0, 100) } : {}) }).catch(() => undefined);
      return id;
    });
    return chain;
  };
  return {
    answered: () => (done ? chain : report('answered')),
    finished: (status: 'completed' | 'failed', cause: string) => { if (done) return chain; done = true; return report(status, cause); },
  };
}
