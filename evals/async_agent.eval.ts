import { Eval } from "braintrust";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractJsonBlock,
  getGitSha,
  runAsyncAgent,
  type AgentRunResult,
  type EvalWorkspace,
} from "./harness.ts";

interface EvalCaseInput {
  id: string;
  category: string;
  prompt: string;
  isSwarm?: boolean;
  turnBudget: number;
  toolCharsBudget: number;
}

interface EvalCaseExpected {
  kind: "json_exact" | "workspace_tests" | "swarm_reconcile";
  expectedJson?: Record<string, unknown>;
  minChildSessions?: number;
}

const WORKSPACE_SETUPS: Record<string, (ws: EvalWorkspace) => void> = {
  oversized_spill_triage: ({ cwd }) => {
    const records = Array.from({ length: 120 }, (_, i) => {
      const id = `VND-${String(i + 1).padStart(3, "0")}`;
      const base: Record<string, unknown> = {
        vendor_id: id,
        name: `Vendor Corp ${i + 1}`,
        status: "verified",
        tier: i % 3 === 0 ? "enterprise" : "standard",
        compliance: {
          soc2: "pass",
          audit_notes: `Routine quarterly check completed cleanly for ${id}. `.repeat(4),
          security_findings: [],
        },
        billing_region: i % 2 === 0 ? "us-east" : "eu-west",
      };
      if (id === "VND-023") {
        (base.compliance as Record<string, unknown>).audit_notes =
          "CRITICAL: SOC2 certificate revoked on 2026-11-10; DO NOT APPROVE for production.";
      }
      if (id === "VND-087") {
        (base.compliance as Record<string, unknown>).security_findings = [
          { severity: "critical", cve: "CVE-2026-99104", patched: false },
        ];
      }
      if (id === "VND-045" || id === "VND-102") {
        base.legacy_schema_v1 = true;
        delete base.billing_region;
      }
      return base;
    });
    writeFileSync(join(cwd, "vendors.json"), JSON.stringify(records, null, 2));
  },

  atomic_multi_file_edit: ({ cwd }) => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    mkdirSync(join(cwd, "test"), { recursive: true });
    writeFileSync(
      join(cwd, "src", "money.ts"),
      [
        "export function roundCents(amount: number): number {",
        "  // BUG: truncates instead of rounding half-up to nearest cent",
        "  return Math.floor(amount * 100) / 100;",
        "}",
        "",
        "export function applyDiscount(subtotal: number, discountPct: number): number {",
        "  return roundCents(subtotal * (1 - discountPct / 100));",
        "}",
      ].join("\n"),
    );
    writeFileSync(
      join(cwd, "src", "tax.ts"),
      [
        "import { roundCents } from './money.ts';",
        "",
        "export function computeTax(netAmount: number, ratePct: number): number {",
        "  // BUG: divides by 1000 instead of 100",
        "  return roundCents(netAmount * (ratePct / 1000));",
        "}",
      ].join("\n"),
    );
    writeFileSync(
      join(cwd, "src", "invoice.ts"),
      [
        "import { applyDiscount, roundCents } from './money.ts';",
        "import { computeTax } from './tax.ts';",
        "",
        "export interface LineItem { unitPrice: number; qty: number; }",
        "",
        "export function calculateInvoice(items: LineItem[], discountPct: number, taxPct: number) {",
        "  const subtotal = roundCents(items.reduce((sum, it) => sum + it.unitPrice * it.qty, 0));",
        "  const discounted = applyDiscount(subtotal, discountPct);",
        "  const tax = computeTax(discounted, taxPct);",
        "  // BUG: subtracts tax instead of adding tax",
        "  const total = roundCents(discounted - tax);",
        "  return { subtotal, discounted, tax, total };",
        "}",
      ].join("\n"),
    );
    writeFileSync(
      join(cwd, "test", "invoice.test.ts"),
      [
        "import { describe, expect, test } from 'bun:test';",
        "import { calculateInvoice } from '../src/invoice.ts';",
        "import { roundCents } from '../src/money.ts';",
        "",
        "describe('invoice calculation', () => {",
        "  test('roundCents rounds half-up cleanly', () => {",
        "    expect(roundCents(1.005)).toBe(1.01);",
        "    expect(roundCents(2.344)).toBe(2.34);",
        "    expect(roundCents(19.999)).toBe(20);",
        "  });",
        "",
        "  test('applies discount then adds tax', () => {",
        "    const res = calculateInvoice(",
        "      [{ unitPrice: 49.99, qty: 2 }, { unitPrice: 10.02, qty: 1 }],",
        "      10,",
        "      8.25,",
        "    );",
        "    expect(res.subtotal).toBe(110);",
        "    expect(res.discounted).toBe(99);",
        "    expect(res.tax).toBe(8.17);",
        "    expect(res.total).toBe(107.17);",
        "  });",
        "});",
      ].join("\n"),
    );
  },

  local_module_import_triage: ({ cwd }) => {
    mkdirSync(join(cwd, "lib"), { recursive: true });
    writeFileSync(
      join(cwd, "lib", "log_parser.mjs"),
      [
        "export function parseLogLine(line) {",
        "  const m = line.match(/^(\\S+)\\s+level=(\\w+)\\s+service=(\\S+)\\s+ms=(\\d+)\\s+code=(\\d+)$/);",
        "  if (!m) return null;",
        "  return { ts: m[1], level: m[2], service: m[3], ms: Number(m[4]), code: Number(m[5]) };",
        "}",
      ].join("\n"),
    );
    const lines: string[] = [];
    for (let i = 0; i < 600; i++) {
      const svc = i % 3 === 0 ? "gateway" : i % 3 === 1 ? "billing" : "search";
      const isErr = (svc === "billing" && i % 20 === 1) || (svc === "gateway" && i === 300);
      const code = isErr ? 503 : 200;
      const ms = isErr ? 1420 : 25 + (i % 40);
      lines.push(`2026-11-25T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z level=${isErr ? "ERROR" : "INFO"} service=${svc} ms=${ms} code=${code}`);
    }
    writeFileSync(join(cwd, "service.log"), lines.join("\n"));
  },

  buggy_loop_debug: ({ cwd }) => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    mkdirSync(join(cwd, "test"), { recursive: true });
    writeFileSync(
      join(cwd, "src", "paginate.ts"),
      [
        "export interface PageResult<T> { items: T[]; nextCursor: number | null; }",
        "",
        "export function collectAllPages<T>(fetchPage: (cursor: number) => PageResult<T>): T[] {",
        "  const out: T[] = [];",
        "  let cursor: number | null = 0;",
        "  while (cursor !== null) {",
        "    const page = fetchPage(cursor);",
        "    out.push(...page.items);",
        "    // BUG: forgets to advance cursor when nextCursor equals cursor or stays 0, and doesn't guard repeated cursors",
        "    if (page.nextCursor === null) break;",
        "    cursor = page.nextCursor > 0 ? cursor : null;",
        "  }",
        "  return out;",
        "}",
      ].join("\n"),
    );
    writeFileSync(
      join(cwd, "test", "paginate.test.ts"),
      [
        "import { describe, expect, test } from 'bun:test';",
        "import { collectAllPages } from '../src/paginate.ts';",
        "",
        "describe('collectAllPages', () => {",
        "  test('collects across multiple cursors', () => {",
        "    const pages: Record<number, { items: string[]; nextCursor: number | null }> = {",
        "      0: { items: ['a', 'b'], nextCursor: 2 },",
        "      2: { items: ['c', 'd'], nextCursor: 4 },",
        "      4: { items: ['e'], nextCursor: null },",
        "    };",
        "    expect(collectAllPages((c) => pages[c])).toEqual(['a', 'b', 'c', 'd', 'e']);",
        "  });",
        "",
        "  test('throws on cyclic cursor instead of looping forever', () => {",
        "    expect(() =>",
        "      collectAllPages((c) => ({ items: [c], nextCursor: c === 0 ? 1 : 0 })),",
        "    ).toThrow(/cycle|repeat|duplicate/i);",
        "  });",
        "});",
      ].join("\n"),
    );
  },

  swarm_parallel_reconcile: ({ cwd }) => {
    const shards = [
      { file: "shard_a.json", start: 1, end: 40 },
      { file: "shard_b.json", start: 41, end: 80 },
      { file: "shard_c.json", start: 81, end: 120 },
    ];
    for (const s of shards) {
      const rows = [];
      for (let id = s.start; id <= s.end; id++) {
        const acct = `ACCT-${String(id).padStart(3, "0")}`;
        const balance = id * 100;
        const reported = acct === "ACCT-017" ? balance - 250 : acct === "ACCT-064" ? balance + 500 : acct === "ACCT-109" ? balance - 75 : balance;
        rows.push({
          account_id: acct,
          shard: s.file,
          expected_balance: balance,
          reported_balance: reported,
          notes: `Ledger snapshot entry for ${acct} verified on 2026-11-25. `.repeat(5),
        });
      }
      writeFileSync(join(cwd, s.file), JSON.stringify(rows, null, 2));
    }
  },
};

const WORKSPACE_VERIFIERS: Record<string, (ws: EvalWorkspace) => { passed: boolean; details: string }> = {
  atomic_multi_file_edit: ({ cwd }) => {
    const res = Bun.spawnSync(["bun", "test"], { cwd, stdout: "pipe", stderr: "pipe" });
    const out = `${res.stdout.toString()}\n${res.stderr.toString()}`.trim();
    return {
      passed: res.exitCode === 0,
      details: res.exitCode === 0 ? "bun test passed" : `bun test failed (${res.exitCode}): ${out.slice(-400)}`,
    };
  },
  buggy_loop_debug: ({ cwd }) => {
    const res = Bun.spawnSync(["bun", "test", "--timeout", "3000"], { cwd, stdout: "pipe", stderr: "pipe" });
    const out = `${res.stdout.toString()}\n${res.stderr.toString()}`.trim();
    return {
      passed: res.exitCode === 0,
      details: res.exitCode === 0 ? "bun test passed" : `bun test failed (${res.exitCode}): ${out.slice(-400)}`,
    };
  },
};

const DATA: Array<{ input: EvalCaseInput; expected: EvalCaseExpected; metadata: Record<string, unknown> }> = [
  {
    input: {
      id: "repl_state_and_closures",
      category: "repl_core",
      turnBudget: 3,
      toolCharsBudget: 4000,
      prompt: [
        "Using your JavaScript REPL, compute the following programmatically (do not do mental arithmetic):",
        "1. Define a closure counter `let acc = 10; function step(n) { acc += n * n; return acc; }` and run `step(3)`, `step(5)`, `step(7)`.",
        "2. Also test using a variable literally named `prompt = 'ok'` and an object literal `{ prompt, finalAcc: acc }`.",
        "3. Compute the sum of all prime numbers strictly below 1000.",
        "",
        "Return ONLY a single ```json block with exact keys:",
        '{ "finalAcc": <number>, "promptVar": <string>, "primeSumUnder1000": <number> }',
      ].join("\n"),
    },
    expected: {
      kind: "json_exact",
      expectedJson: { finalAcc: 93, promptVar: "ok", primeSumUnder1000: 76127 },
    },
    metadata: { suite: "core" },
  },
  {
    input: {
      id: "oversized_spill_triage",
      category: "context_hygiene",
      turnBudget: 4,
      toolCharsBudget: 6000,
      prompt: [
        "Inspect `./vendors.json` (120 vendor records) using JavaScript in your REPL without dumping the full file into context.",
        "Identify:",
        "1. `hidden_blockers`: sorted list of `vendor_id`s that have `status === 'verified'` yet contain a critical revocation, do-not-approve notice, or unpatched critical CVE.",
        "2. `schema_drift`: sorted list of `vendor_id`s missing `billing_region` or marked `legacy_schema_v1`.",
        "3. `clean_count`: number of vendors with neither a hidden blocker nor schema drift.",
        "",
        "Return ONLY a single ```json block with exact keys:",
        '{ "hidden_blockers": ["..."], "schema_drift": ["..."], "clean_count": <number> }',
      ].join("\n"),
    },
    expected: {
      kind: "json_exact",
      expectedJson: {
        hidden_blockers: ["VND-023", "VND-087"],
        schema_drift: ["VND-045", "VND-102"],
        clean_count: 116,
      },
    },
    metadata: { suite: "context_hygiene" },
  },
  {
    input: {
      id: "atomic_multi_file_edit",
      category: "coding_edit",
      turnBudget: 5,
      toolCharsBudget: 12000,
      prompt: [
        "This workspace has a small TypeScript invoice calculator under `src/` and tests under `test/invoice.test.ts`.",
        "Diagnose all bugs across `src/money.ts`, `src/tax.ts`, and `src/invoice.ts`, fix them cleanly (do NOT modify `test/invoice.test.ts`), and verify `bun test` passes.",
        "Then summarize what you fixed in 2 short sentences.",
      ].join("\n"),
    },
    expected: { kind: "workspace_tests" },
    metadata: { suite: "coding" },
  },
  {
    input: {
      id: "local_module_import_triage",
      category: "repl_modules",
      turnBudget: 4,
      toolCharsBudget: 6000,
      prompt: [
        "Import `parseLogLine` from `./lib/log_parser.mjs` inside your JavaScript REPL and analyze `./service.log`.",
        "Compute exact totals across all parsed lines:",
        "- `total_lines`: total parsed lines",
        "- `error_count`: count of lines with `code === 503`",
        "- `errors_by_service`: object mapping each service that had at least one 503 error to its exact 503 count",
        "",
        "Return ONLY a single ```json block with exact keys:",
        '{ "total_lines": <number>, "error_count": <number>, "errors_by_service": { "<svc>": <count> } }',
      ].join("\n"),
    },
    expected: {
      kind: "json_exact",
      expectedJson: {
        total_lines: 600,
        error_count: 11,
        errors_by_service: { billing: 10, gateway: 1 },
      },
    },
    metadata: { suite: "repl_modules" },
  },
  {
    input: {
      id: "buggy_loop_debug",
      category: "coding_debug",
      turnBudget: 5,
      toolCharsBudget: 12000,
      prompt: [
        "Fix the cursor pagination bug in `src/paginate.ts` so `test/paginate.test.ts` passes cleanly (do NOT edit the test file).",
        "Make sure cyclic/repeated cursors throw a descriptive Error instead of looping infinitely, and verify with `bun test --timeout 3000`.",
      ].join("\n"),
    },
    expected: { kind: "workspace_tests" },
    metadata: { suite: "coding" },
  },
  {
    input: {
      id: "swarm_parallel_reconcile",
      category: "swarm",
      isSwarm: true,
      turnBudget: 12,
      toolCharsBudget: 16000,
      prompt: [
        "This workspace has three ledger shard files: `shard_a.json`, `shard_b.json`, and `shard_c.json`.",
        "Use `rlm.spawn()` + `rlm.collect()` to inspect the three shards in parallel (one child worker per shard file).",
        "Each worker should find any accounts where `reported_balance !== expected_balance` and return only those mismatched rows (`account_id` and `delta = reported_balance - expected_balance`).",
        "Merge the workers' findings and return ONLY a single ```json block with exact keys:",
        '{ "total_accounts": <number>, "mismatches": { "<account_id>": <delta>, ... } }',
      ].join("\n"),
    },
    expected: {
      kind: "swarm_reconcile",
      minChildSessions: 2,
      expectedJson: {
        total_accounts: 120,
        mismatches: {
          "ACCT-017": -250,
          "ACCT-064": 500,
          "ACCT-109": -75,
        },
      },
    },
    metadata: { suite: "swarm" },
  },
];

function deepEqualCanonical(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

function gradeCorrectness(output: AgentRunResult, expected: EvalCaseExpected): { score: number; reason: string } {
  if (output.timedOut) return { score: 0, reason: "agent timed out" };
  if (output.exitCode !== 0) return { score: 0, reason: `non-zero exit (${output.exitCode}): ${output.stderrTail}` };

  if (expected.kind === "workspace_tests") {
    const ok = output.workspaceCheck?.passed === true;
    return { score: ok ? 1 : 0, reason: output.workspaceCheck?.details ?? "missing workspace verifier" };
  }

  const parsed = extractJsonBlock(output.finalText);
  if (!parsed) return { score: 0, reason: "no valid JSON block in final assistant message" };
  const target = expected.expectedJson ?? {};

  if (expected.kind === "swarm_reconcile") {
    const dataExact = deepEqualCanonical(parsed, target);
    const usedSwarm = output.childSessions >= (expected.minChildSessions ?? 2);
    if (dataExact && usedSwarm) {
      return { score: 1, reason: `exact match with ${output.childSessions} swarm children` };
    }
    if (dataExact && !usedSwarm) {
      return { score: 0.7, reason: `exact data match, but only ${output.childSessions} child sessions spawned` };
    }
    return { score: 0, reason: `JSON mismatch: got ${JSON.stringify(parsed)} vs ${JSON.stringify(target)}` };
  }

  if (deepEqualCanonical(parsed, target)) {
    return { score: 1, reason: "exact JSON match" };
  }
  const keys = Object.keys(target);
  const matched = keys.filter((k) => deepEqualCanonical(parsed[k], target[k])).length;
  return {
    score: Number((matched / Math.max(1, keys.length)).toFixed(3)),
    reason: `matched ${matched}/${keys.length} keys: got ${JSON.stringify(parsed)} vs ${JSON.stringify(target)}`,
  };
}

const provider = process.env.EVAL_PROVIDER ?? "google";
const model = process.env.EVAL_MODEL ?? "gemini-4-neon";
const thinking = process.env.EVAL_THINKING ?? "low";
const gitSha = getGitSha();

Eval(process.env.BRAINTRUST_PROJECT ?? "My Project", {
  experimentName: process.env.BRAINTRUST_EXPERIMENT ?? `async-agent-${gitSha}-${model}`,
  metadata: {
    harness: "async-agent",
    git_sha: gitSha,
    provider,
    model,
    thinking,
  },
  data: () => DATA,
  maxConcurrency: Number(process.env.EVAL_CONCURRENCY ?? 2),
  task: async (input: EvalCaseInput): Promise<AgentRunResult> => {
    return runAsyncAgent({
      prompt: input.prompt,
      isSwarm: input.isSwarm,
      provider,
      model,
      thinking,
      setupWorkspace: WORKSPACE_SETUPS[input.id],
      verifyWorkspace: WORKSPACE_VERIFIERS[input.id],
    });
  },
  scores: [
    ({ output, expected }) => {
      const res = gradeCorrectness(output, expected);
      return {
        name: "Correctness",
        score: res.score,
        metadata: {
          reason: res.reason,
          wall_sec: output.wallSec,
          input_tokens: output.inputTokens,
          output_tokens: output.outputTokens,
          cache_read_tokens: output.cacheReadTokens,
          peak_turn_tokens: output.peakTurnTokens,
          assistant_turns: output.assistantTurns,
          tool_calls: output.toolCalls,
          tool_output_chars: output.toolOutputChars,
          child_sessions: output.childSessions,
        },
      };
    },
    ({ output, expected }) => {
      const res = gradeCorrectness(output, expected);
      return {
        name: "Pass",
        score: res.score === 1 ? 1 : 0,
        metadata: { reason: res.reason },
      };
    },
    ({ input, output }) => {
      const ratio = output.toolOutputChars <= input.toolCharsBudget
        ? 1
        : Math.max(0, Number((input.toolCharsBudget / Math.max(1, output.toolOutputChars)).toFixed(3)));
      return {
        name: "ContextEfficiency",
        score: ratio,
        metadata: {
          tool_output_chars: output.toolOutputChars,
          budget_chars: input.toolCharsBudget,
          max_single_tool_chars: output.maxToolResultChars,
        },
      };
    },
    ({ input, output }) => {
      const turns = Math.max(1, output.assistantTurns);
      const score = turns <= input.turnBudget
        ? 1
        : Math.max(0, Number((input.turnBudget / turns).toFixed(3)));
      return {
        name: "TurnEfficiency",
        score,
        metadata: {
          assistant_turns: output.assistantTurns,
          turn_budget: input.turnBudget,
        },
      };
    },
  ],
});
