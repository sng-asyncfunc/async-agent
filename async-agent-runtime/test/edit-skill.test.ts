import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSkill } from "../../skills/edit/src/index.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "async-edit-skill-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("edit skill", () => {
	test("single edit replaces unique snippet, emits diff display, and gives closest-line hint on mismatch", async () => {
		const dir = makeTempDir();
		const file = path.join(dir, "retry.ts");
		fs.writeFileSync(file, "export const TIMEOUT = 1000;\nexport const maxRetries = 3;\nexport const ok = true;\n");

		const displays: Array<Record<string, unknown>> = [];
		const edit = createSkill({
			cwd: dir,
			display: (payload) => displays.push(payload as Record<string, unknown>),
			hostRequest: async () => ({}),
		});

		// Mismatch provides nearest-line hint so caller can fix without re-reading whole file
		await expect(
			edit({ path: "retry.ts", oldStr: "export const maxRetries = 5;", newStr: "export const maxRetries = 8;" }),
		).rejects.toThrow(/nearest match near line 2:.*maxRetries = 3/);

		// Exact match succeeds and emits diff display
		const msg = await edit({
			path: "retry.ts",
			oldStr: "export const maxRetries = 3;",
			newStr: "export const maxRetries = 5;",
		});
		expect(msg).toContain("Edited");
		expect(fs.readFileSync(file, "utf8")).toContain("maxRetries = 5");
		expect(displays.length).toBe(1);
		expect(displays[0]!["application/vnd.async-agent.diff+json"]).toBeDefined();
	});

	test("edit.batch applies multi-file and sequential same-file edits atomically and leaves disk untouched on any failure", async () => {
		const dir = makeTempDir();
		const fileA = path.join(dir, "a.ts");
		const fileB = path.join(dir, "b.ts");
		const origA = "const a = 1;\nconst b = 2;\n";
		const origB = "export const label = 'before';\n";
		fs.writeFileSync(fileA, origA);
		fs.writeFileSync(fileB, origB);

		const displays: Array<unknown> = [];
		const edit = createSkill({
			cwd: dir,
			display: (_mime, data) => displays.push(data),
			hostRequest: async () => ({}),
		});

		// Failing 2nd edit must leave fileA untouched on disk!
		await expect(
			edit.batch([
				{ path: "a.ts", oldStr: "const a = 1;", newStr: "const a = 10;" },
				{ path: "b.ts", oldStr: "export const label = 'typo';", newStr: "export const label = 'after';" },
			]),
		).rejects.toThrow(/edit\.batch\[1\].*nearest match near line 1/);
		expect(fs.readFileSync(fileA, "utf8")).toBe(origA);
		expect(fs.readFileSync(fileB, "utf8")).toBe(origB);
		expect(displays.length).toBe(0);

		// dryRun validates without writing
		const dryMsg = await edit.batch(
			[
				{ path: "a.ts", oldStr: "const a = 1;", newStr: "const a = 10;" },
				{ path: "a.ts", oldStr: "const b = 2;", newStr: "const b = 20;" },
				{ path: "b.ts", oldStr: "export const label = 'before';", newStr: "export const label = 'after';" },
			],
			{ dryRun: true },
		);
		expect(dryMsg).toContain("Dry-run validated 3 edits across 2 files");
		expect(fs.readFileSync(fileA, "utf8")).toBe(origA);
		expect(displays.length).toBe(0);

		// Real batch commits all 3 edits across 2 files
		const okMsg = await edit.batch([
			{ path: "a.ts", oldStr: "const a = 1;", newStr: "const a = 10;" },
			{ path: "a.ts", oldStr: "const b = 2;", newStr: "const b = 20;" },
			{ path: "b.ts", oldStr: "export const label = 'before';", newStr: "export const label = 'after';" },
		]);
		expect(okMsg).toContain("Edited 2 files (3 edits)");
		expect(fs.readFileSync(fileA, "utf8")).toBe("const a = 10;\nconst b = 20;\n");
		expect(fs.readFileSync(fileB, "utf8")).toBe("export const label = 'after';\n");
		expect(displays.length).toBe(3);
	});
});
