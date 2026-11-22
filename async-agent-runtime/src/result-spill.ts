export const DEFAULT_RESULT_SPILL_CHARS = 24_000;
const MAX_ARRAY_SCHEMA_SCAN = 5_000;
const MAX_OBJECT_KEYS_SHOWN = 25;
const MAX_ITEM_PREVIEW_CHARS = 360;
const STRING_HEAD_CHARS = 1_200;
const STRING_TAIL_CHARS = 600;

export function resolveResultSpillChars(env: Record<string, string | undefined> = process.env): number {
	const raw = env.ASYNC_AGENT_REPL_SPILL_CHARS?.trim();
	if (!raw) return DEFAULT_RESULT_SPILL_CHARS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_RESULT_SPILL_CHARS;
	return Math.floor(parsed);
}

function compactPreview(value: unknown, maxChars = MAX_ITEM_PREVIEW_CHARS): string {
	const inspected = Bun.inspect(value, { colors: false, depth: 3, breakLength: 100 });
	if (inspected.length <= maxChars) return inspected;
	return `${inspected.slice(0, maxChars)}…`;
}

function valueTag(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return `Array(${value.length})`;
	if (value instanceof Map) return `Map(${value.size})`;
	if (value instanceof Set) return `Set(${value.size})`;
	if (typeof value === "string") return `string(${value.length})`;
	if (typeof value === "object") {
		const ctor = (value as { constructor?: { name?: string } }).constructor?.name;
		return ctor && ctor !== "Object" ? ctor : "object";
	}
	return typeof value;
}

function formatArraySummary(spillName: string, arr: unknown[], approxChars: number): string {
	const total = arr.length;
	const scanCount = Math.min(total, MAX_ARRAY_SCHEMA_SCAN);
	const typeCounts = new Map<string, number>();
	const keyCounts = new Map<string, number>();
	let plainObjectCount = 0;

	for (let i = 0; i < scanCount; i += 1) {
		const item = arr[i];
		const tag =
			item === null
				? "null"
				: Array.isArray(item)
					? "array"
					: typeof item === "object"
						? "object"
						: typeof item;
		typeCounts.set(tag, (typeCounts.get(tag) ?? 0) + 1);
		if (tag === "object") {
			plainObjectCount += 1;
			for (const key of Object.keys(item as Record<string, unknown>)) {
				keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
			}
		}
	}

	const lines: string[] = [
		`[Result spilled to ${spillName}: Array(${total}), ~${approxChars.toLocaleString("en-US")} chars]`,
	];
	const typeSummary = [...typeCounts.entries()].map(([k, v]) => `${k}: ${v}`).join(", ");
	lines.push(`Element types${scanCount < total ? ` (first ${scanCount})` : ""}: ${typeSummary}`);

	if (plainObjectCount > 0 && keyCounts.size > 0) {
		const common: string[] = [];
		const partial: string[] = [];
		for (const [k, count] of [...keyCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
			if (count === plainObjectCount) common.push(k);
			else partial.push(`${k} (${count}/${plainObjectCount})`);
		}
		if (common.length > 0) {
			const shown = common.slice(0, MAX_OBJECT_KEYS_SHOWN);
			const rest = common.length > shown.length ? `, +${common.length - shown.length} more` : "";
			lines.push(`Common keys (${common.length}): ${shown.join(", ")}${rest}`);
		}
		if (partial.length > 0) {
			const shown = partial.slice(0, 15);
			const rest = partial.length > shown.length ? `, +${partial.length - shown.length} more` : "";
			lines.push(`Partial/drift keys (${partial.length}): ${shown.join(", ")}${rest}`);
		}
	}

	if (total > 0) {
		lines.push(`Head [0]: ${compactPreview(arr[0])}`);
		if (total > 1) lines.push(`Head [1]: ${compactPreview(arr[1])}`);
		if (total > 2) lines.push(`Tail [${total - 1}]: ${compactPreview(arr[total - 1])}`);
	}
	lines.push(
		`Inspect or filter full data in JS via ${spillName} (e.g. ${spillName}.length, ${spillName}.slice(0, 5), ${spillName}.filter(...)).`,
	);
	return lines.join("\n");
}

function formatStringSummary(spillName: string, text: string): string {
	let lineCount = 1;
	for (let i = 0; i < text.length; i += 1) {
		if (text.charCodeAt(i) === 10) lineCount += 1;
	}
	const omitted = Math.max(0, text.length - STRING_HEAD_CHARS - STRING_TAIL_CHARS);
	const head = text.slice(0, STRING_HEAD_CHARS);
	const tail = text.slice(Math.max(STRING_HEAD_CHARS, text.length - STRING_TAIL_CHARS));
	return [
		`[Result spilled to ${spillName}: string(${text.length.toLocaleString("en-US")} chars, ${lineCount.toLocaleString("en-US")} lines)]`,
		head,
		omitted > 0 ? `\n[... ${omitted.toLocaleString("en-US")} chars omitted ...]\n` : "",
		tail,
		`\nInspect full string in JS via ${spillName} (e.g. ${spillName}.slice(...), ${spillName}.split("\\n")).`,
	]
		.filter((part) => part.length > 0)
		.join("\n");
}

function formatMapSummary(spillName: string, map: Map<unknown, unknown>, approxChars: number): string {
	const sampleKeys: string[] = [];
	const sampleEntries: string[] = [];
	let i = 0;
	for (const [k, v] of map) {
		if (i < MAX_OBJECT_KEYS_SHOWN) sampleKeys.push(compactPreview(k, 60));
		if (i < 2) sampleEntries.push(`  ${compactPreview(k, 60)} => ${compactPreview(v, 280)}`);
		i += 1;
		if (i >= MAX_OBJECT_KEYS_SHOWN) break;
	}
	const rest = map.size > sampleKeys.length ? `, +${map.size - sampleKeys.length} more` : "";
	return [
		`[Result spilled to ${spillName}: Map(${map.size}), ~${approxChars.toLocaleString("en-US")} chars]`,
		`Keys: ${sampleKeys.join(", ")}${rest}`,
		...(sampleEntries.length > 0 ? ["Sample entries:", ...sampleEntries] : []),
		`Inspect full map in JS via ${spillName} (e.g. ${spillName}.get(key), [...${spillName}.keys()]).`,
	].join("\n");
}

function formatSetSummary(spillName: string, set: Set<unknown>, approxChars: number): string {
	const samples: string[] = [];
	for (const v of set) {
		samples.push(compactPreview(v, 200));
		if (samples.length >= 4) break;
	}
	return [
		`[Result spilled to ${spillName}: Set(${set.size}), ~${approxChars.toLocaleString("en-US")} chars]`,
		`Sample items: ${samples.join(" | ")}`,
		`Inspect full set in JS via ${spillName} (e.g. [...${spillName}].filter(...)).`,
	].join("\n");
}

function formatObjectSummary(spillName: string, obj: Record<string, unknown>, approxChars: number): string {
	const ctor = (obj as { constructor?: { name?: string } }).constructor?.name || "Object";
	const keys = Object.keys(obj);
	const shownKeys = keys.slice(0, MAX_OBJECT_KEYS_SHOWN).map((k) => `${k}: ${valueTag(obj[k])}`);
	const rest = keys.length > shownKeys.length ? `, +${keys.length - shownKeys.length} more` : "";
	return [
		`[Result spilled to ${spillName}: ${ctor}(${keys.length} keys), ~${approxChars.toLocaleString("en-US")} chars]`,
		`Keys: ${shownKeys.join(", ")}${rest}`,
		`Preview: ${compactPreview(obj, 1_000)}`,
		`Inspect full object in JS via ${spillName} (e.g. Object.keys(${spillName}), ${spillName}[key]).`,
	].join("\n");
}

export function formatSpilledResultSummary(spillName: string, value: unknown, approxChars: number): string {
	if (Array.isArray(value)) return formatArraySummary(spillName, value, approxChars);
	if (typeof value === "string") return formatStringSummary(spillName, value);
	if (value instanceof Map) return formatMapSummary(spillName, value, approxChars);
	if (value instanceof Set) return formatSetSummary(spillName, value, approxChars);
	if (typeof value === "object" && value !== null) {
		return formatObjectSummary(spillName, value as Record<string, unknown>, approxChars);
	}
	return [
		`[Result spilled to ${spillName}: ${valueTag(value)}, ~${approxChars.toLocaleString("en-US")} chars]`,
		compactPreview(value, 1_200),
		`Inspect full value in JS via ${spillName}.`,
	].join("\n");
}
