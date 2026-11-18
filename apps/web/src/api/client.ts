/**
 * API client. The access token lives in memory only; the refresh token is an httpOnly cookie set by
 * the API, so it is never readable by JS. On 401 the client refreshes once (single-flight) and retries.
 */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown) {
    super(message);
  }
}

type Fetch = typeof fetch;

export class ApiClient {
  private accessToken: string | null = null;
  private refreshing: Promise<boolean> | null = null;
  onSessionExpired?: () => void;

  constructor(private readonly base = '/api/v1', private readonly fetchImpl: Fetch = (...a) => fetch(...a)) {}

  setAccessToken(token: string | null) {
    this.accessToken = token;
  }

  get isAuthenticated() {
    return this.accessToken !== null;
  }

  async request<T>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    if (res.status === 401 && retry && this.accessToken && !path.startsWith('/auth/')) {
      if (await this.refresh()) return this.request<T>(method, path, body, false);
      this.onSessionExpired?.();
    }
    if (res.status === 204) return undefined as T;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = (data as { error?: { message?: string; details?: unknown } }).error;
      throw new ApiError(res.status, err?.message ?? res.statusText, err?.details);
    }
    return data as T;
  }

  /** Uses the httpOnly refresh cookie. Concurrent callers share one in-flight refresh. */
  refresh(): Promise<boolean> {
    this.refreshing ??= (async () => {
      try {
        const res = await this.fetchImpl(`${this.base}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          credentials: 'same-origin',
        });
        if (!res.ok) {
          this.accessToken = null;
          return false;
        }
        const data = (await res.json()) as { accessToken: string };
        this.accessToken = data.accessToken;
        return true;
      } catch {
        return false;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /** Authenticated binary download (template, error report). Refreshes the session once on 401. */
  async download(method: 'GET' | 'POST', path: string, retry = true): Promise<{ blob: Blob; filename: string }> {
    const res = await this.fetchImpl(`${this.base}${path}`, { method, headers: this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}, credentials: 'same-origin' });
    if (res.status === 401 && retry && (await this.refresh())) return this.download(method, path, false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(res.status, (data as { error?: { message?: string } }).error?.message ?? res.statusText);
    }
    const cd = res.headers.get('Content-Disposition') ?? '';
    return { blob: await res.blob(), filename: /filename="([^"]+)"/.exec(cd)?.[1] ?? 'download' };
  }

  /** Multipart upload with progress (XMLHttpRequest, because fetch cannot report upload progress). */
  upload<T>(path: string, file: File, onProgress?: (percent: number) => void, retry = true): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${this.base}${path}`);
      if (this.accessToken) xhr.setRequestHeader('Authorization', `Bearer ${this.accessToken}`);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100)); };
      xhr.onerror = () => reject(new ApiError(0, 'Network error while uploading'));
      xhr.onload = async () => {
        if (xhr.status === 401 && retry && (await this.refresh())) return resolve(this.upload<T>(path, file, onProgress, false));
        let data: unknown = {};
        try { data = JSON.parse(xhr.responseText); } catch { /* non-JSON error body */ }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data as T);
        const err = (data as { error?: { message?: string; details?: unknown } }).error;
        reject(new ApiError(xhr.status, err?.message ?? `Upload failed (${xhr.status})`, err?.details));
      };
      const form = new FormData();
      form.append('file', file);
      xhr.send(form);
    });
  }

  get<T>(path: string) { return this.request<T>('GET', path); }
  post<T>(path: string, body?: unknown) { return this.request<T>('POST', path, body ?? {}); }
  put<T>(path: string, body: unknown) { return this.request<T>('PUT', path, body); }
  patch<T>(path: string, body: unknown) { return this.request<T>('PATCH', path, body); }
  delete<T>(path: string) { return this.request<T>('DELETE', path); }
}

export const api = new ApiClient();

export type { Branding, Me, Page, RoleView, TeamView, TenantSummary, UserView } from "@dialer/shared-types";

// ---- file helpers

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
