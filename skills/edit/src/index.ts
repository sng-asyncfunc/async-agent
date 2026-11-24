import { readFile, stat, writeFile } from "node:fs/promises";
import { emitDisplay, expandPath, requireString, type SkillContext } from "../../_shared/context.ts";

const DIFF_DISPLAY_MIME = "application/vnd.async-agent.diff+json";
const MAX_HINT_PREVIEW_CHARS = 140;

export interface EditRequest {
	path: string;
	oldStr: string;
	newStr: string;
}

export interface EditBatchOptions {
	dryRun?: boolean;
}

interface AppliedEdit {
	path: string;
	oldStr: string;
	newStr: string;
	startLine: number;
}

interface StagedFile {
	filepath: string;
	original: string;
	current: string;
	applied: AppliedEdit[];
}

function tokenizeLine(line: string): string[] {
	return line
		.toLowerCase()
		.split(/[^a-z0-9_]+/)
		.filter((token) => token.length >= 2);
}

function findClosestLineHint(content: string, oldStr: string): string | null {
	const needleLine = oldStr
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!needleLine) return null;

	const needleLower = needleLine.toLowerCase();
	const needleTokens = new Set(tokenizeLine(needleLine));
	const lines = content.split("\n");
	let bestIndex = -1;
	let bestScore = 0;

	for (let i = 0; i < lines.length; i += 1) {
		const trimmed = lines[i]!.trim();
		if (!trimmed) continue;
		const lower = trimmed.toLowerCase();
		let score = 0;
		if (lower === needleLower) {
			score = 1;
		} else if (lower.includes(needleLower) || needleLower.includes(lower)) {
			const ratio = Math.min(lower.length, needleLower.length) / Math.max(lower.length, needleLower.length);
			score = 0.65 + 0.3 * ratio;
		} else if (needleTokens.size > 0) {
			let overlap = 0;
			const lineTokens = new Set(tokenizeLine(trimmed));
			for (const token of needleTokens) {
				if (lineTokens.has(token)) overlap += 1;
			}
			const denom = Math.max(needleTokens.size, lineTokens.size);
			if (denom > 0) score = overlap / denom;
		}
		if (score > bestScore) {
			bestScore = score;
			bestIndex = i;
		}
	}

	if (bestIndex < 0 || bestScore < 0.35) return null;
	const preview = lines[bestIndex]!.trim();
	const clipped = preview.length > MAX_HINT_PREVIEW_CHARS ? `${preview.slice(0, MAX_HINT_PREVIEW_CHARS)}…` : preview;
	return `nearest match near line ${bestIndex + 1}: ${JSON.stringify(clipped)}`;
}

function applySingleInMemory(content: string, pathLabel: string, oldStr: string, newStr: string): {
	updated: string;
	startLine: number;
} {
	const occurrences = oldStr.length === 0 ? content.length + 1 : content.split(oldStr).length - 1;
	if (occurrences === 0) {
		const hint = findClosestLineHint(content, oldStr);
		throw new Error(hint ? `string not found in ${pathLabel} (${hint})` : `string not found in ${pathLabel}`);
	}
	if (occurrences > 1) {
		throw new Error(
			`found ${occurrences} occurrences in ${pathLabel}, need exactly 1 — widen the snippet to make it unique`,
		);
	}
	const matchIndex = content.indexOf(oldStr);
	const startLine = content.slice(0, matchIndex).split("\n").length;
	const updated = content.slice(0, matchIndex) + newStr + content.slice(matchIndex + oldStr.length);
	return { updated, startLine };
}

function emitDiffBestEffort(context: SkillContext, edit: AppliedEdit): void {
	try {
		emitDisplay(
			context,
			DIFF_DISPLAY_MIME,
			{
				path: edit.path,
				old_str: edit.oldStr,
				new_str: edit.newStr,
				start_line: edit.startLine,
			},
			`Edited ${edit.path}`,
		);
	} catch {
		// Best-effort display emission; never fail the edit on display error.
	}
}

export function createSkill(context: SkillContext) {
	const editSingle = async ({ path, oldStr, newStr }: EditRequest): Promise<string> => {
		requireString(path, "path");
		requireString(oldStr, "oldStr");
		requireString(newStr, "newStr");
		const filepath = expandPath(path, context.cwd);
		try {
			await stat(filepath);
		} catch {
			throw new Error(`${path} not found`);
		}
		const content = await readFile(filepath, "utf8");
		const { updated, startLine } = applySingleInMemory(content, path, oldStr, newStr);
		await writeFile(filepath, updated);
		emitDiffBestEffort(context, { path: filepath, oldStr, newStr, startLine });
		return `Edited ${filepath}`;
	};

	const batch = async (edits: EditRequest[], options: EditBatchOptions = {}): Promise<string> => {
		if (!Array.isArray(edits) || edits.length === 0) {
			throw new Error("edit.batch requires a non-empty array of { path, oldStr, newStr } requests");
		}
		const dryRun = options.dryRun === true;
		const staged = new Map<string, StagedFile>();

		// Phase 1: pre-validate and stage every edit in memory so a bad snippet
		// anywhere in the batch leaves all files on disk completely untouched.
		for (let i = 0; i < edits.length; i += 1) {
			const req = edits[i];
			if (!req || typeof req !== "object") {
				throw new Error(`edit.batch[${i}] must be an object with { path, oldStr, newStr }`);
			}
			try {
				requireString(req.path, "path");
				requireString(req.oldStr, "oldStr");
				requireString(req.newStr, "newStr");
			} catch (error) {
				throw new Error(`edit.batch[${i}]: ${error instanceof Error ? error.message : String(error)}`);
			}
			const filepath = expandPath(req.path, context.cwd);
			let entry = staged.get(filepath);
			if (!entry) {
				try {
					await stat(filepath);
				} catch {
					throw new Error(`edit.batch[${i}]: ${req.path} not found`);
				}
				const original = await readFile(filepath, "utf8");
				entry = { filepath, original, current: original, applied: [] };
				staged.set(filepath, entry);
			}
			try {
				const { updated, startLine } = applySingleInMemory(entry.current, req.path, req.oldStr, req.newStr);
				entry.current = updated;
				entry.applied.push({ path: filepath, oldStr: req.oldStr, newStr: req.newStr, startLine });
			} catch (error) {
				throw new Error(`edit.batch[${i}]: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		const files = [...staged.values()];
		if (dryRun) {
			return `Dry-run validated ${edits.length} edits across ${files.length} file${files.length === 1 ? "" : "s"}`;
		}

		// Phase 2: commit all staged files; roll back any already-written files if
		// an I/O failure occurs mid-commit.
		const written: StagedFile[] = [];
		try {
			for (const entry of files) {
				await writeFile(entry.filepath, entry.current);
				written.push(entry);
			}
		} catch (writeError) {
			for (const entry of written.reverse()) {
				try {
					await writeFile(entry.filepath, entry.original);
				} catch {
					// best-effort rollback
				}
			}
			throw writeError;
		}

		for (const entry of files) {
			for (const applied of entry.applied) {
				emitDiffBestEffort(context, applied);
			}
		}
		return `Edited ${files.length} file${files.length === 1 ? "" : "s"} (${edits.length} edits): ${files.map((f) => f.filepath).join(", ")}`;
	};

	return Object.assign(editSingle, { batch });
}
