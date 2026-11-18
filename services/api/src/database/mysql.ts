import mysql, { Pool, TypeCastField } from 'mysql2/promise';
import type { DbConfig } from '../config/env';

/** TINYINT(1) -> boolean; everything else default. */
function typeCast(field: TypeCastField, next: () => unknown) {
  if (field.type === 'TINY' && field.length === 1) {
    const v = field.string();
    return v === null ? null : v === '1';
  }
  return next();
}

export function createPool(db: DbConfig, user: string, password: string, connectionLimit = db.poolSize): Pool {
  const pool = mysql.createPool({
    host: db.host,
    port: db.port,
    database: db.name,
    user,
    password,
    ssl: db.tls ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : undefined,
    namedPlaceholders: true,
    timezone: 'Z',
    connectionLimit,
    maxIdle: Math.min(connectionLimit, 5),
    idleTimeout: 60_000,
    enableKeepAlive: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    typeCast,
  });
  // All DATETIME values are UTC; CURRENT_TIMESTAMP defaults must be evaluated in UTC too.
  pool.pool.on('connection', (conn) => {
    conn.query(`SET time_zone = '+00:00'`);
  });
  return pool;
}
