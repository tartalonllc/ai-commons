import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE providers (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    healthy INTEGER NOT NULL,
    models TEXT NOT NULL,
    checked_at INTEGER NOT NULL
  );

  -- Costs are integer micro-USD, always rounded up.
  CREATE TABLE usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    provider_kind TEXT NOT NULL,
    model TEXT NOT NULL,
    task_id TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    estimated_cost_micros INTEGER NOT NULL DEFAULT 0,
    reserved_micros INTEGER NOT NULL DEFAULT 0,
    actual_cost_micros INTEGER,
    status TEXT NOT NULL CHECK (status IN ('reserved', 'settled', 'orphaned')),
    duration_ms INTEGER,
    day TEXT NOT NULL,
    month TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    settled_at INTEGER
  );
  CREATE INDEX usage_day ON usage (day);
  CREATE INDEX usage_month ON usage (month);
  CREATE INDEX usage_status ON usage (status);

  CREATE TABLE tasks (
    lease_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    project_version TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    provider TEXT,
    model TEXT,
    failure_reason TEXT,
    duration_ms INTEGER,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );

  CREATE TABLE results (
    lease_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    result_json TEXT NOT NULL,
    submission_status TEXT NOT NULL,
    submitted_at INTEGER NOT NULL
  );

  CREATE TABLE coordinator_sessions (
    coordinator_origin TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL,
    heartbeat_interval_ms INTEGER NOT NULL,
    lease_duration_ms INTEGER NOT NULL,
    registered_at INTEGER NOT NULL
  );
  `,
];

export type Row = Record<string, SQLInputValue>;

export class WorkerDatabase {
  readonly raw: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec(
      'PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;',
    );
    this.migrate();
  }

  private migrate(): void {
    const current = Number((this.get('PRAGMA user_version') ?? {}).user_version ?? 0);
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.transaction(() => {
        this.raw.exec(MIGRATIONS[v] as string);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  /** BEGIN IMMEDIATE takes the write lock up front, serializing check-then-insert across processes. */
  transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }

  run(
    sql: string,
    ...params: SQLInputValue[]
  ): { lastInsertRowid: number | bigint; changes: number | bigint } {
    return this.raw.prepare(sql).run(...params);
  }

  get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.raw.prepare(sql).get(...params) as Row | undefined;
  }

  all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.raw.prepare(sql).all(...params) as Row[];
  }

  getSetting(key: string): string | undefined {
    const row = this.get('SELECT value FROM settings WHERE key = ?', key);
    return row ? String(row.value) : undefined;
  }

  setSetting(key: string, value: string): void {
    this.run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value,
    );
  }

  close(): void {
    if (this.raw.isOpen) this.raw.close();
  }
}

export function num(value: SQLInputValue | undefined): number {
  if (value === null || value === undefined) return 0;
  return Number(value);
}
