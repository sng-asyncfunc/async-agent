const CJK_TERM_CHAR_RE =
	/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\u{20000}-\u{2a6df}\u{2a700}-\u{2b73f}\u{2b740}-\u{2b81f}\u{2b820}-\u{2ceaf}\u{2ceb0}-\u{2ebef}\u{2ebf0}-\u{2ee5f}\u{2f800}-\u{2fa1f}\u{30000}-\u{3134f}\u{31350}-\u{323af}\u{323b0}-\u{3347f}]/u;

const WORD_CHAR_RE = /[\p{L}\p{N}\p{M}]/u;

function isAscii(text: string): boolean {
	for (let i = 0; i < text.length; i += 1) {
		if (text.charCodeAt(i) > 127) return false;
	}
	return true;
}

function harnessQueryRuns(text: string): string[] {
	const runs: string[] = [];
	if (isAscii(text)) {
		let start = -1;
		for (let i = 0; i < text.length; i += 1) {
			const c = text.charCodeAt(i);
			const isWord = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || (c >= 65 && c <= 90);
			if (isWord) {
				if (start < 0) start = i;
			} else if (start >= 0) {
				runs.push(text.slice(start, i));
				start = -1;
			}
		}
		if (start >= 0) runs.push(text.slice(start));
		return runs;
	}
	let run: string[] = [];
	let runIsCjk = false;
	for (const ch of text) {
		if (WORD_CHAR_RE.test(ch)) {
			const chIsCjk = CJK_TERM_CHAR_RE.test(ch);
			if (run.length > 0 && chIsCjk !== runIsCjk) {
				runs.push(run.join(""));
				run = [];
			}
			runIsCjk = chIsCjk;
			run.push(ch);
		} else if (run.length > 0) {
			runs.push(run.join(""));
			run = [];
		}
	}
	if (run.length > 0) runs.push(run.join(""));
	return runs;
}

export function harnessQueryTerms(query: string): string[] {
	const terms: string[] = [];
	const seen = new Set<string>();
	for (const run of harnessQueryRuns(query.toLowerCase())) {
		if (isAscii(run)) {
			if (run.length >= 3 && !seen.has(run)) {
				seen.add(run);
				terms.push(run);
			}
			continue;
		}
		let candidates: string[];
		if (CJK_TERM_CHAR_RE.test(run)) {
			const chars = [...run];
			if (chars.length > 1) {
				candidates = [];
				for (let i = 0; i < chars.length - 1; i += 1) {
					candidates.push(`${chars[i]}${chars[i + 1]}`);
				}
			} else {
				candidates = [run];
			}
		} else {
			candidates = [...run].length >= 2 ? [run] : [];
		}
		for (const term of candidates) {
			if (!seen.has(term)) {
				seen.add(term);
				terms.push(term);
			}
		}
	}
	return terms;
}

function compareRecencyDesc(aRec: string, bRec: string): number {
	return aRec < bRec ? 1 : aRec > bRec ? -1 : 0;
}

function isBetterHit(
	score: number,
	recency: string,
	index: number,
	otherScore: number,
	otherRecency: string,
	otherIndex: number,
): boolean {
	if (score !== otherScore) return score > otherScore;
	if (recency !== otherRecency) return recency > otherRecency;
	return index < otherIndex;
}

export function rankHarnessIndices(
	query: string,
	titles: string[],
	contents: string[],
	pathAndIds: string[],
	updatedAts: string[],
	limit: number,
	alreadyLowercased = false,
): number[] {
	const terms = harnessQueryTerms(query);
	const termCount = terms.length;
	const count = titles.length;
	if (termCount === 0 || count === 0 || limit <= 0) return [];

	const df = new Int32Array(termCount);

	if (termCount <= 15) {
		// Pack 2-bit field counts (0..3) per term into a single Int32 per entry.
		const masks = new Int32Array(count);
		let anyHit = false;
		for (let i = 0; i < count; i += 1) {
			const title = alreadyLowercased ? titles[i]! : titles[i]!.toLowerCase();
			const content = alreadyLowercased ? contents[i]! : contents[i]!.toLowerCase();
			const pathAndId = alreadyLowercased ? pathAndIds[i]! : pathAndIds[i]!.toLowerCase();
			let mask = 0;
			for (let t = 0; t < termCount; t += 1) {
				const term = terms[t]!;
				const fields =
					(title.includes(term) ? 1 : 0) +
					(content.includes(term) ? 1 : 0) +
					(pathAndId.includes(term) ? 1 : 0);
				if (fields > 0) {
					df[t] += 1;
					mask |= fields << (t * 2);
				}
			}
			if (mask !== 0) {
				masks[i] = mask;
				anyHit = true;
			}
		}
		if (!anyHit) return [];

		const idf = new Float64Array(termCount);
		for (let t = 0; t < termCount; t += 1) {
			const docFreq = df[t]!;
			if (docFreq > 0) {
				idf[t] = Math.log(1 + count / docFreq);
			}
		}

		// Maintain a small sorted top-K buffer when limit is modest, avoiding
		// allocating and sorting objects for all matching entries.
		if (limit <= 64) {
			const topIdx = new Int32Array(limit);
			const topScore = new Float64Array(limit);
			const topRec = new Array<string>(limit);
			let topLen = 0;

			for (let i = 0; i < count; i += 1) {
				let mask = masks[i]!;
				if (mask === 0) continue;
				let total = 0;
				let t = 0;
				while (mask !== 0) {
					const fields = mask & 3;
					if (fields !== 0) {
						total += idf[t]! * (1 + (fields - 1) * 0.5);
					}
					mask >>>= 2;
					t += 1;
				}
				if (total <= 0) continue;
				const recency = updatedAts[i] || "";
				if (
					topLen === limit &&
					!isBetterHit(total, recency, i, topScore[topLen - 1]!, topRec[topLen - 1]!, topIdx[topLen - 1]!)
				) {
					continue;
				}
				let pos = topLen < limit ? topLen : limit - 1;
				if (topLen < limit) topLen += 1;
				while (pos > 0 && isBetterHit(total, recency, i, topScore[pos - 1]!, topRec[pos - 1]!, topIdx[pos - 1]!)) {
					topIdx[pos] = topIdx[pos - 1]!;
					topScore[pos] = topScore[pos - 1]!;
					topRec[pos] = topRec[pos - 1]!;
					pos -= 1;
				}
				topIdx[pos] = i;
				topScore[pos] = total;
				topRec[pos] = recency;
			}

			const out = new Array<number>(topLen);
			for (let i = 0; i < topLen; i += 1) out[i] = topIdx[i]!;
			return out;
		}

		const scored: Array<{ index: number; score: number; recency: string }> = [];
		for (let i = 0; i < count; i += 1) {
			let mask = masks[i]!;
			if (mask === 0) continue;
			let total = 0;
			let t = 0;
			while (mask !== 0) {
				const fields = mask & 3;
				if (fields !== 0) {
					total += idf[t]! * (1 + (fields - 1) * 0.5);
				}
				mask >>>= 2;
				t += 1;
			}
			if (total > 0) {
				scored.push({ index: i, score: total, recency: updatedAts[i] || "" });
			}
		}
		scored.sort((a, b) => b.score - a.score || compareRecencyDesc(a.recency, b.recency) || a.index - b.index);
		const outLen = Math.min(limit, scored.length);
		const out = new Array<number>(outLen);
		for (let i = 0; i < outLen; i += 1) out[i] = scored[i]!.index;
		return out;
	}

	const hitEntries: number[] = [];
	const hitTerms: number[] = [];
	const hitFields: number[] = [];

	for (let i = 0; i < count; i += 1) {
		const title = alreadyLowercased ? titles[i]! : titles[i]!.toLowerCase();
		const content = alreadyLowercased ? contents[i]! : contents[i]!.toLowerCase();
		const pathAndId = alreadyLowercased ? pathAndIds[i]! : pathAndIds[i]!.toLowerCase();
		for (let t = 0; t < termCount; t += 1) {
			const term = terms[t]!;
			const fields =
				(title.includes(term) ? 1 : 0) +
				(content.includes(term) ? 1 : 0) +
				(pathAndId.includes(term) ? 1 : 0);
			if (fields > 0) {
				df[t] += 1;
				hitEntries.push(i);
				hitTerms.push(t);
				hitFields.push(fields);
			}
		}
	}

	if (hitEntries.length === 0) return [];

	const idf = new Float64Array(termCount);
	for (let t = 0; t < termCount; t += 1) {
		const docFreq = df[t]!;
		if (docFreq > 0) {
			idf[t] = Math.log(1 + count / docFreq);
		}
	}

	const scored: Array<{ index: number; score: number; recency: string }> = [];
	let pos = 0;
	const totalHits = hitEntries.length;
	while (pos < totalHits) {
		const entryIndex = hitEntries[pos]!;
		let total = 0;
		while (pos < totalHits && hitEntries[pos] === entryIndex) {
			const termIdf = idf[hitTerms[pos]!]!;
			const fields = hitFields[pos]!;
			total += termIdf * (1 + (fields - 1) * 0.5);
			pos += 1;
		}
		if (total > 0) {
			scored.push({ index: entryIndex, score: total, recency: updatedAts[entryIndex] || "" });
		}
	}

	scored.sort((a, b) => b.score - a.score || compareRecencyDesc(a.recency, b.recency) || a.index - b.index);
	const outLen = Math.min(limit, scored.length);
	const out = new Array<number>(outLen);
	for (let i = 0; i < outLen; i += 1) out[i] = scored[i]!.index;
	return out;
}
