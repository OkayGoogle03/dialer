const HINTS: Record<string, string> = {
  ER_ACCESS_DENIED_ERROR: 'wrong database user or password: check DB_USER_PREFIX (must end with a dot) and DB_API_PASSWORD / DB_PLATFORM_PASSWORD',
  ER_DBACCESS_DENIED_ERROR: 'the user has no access to this database: check DB_NAME and run pnpm db:setup-roles',
  ER_BAD_DB_ERROR: 'the database does not exist: check DB_NAME',
  ER_NO_SUCH_TABLE: 'tables are missing: run pnpm db:migrate',
  ER_TABLEACCESS_DENIED_ERROR: 'grants are missing: run pnpm db:setup-roles',
  ENOTFOUND: 'host not found: check DB_HOST',
  EAI_AGAIN: 'host not found: check DB_HOST',
  ETIMEDOUT: 'connection timed out: check DB_HOST / DB_PORT and the database network access list',
  ECONNREFUSED: 'connection refused: check DB_HOST / DB_PORT',
  ECONNRESET: 'connection reset: check DB_TLS (TiDB Cloud needs true) and the network access list',
  HANDSHAKE_SSL_ERROR: 'TLS problem: DB_TLS must be true for TiDB Cloud',
  PROTOCOL_CONNECTION_LOST: 'connection dropped: check DB_TLS and the network access list',
};

/** Turns a database error into a short, safe description: the error code plus a hint. Never includes messages, hosts or user names. */
export function diagnoseDbError(e: unknown): string {
  const raw = String((e as { code?: unknown } | null)?.code ?? '');
  const code = /^[A-Z0-9_]{3,40}$/.test(raw) ? raw : 'UNKNOWN_ERROR';
  return HINTS[code] ? `${code} - ${HINTS[code]}` : code;
}
