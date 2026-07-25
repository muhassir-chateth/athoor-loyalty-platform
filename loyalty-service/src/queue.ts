import PgBoss from "pg-boss";
import type { AppConfig } from "./config.js";

/**
 * Job-queue factory (pg-boss, backed by the same Postgres instance — no extra
 * infra). All outbound Admin API and email work is deferred here rather than
 * run synchronously in request/webhook handlers (Requirement 13.2).
 *
 * task-1.1 establishes the factory only; job registration/backoff policies are
 * added by later tasks (e.g. discount-code generation in task 5.3).
 */
export function createQueue(config: AppConfig): PgBoss {
  const connectionString =
    config.database.connectionString ??
    `postgres://${config.database.user ?? ""}:${config.database.password ?? ""}` +
      `@${config.database.host ?? "localhost"}:${config.database.port ?? 5432}` +
      `/${config.database.database ?? ""}`;

  return new PgBoss({ connectionString });
}
