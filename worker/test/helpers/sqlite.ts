/// <reference types="node" />
// Test helper: the Store SQL interface on real SQLite (node:sqlite), the engine Durable Objects use.
import { DatabaseSync } from "node:sqlite";
import type { Sql } from "../../src/store";

export function sqlite(): Sql {
	const db = new DatabaseSync(":memory:");
	return {
		exec(query: string, ...bindings: unknown[]) {
			if (bindings.length === 0 && query.trim().split(";").filter((s) => s.trim()).length > 1) {
				db.exec(query);
				return { toArray: () => [], one: () => { throw new Error("no rows"); }, rowsWritten: 0 };
			}
			const stmt = db.prepare(query);
			if (/^\s*SELECT/i.test(query)) {
				const rows = stmt.all(...(bindings as any[])) as any[];
				return { toArray: () => rows, one: () => { if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`); return rows[0]; }, rowsWritten: 0 };
			}
			const r = stmt.run(...(bindings as any[]));
			return { toArray: () => [], one: () => { throw new Error("no rows"); }, rowsWritten: Number(r.changes) };
		},
	} as Sql;
}
