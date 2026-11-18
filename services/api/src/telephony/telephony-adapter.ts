/** Replaceable boundary between the routing engine and the PBX. Real implementation: AriTelephonyAdapter. Tests use a scripted mock. */
export interface ServerEndpoint {
  ariUrl: string;
  ariUsername: string;
  ariPassword: string;
}

export interface OriginateRequest extends ServerEndpoint {
  callId: string;
  appName: string;
  /** PJSIP endpoint string, e.g. PJSIP/919876543210@trunk_ab12... */
  endpoint: string;
  callerId: string;
}

export type OriginateResult =
  | { ok: true; channelId: string }
  | {
      ok: false;
      code: string;
      sipCode?: number;
      /** A different route may succeed (infrastructure failure before the call was placed). */
      retryable: boolean;
      /** Unknown whether the PBX placed the call (e.g. timeout after the request was sent). Never retried, to avoid duplicate calls. */
      uncertain: boolean;
    };

export abstract class TelephonyAdapter {
  abstract originate(req: OriginateRequest): Promise<OriginateResult>;
  abstract hangup(req: ServerEndpoint & { channelId: string }): Promise<void>;
}
