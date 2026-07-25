import { Pool, type PoolConfig } from "pg";
import type { AppConfig } from "./config.js";

/**
 * Builds a PostgreSQL connection pool from validated config.
 *
 * task-1.1 establishes the pool factory only; the ledger schema and queries
 * are added by task 1.2 and later. Callers own the pool lifecycle.
 */
export function createPool(config: AppConfig): Pool {
  const { database } = config;
  const poolConfig: PoolConfig = database.connectionString
    ? { connectionString: database.connectionString }
    : {
        host: database.host,
        port: database.port,
        user: database.user,
        password: database.password,
        database: database.database,
      };

  if (database.ssl) {
    poolConfig.ssl = { rejectUnauthorized: false };
  }

  return new Pool(poolConfig);
}
