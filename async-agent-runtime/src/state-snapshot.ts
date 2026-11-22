import { join } from "node:path";

export const DEFAULT_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;
export const DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES = 16 * 1024 * 1024;

const KERNEL_STATE_BASENAME = "kernel-state";
export const SNAPSHOT_FORMAT_VERSION = 3;
const LEGACY_SNAPSHOT_FORMAT_VERSION = 2;
const HEADER_LENGTH_BYTES = 4;
const MAX_HEADER_BYTES = 16 * 1024 * 1024;

export interface SnapshotResult {
	saved: string[];
	skipped: { name: string; reason: string }[];
	pruned: string[];
	bytes: number;
	path: string;
}

export interface RestoreResult {
	restored: string[];
	failed: { name: string; reason: string }[];
	path: string;
}

export interface SnapshotPayloadEntry {
	name: string;
	data: Uint8Array;
	kind?: SnapshotPayloadKind;
}

export interface SnapshotPayloadParts {
	parts: Uint8Array[];
	byteLength: number;
}

export type SnapshotPayloadKind = "function" | "import" | "module" | "runtime";

interface SnapshotHeaderEntry {
	name: string;
	offset: number;
	length: number;
	kind?: SnapshotPayloadKind;
}

interface SnapshotHeader {
	version: typeof LEGACY_SNAPSHOT_FORMAT_VERSION | typeof SNAPSHOT_FORMAT_VERSION;
	entries: SnapshotHeaderEntry[];
}

export function snapshotPathIn(artifactDir: string): string {
	return join(artifactDir, `${KERNEL_STATE_BASENAME}.bin`);
}

export function manifestPathIn(artifactDir: string): string {
	return join(artifactDir, `${KERNEL_STATE_BASENAME}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function corruptSnapshot(reason: string): Error {
	return new Error(`Corrupt Bun snapshot: ${reason}`);
}

function parseHeader(value: unknown): SnapshotHeader {
	if (
		!isRecord(value) ||
		(value.version !== LEGACY_SNAPSHOT_FORMAT_VERSION && value.version !== SNAPSHOT_FORMAT_VERSION) ||
		!Array.isArray(value.entries)
	) {
		throw corruptSnapshot("invalid header");
	}
	const rawEntries = value.entries;
	const entries = new Array<SnapshotHeaderEntry>(rawEntries.length);
	for (let i = 0; i < rawEntries.length; i += 1) {
		const entry = rawEntries[i];
		if (!isRecord(entry)) throw corruptSnapshot("invalid entry metadata");
		const kind = entry.kind;
		if (
			typeof entry.name !== "string" ||
			!Number.isSafeInteger(entry.offset) ||
			!Number.isSafeInteger(entry.length) ||
			(entry.offset as number) < 0 ||
			(entry.length as number) < 0 ||
			(kind !== undefined && kind !== "function" && kind !== "import" && kind !== "module" && kind !== "runtime")
		) {
			throw corruptSnapshot("invalid entry metadata");
		}
		entries[i] = kind
			? { name: entry.name, offset: entry.offset as number, length: entry.length as number, kind }
			: { name: entry.name, offset: entry.offset as number, length: entry.length as number };
	}
	return { version: value.version, entries };
}

export function encodeSnapshotPayloadParts(entries: readonly SnapshotPayloadEntry[]): SnapshotPayloadParts {
	let offset = 0;
	const count = entries.length;
	const headerEntries = new Array<SnapshotHeaderEntry>(count);
	const parts = new Array<Uint8Array>(count + 2);
	for (let i = 0; i < count; i += 1) {
		const entry = entries[i]!;
		const byteLen = entry.data.byteLength;
		headerEntries[i] = entry.kind
			? { name: entry.name, offset, length: byteLen, kind: entry.kind }
			: { name: entry.name, offset, length: byteLen };
		offset += byteLen;
		parts[i + 2] = entry.data;
	}
	const header = Buffer.from(
		JSON.stringify({ version: SNAPSHOT_FORMAT_VERSION, entries: headerEntries } satisfies SnapshotHeader),
		"utf8",
	);
	if (header.byteLength > MAX_HEADER_BYTES) throw new Error("Bun snapshot header exceeds the 16 MiB limit");
	const prefix = Buffer.allocUnsafe(HEADER_LENGTH_BYTES);
	prefix.writeUInt32BE(header.byteLength, 0);
	parts[0] = prefix;
	parts[1] = header;
	return {
		byteLength: HEADER_LENGTH_BYTES + header.byteLength + offset,
		parts,
	};
}

export function encodeSnapshotPayload(entries: readonly SnapshotPayloadEntry[]): Buffer {
	const encoded = encodeSnapshotPayloadParts(entries);
	return Buffer.concat(encoded.parts, encoded.byteLength);
}

export function decodeSnapshotPayload(
	payload: Uint8Array,
	limits?: { maxBytes?: number; maxVariableBytes?: number },
): SnapshotPayloadEntry[] {
	const buffer = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
	const maxBytes = limits?.maxBytes;
	const maxVariableBytes = limits?.maxVariableBytes;
	if (maxBytes !== undefined && buffer.byteLength > maxBytes) {
		throw new Error("snapshot payload exceeds the aggregate byte cap");
	}
	if (buffer.byteLength < HEADER_LENGTH_BYTES) throw corruptSnapshot("missing header length");
	const headerLength = buffer.readUInt32BE(0);
	if (headerLength > MAX_HEADER_BYTES || HEADER_LENGTH_BYTES + headerLength > buffer.byteLength) {
		throw corruptSnapshot("header length is out of range");
	}

	let rawHeader: unknown;
	try {
		rawHeader = JSON.parse(buffer.subarray(HEADER_LENGTH_BYTES, HEADER_LENGTH_BYTES + headerLength).toString("utf8"));
	} catch (error) {
		throw corruptSnapshot(`header JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
	}
	const header = parseHeader(rawHeader);
	const dataStart = HEADER_LENGTH_BYTES + headerLength;
	const dataLength = buffer.byteLength - dataStart;
	const entryCount = header.entries.length;
	const names = new Set<string>();
	const rangeStarts = new Float64Array(entryCount);
	const rangeEnds = new Float64Array(entryCount);
	const result = new Array<SnapshotPayloadEntry>(entryCount);
	let maxEnd = 0;
	let totalEntryBytes = 0;

	for (let i = 0; i < entryCount; i += 1) {
		const entry = header.entries[i]!;
		if (names.has(entry.name)) throw new Error(`Duplicate snapshot binding: ${entry.name}`);
		names.add(entry.name);
		if (maxVariableBytes !== undefined && entry.kind !== "runtime" && entry.length > maxVariableBytes) {
			throw new Error("snapshot record exceeds the per-variable byte cap");
		}
		totalEntryBytes += entry.length;
		if (maxBytes !== undefined && totalEntryBytes > maxBytes) {
			throw new Error("snapshot payload exceeds the aggregate byte cap");
		}
		const end = entry.offset + entry.length;
		if (!Number.isSafeInteger(end) || end > dataLength) throw corruptSnapshot(`entry ${entry.name} is out of range`);
		if (entry.offset < maxEnd) {
			for (let r = 0; r < i; r += 1) {
				if (entry.offset < rangeEnds[r]! && end > rangeStarts[r]!) {
					throw corruptSnapshot(`entry ${entry.name} overlaps another entry`);
				}
			}
		}
		if (end > maxEnd) maxEnd = end;
		rangeStarts[i] = entry.offset;
		rangeEnds[i] = end;
		const data = new Uint8Array(buffer.subarray(dataStart + entry.offset, dataStart + end));
		result[i] = entry.kind ? { name: entry.name, data, kind: entry.kind } : { name: entry.name, data };
	}
	return result;
}

const float16ArrayConstructor = (globalThis as { Float16Array?: { prototype: object } }).Float16Array;

const TYPED_ARRAY_PROTOTYPES = new Set<object>([
	Int8Array.prototype,
	Uint8Array.prototype,
	Uint8ClampedArray.prototype,
	Int16Array.prototype,
	Uint16Array.prototype,
	Int32Array.prototype,
	Uint32Array.prototype,
	Float32Array.prototype,
	Float64Array.prototype,
	BigInt64Array.prototype,
	BigUint64Array.prototype,
	...(float16ArrayConstructor ? [float16ArrayConstructor.prototype] : []),
]);

const EMPTY_PROTO_PROBE: unknown[] = [];

function hasOwnEnumerableKey(object: object, cleanProto: boolean): boolean {
	for (const key in object) {
		if (cleanProto || Object.hasOwn(object, key)) return true;
	}
	return false;
}

function isSnapshotSafePrimitive(value: unknown): boolean {
	if (value === null) return true;
	const valueType = typeof value;
	return (
		valueType === "undefined" ||
		valueType === "string" ||
		valueType === "number" ||
		valueType === "boolean" ||
		valueType === "bigint"
	);
}

function isUnsignedIntegerString(value: string): boolean {
	const len = value.length;
	if (len === 0) return false;
	const first = value.charCodeAt(0);
	if (first === 48) return len === 1;
	if (first < 49 || first > 57) return false;
	for (let index = 1; index < len; index += 1) {
		const code = value.charCodeAt(index);
		if (code < 48 || code > 57) return false;
	}
	return true;
}

function inspectSnapshotValue(value: unknown, seen: WeakSet<object>, cleanProto: boolean): string | undefined {
	if (isSnapshotSafePrimitive(value)) return undefined;
	const valueType = typeof value;
	if (valueType === "symbol") return ": symbol values are not snapshot-safe";
	if (valueType === "function") return ": function values are not snapshot-safe";
	if (valueType !== "object") return `: unsupported value type ${valueType}`;

	const object = value as object;
	if (seen.has(object)) return undefined;
	seen.add(object);

	try {
		if (Object.getOwnPropertySymbols(object).length > 0) {
			return ": symbol-keyed state is not snapshot-safe";
		}

		const prototype = Object.getPrototypeOf(object);

		// Fast path: plain objects (covers the vast majority of heap nodes without
		// running 11 instanceof checks or allocating Object.entries tuples).
		if (prototype === Object.prototype || prototype === null) {
			const record = object as Record<string, unknown>;
			for (const key in record) {
				if (!cleanProto && !Object.hasOwn(record, key)) continue;
				const entryValue = record[key];
				if (isSnapshotSafePrimitive(entryValue)) continue;
				const reason = inspectSnapshotValue(entryValue, seen, cleanProto);
				if (reason !== undefined) return `.${key}${reason}`;
			}
			return undefined;
		}

		if (prototype === Array.prototype && Array.isArray(object)) {
			const array = object as unknown as Record<string, unknown>;
			for (const key in array) {
				if (!cleanProto && !Object.hasOwn(array, key)) continue;
				if (!isUnsignedIntegerString(key)) return ": custom array properties are not snapshot-safe";
				const entryValue = array[key];
				if (isSnapshotSafePrimitive(entryValue)) continue;
				const reason = inspectSnapshotValue(entryValue, seen, cleanProto);
				if (reason !== undefined) return `[${key}]${reason}`;
			}
			return undefined;
		}

		if (prototype === Map.prototype && object instanceof Map) {
			if (hasOwnEnumerableKey(object, cleanProto)) return ": custom Map properties are not snapshot-safe";
			let index = 0;
			for (const [key, entryValue] of object) {
				if (!isSnapshotSafePrimitive(key)) {
					const keyReason = inspectSnapshotValue(key, seen, cleanProto);
					if (keyReason !== undefined) return `.mapKey${index}${keyReason}`;
				}
				if (!isSnapshotSafePrimitive(entryValue)) {
					const valueReason = inspectSnapshotValue(entryValue, seen, cleanProto);
					if (valueReason !== undefined) return `.mapValue${index}${valueReason}`;
				}
				index += 1;
			}
			return undefined;
		}

		if (prototype === Set.prototype && object instanceof Set) {
			if (hasOwnEnumerableKey(object, cleanProto)) return ": custom Set properties are not snapshot-safe";
			let index = 0;
			for (const entryValue of object) {
				if (!isSnapshotSafePrimitive(entryValue)) {
					const reason = inspectSnapshotValue(entryValue, seen, cleanProto);
					if (reason !== undefined) return `.setValue${index}${reason}`;
				}
				index += 1;
			}
			return undefined;
		}

		if (ArrayBuffer.isView(object)) {
			if (object instanceof DataView || !TYPED_ARRAY_PROTOTYPES.has(prototype)) {
				return ": custom prototype or unsupported view is not snapshot-safe";
			}
			return undefined;
		}

		if (prototype === Date.prototype && object instanceof Date) {
			return hasOwnEnumerableKey(object, cleanProto) ? ": custom Date properties are not snapshot-safe" : undefined;
		}
		if (prototype === RegExp.prototype && object instanceof RegExp) {
			return hasOwnEnumerableKey(object, cleanProto) ? ": custom RegExp properties are not snapshot-safe" : undefined;
		}
		if (prototype === ArrayBuffer.prototype && object instanceof ArrayBuffer) {
			return hasOwnEnumerableKey(object, cleanProto)
				? ": custom ArrayBuffer properties are not snapshot-safe"
				: undefined;
		}

		if (object instanceof Promise) return ": promises are not snapshot-safe";
		if (object instanceof WeakMap || object instanceof WeakSet) {
			return ": weak collections are not snapshot-safe";
		}
		if (typeof WeakRef !== "undefined" && object instanceof WeakRef) {
			return ": weak references are not snapshot-safe";
		}
		return ": custom prototype is not snapshot-safe";
	} catch (error) {
		return `: inspection failed: ${error instanceof Error ? error.message : String(error)}`;
	}
}

export function snapshotValueSkipReason(value: unknown): string | undefined {
	let cleanProto = true;
	for (const _ in EMPTY_PROTO_PROBE) {
		cleanProto = false;
		break;
	}
	const reason = inspectSnapshotValue(value, new WeakSet(), cleanProto);
	return reason !== undefined ? `$binding${reason}` : undefined;
}
