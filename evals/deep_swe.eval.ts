import { Eval } from "braintrust";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DEEPSWE_DIR = resolve(
  process.env.DEEPSWE_DIR ??
    "/home/user/.studio/host/helpers/01a202a6-0195-734b-83a6-eab17df588b5/deep-swe",
);
const REPO_ROOT = resolve(
  process.env.ASYNC_AGENT_REPO ??
    "/home/user/.studio/host/helpers/01a202a6-0195-734b-83a6-eab17df588b5/prime-agent",
);
const ASYNC_AGENT_BIN = process.env.ASYNC_AGENT_BIN ?? join(process.env.HOME ?? "/home/user", ".local/bin/async-agent");
const BUN_BIN = process.env.BUN_BIN ?? "/usr/local/bin/bun";
const KERNEL_BUN_DIR = join(process.env.HOME ?? "/home/user", ".async-agent/kernel-bun");
const RUNTIME_SRC_DIR = join(REPO_ROOT, "async-agent-runtime");
const SKILLS_SRC_DIR = join(REPO_ROOT, "skills");

const PROVIDER = process.env.EVAL_PROVIDER ?? "google";
const MODEL = process.env.EVAL_MODEL ?? "gemini-4-neon";
const THINKING = process.env.EVAL_THINKING ?? "low";
const AGENT_TIMEOUT_SEC = Number(process.env.DEEPSWE_AGENT_TIMEOUT_SEC ?? 900);
const VERIFIER_TIMEOUT_SEC = Number(process.env.DEEPSWE_VERIFIER_TIMEOUT_SEC ?? 480);
const SAMPLE_SEED = Number(process.env.DEEPSWE_SAMPLE_SEED ?? 0);
const SAMPLE_COUNT = Number(process.env.DEEPSWE_SAMPLE_COUNT ?? 10);
const CACHE_PATH = resolve(
  process.env.DEEPSWE_CACHE_PATH ??
    join(REPO_ROOT, "evals", `.deepswe-cache-seed${SAMPLE_SEED}-${MODEL}-${THINKING}.json`),
);
const USE_CACHE = process.env.DEEPSWE_NO_CACHE !== "1";

function loadCache(): Record<string, DeepSweRunOutput> {
  if (!USE_CACHE || !existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8")) as Record<string, DeepSweRunOutput>;
  } catch {
    return {};
  }
}

function saveCacheEntry(taskId: string, output: DeepSweRunOutput) {
  if (!USE_CACHE) return;
  const cache = loadCache();
  cache[taskId] = output;
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

interface DeepSweTask {
  id: string;
  language: string;
  category: string;
  displayTitle: string;
  dockerImage: string;
  baseCommit: string;
  instruction: string;
  taskDir: string;
}

interface DeepSweRunOutput {
  taskId: string;
  language: string;
  reward: number;
  f2p: number;
  p2p: number;
  partial: number;
  f2pPassed: number;
  f2pTotal: number;
  p2pPassed: number;
  p2pTotal: number;
  applyFailed: boolean;
  patchBytes: number;
  agentExitCode: number;
  agentTimedOut: boolean;
  verifierExitCode: number;
  agentWallSec: number;
  verifierWallSec: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  assistantTurns: number;
  toolCalls: number;
  toolOutputChars: number;
  verifierTail: string;
  agentFinalTail: string;
  error?: string;
}

function getGitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function loadSampledTasks(): DeepSweTask[] {
  const py = `
import json, os, random, sys, tomllib
tasks_root = os.path.join(sys.argv[1], "tasks")
seed = int(sys.argv[2])
count = int(sys.argv[3])
all_tasks = sorted(t for t in os.listdir(tasks_root) if os.path.isfile(os.path.join(tasks_root, t, "task.toml")))
picked = random.Random(seed).sample(all_tasks, min(count, len(all_tasks)))
out = []
for t in picked:
    tdir = os.path.join(tasks_root, t)
    d = tomllib.load(open(os.path.join(tdir, "task.toml"), "rb"))
    m = d["metadata"]
    e = d["environment"]
    instr = open(os.path.join(tdir, "instruction.md"), "r", encoding="utf-8").read()
    out.append({
        "id": t,
        "language": m.get("language", "unknown"),
        "category": m.get("category", "unknown"),
        "displayTitle": m.get("display_title", t),
        "dockerImage": e["docker_image"],
        "baseCommit": m["base_commit_hash"],
        "instruction": instr,
        "taskDir": tdir,
    })
print(json.dumps(out))
`;
  const raw = execFileSync("python3", ["-c", py, DEEPSWE_DIR, String(SAMPLE_SEED), String(SAMPLE_COUNT)], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(raw) as DeepSweTask[];
}

function parseSessionStats(sessionDir: string) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let costUsd = 0;
  let assistantTurns = 0;
  let toolCalls = 0;
  let toolOutputChars = 0;
  let lastAssistantText = "";

  const walk = (dir: string): string[] => {
    if (!existsSync(dir)) return [];
    const res: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) res.push(...walk(full));
      else if (e.name.endsWith(".jsonl") && !e.name.includes("ledger")) res.push(full);
    }
    return res;
  };

  const files = walk(sessionDir).sort();
  for (let fi = 0; fi < files.length; fi++) {
    const text = readFileSync(files[fi], "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let row: any;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const msg = row.message ?? row;
      if (!msg || typeof msg !== "object") continue;
      if (msg.role === "assistant") {
        assistantTurns++;
        const u = msg.usage ?? {};
        inputTokens += Number(u.input ?? u.inputTokens ?? 0);
        outputTokens += Number(u.output ?? u.outputTokens ?? 0);
        cacheReadTokens += Number(u.cacheRead ?? u.cacheReadTokens ?? 0);
        costUsd += Number(u.cost?.total ?? 0);
        if (Array.isArray(msg.content)) {
          for (const b of msg.content) {
            if (b?.type === "toolCall" || b?.type === "tool_use") toolCalls++;
            if (fi === 0 && b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
              lastAssistantText = b.text;
            }
          }
        }
      } else if (msg.role === "toolResult") {
        if (typeof msg.content === "string") toolOutputChars += msg.content.length;
        else if (Array.isArray(msg.content)) {
          for (const b of msg.content) {
            if (typeof b?.text === "string") toolOutputChars += b.text.length;
          }
        }
      }
    }
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    costUsd: Number(costUsd.toFixed(5)),
    assistantTurns,
    toolCalls,
    toolOutputChars,
    lastAssistantText,
  };
}

async function runSpawnWithTimeout(
  cmd: string[],
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      onTimeout?.();
    } catch {
      // ignore
    }
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }
  }, timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { stdout, stderr, exitCode, timedOut };
}

async function runDeepSweTask(task: DeepSweTask): Promise<DeepSweRunOutput> {
  const hostTmp = mkdtempSync(join(tmpdir(), `deepswe-${task.id}-`));
  const sessionsDir = join(hostTmp, "sessions");
  const artifactsDir = join(hostTmp, "artifacts");
  const verifierDir = join(hostTmp, "verifier");
  const promptPath = join(hostTmp, "prompt.txt");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(verifierDir, { recursive: true });

  const fullPrompt = [
    task.instruction.trim(),
    "",
    "---",
    "Environment notes:",
    "- The repository is checked out at `/app`. Make all changes inside `/app`.",
    "- Run the repository's relevant test suite to verify your changes before finishing.",
    "- Do NOT leave stray temporary files in `/app`; commit or leave only clean solution changes in the working tree.",
  ].join("\n");
  writeFileSync(promptPath, fullPrompt);

  const runSuffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const agentCname = `deepswe-agent-${task.id.slice(0, 20)}-${runSuffix}`;
  const verifierCname = `deepswe-verify-${task.id.slice(0, 20)}-${runSuffix}`;

  const emptyResult = (err: string): DeepSweRunOutput => ({
    taskId: task.id,
    language: task.language,
    reward: 0,
    f2p: 0,
    p2p: 0,
    partial: 0,
    f2pPassed: 0,
    f2pTotal: 0,
    p2pPassed: 0,
    p2pTotal: 0,
    applyFailed: false,
    patchBytes: 0,
    agentExitCode: -1,
    agentTimedOut: false,
    verifierExitCode: -1,
    agentWallSec: 0,
    verifierWallSec: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    assistantTurns: 0,
    toolCalls: 0,
    toolOutputChars: 0,
    verifierTail: "",
    agentFinalTail: "",
    error: err,
  });

  try {
    console.error(`[deepswe] pulling ${task.id} (${task.language}) ...`);
    const pullRes = await runSpawnWithTimeout(["docker", "pull", "-q", task.dockerImage], 300_000);
    if (pullRes.exitCode !== 0) {
      return emptyResult(`docker pull failed (${pullRes.exitCode}): ${pullRes.stderr.slice(-400)}`);
    }

    const agentScript = `
set -u
mkdir -p /tmp/aa-home /tmp/aa-out/sessions /tmp/aa-out/artifacts
cp -a /opt/aa/kernel-bun /tmp/aa-home/kernel-bun
printf '{"onboardingCompleted":true,"onboardingShown":true,"telemetry":{"noticeShown":true,"enabled":false},"defaultProvider":"${PROVIDER}","defaultModel":"${MODEL}"}\\n' > /tmp/aa-home/settings.json
export PATH="$PATH:/opt/aa"
if [ ! -s /tmp/aa-out/prompt.txt ]; then
  echo "FATAL: /tmp/aa-out/prompt.txt is missing or empty" >&2
  exit 2
fi
timeout -k 15 "${AGENT_TIMEOUT_SEC}" /opt/aa/lib/ld-linux-x86-64.so.2 --library-path /opt/aa/lib /opt/aa/async-agent \
  -p --mode json --provider "${PROVIDER}" --model "${MODEL}" --thinking "${THINKING}" \
  --cwd /app --session-dir /tmp/aa-out/sessions --no-context-files \
  < /tmp/aa-out/prompt.txt > /tmp/aa-out/agent-stdout.jsonl 2> /tmp/aa-out/agent-stderr.log
AA_RC=$?
cd /app
git config --global --add safe.directory /app || true
if [ "$(git rev-parse HEAD 2>/dev/null || echo '')" != "${task.baseCommit}" ] && [ -z "$(git status --porcelain 2>/dev/null)" ]; then
  git diff --binary "${task.baseCommit}" HEAD > /tmp/aa-out/artifacts/model.patch || true
else
  git add -A >/dev/null 2>&1 || true
  git diff --cached --binary "${task.baseCommit}" > /tmp/aa-out/artifacts/model.patch || true
fi
chmod -R a+rwx /tmp/aa-out 2>/dev/null || true
exit $AA_RC
`;

    console.error(`[deepswe] running async-agent on ${task.id} (timeout ${AGENT_TIMEOUT_SEC}s) ...`);
    const tAgent0 = performance.now();
    const agentRes = await runSpawnWithTimeout(
      [
        "docker",
        "run",
        "--name",
        agentCname,
        "--memory=8g",
        "--cpus=2",
        "-e",
        `GEMINI_API_KEY=${process.env.GEMINI_API_KEY ?? ""}`,
        "-e",
        `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ?? ""}`,
        "-e",
        `OPENAI_API_KEY=${process.env.OPENAI_API_KEY ?? ""}`,
        "-e",
        "DO_NOT_TRACK=1",
        "-e",
        "PI_PACKAGE_DIR=/opt/aa/pkg",
        "-e",
        "ASYNC_AGENT_CODING_AGENT_DIR=/tmp/aa-home",
        "-e",
        "ASYNC_AGENT_KERNEL_BUN=/opt/aa/bun",
        "-v",
        `${ASYNC_AGENT_BIN}:/opt/aa/async-agent:ro`,
        "-v",
        `${BUN_BIN}:/opt/aa/bun:ro`,
        "-v",
        "/lib64/ld-linux-x86-64.so.2:/opt/aa/lib/ld-linux-x86-64.so.2:ro",
        "-v",
        "/lib/x86_64-linux-gnu/libc.so.6:/opt/aa/lib/libc.so.6:ro",
        "-v",
        "/lib/x86_64-linux-gnu/libm.so.6:/opt/aa/lib/libm.so.6:ro",
        "-v",
        "/lib/x86_64-linux-gnu/libgcc_s.so.1:/opt/aa/lib/libgcc_s.so.1:ro",
        "-v",
        `${KERNEL_BUN_DIR}:/opt/aa/kernel-bun:ro`,
        "-v",
        `${RUNTIME_SRC_DIR}:/opt/aa/pkg/async-agent-runtime:ro`,
        "-v",
        `${SKILLS_SRC_DIR}:/opt/aa/pkg/skills:ro`,
        "-v",
        `${hostTmp}:/tmp/aa-out`,
        task.dockerImage,
        "sh",
        "-c",
        agentScript,
      ],
      (AGENT_TIMEOUT_SEC + 90) * 1000,
      () => {
        try {
          execSync(`docker kill ${agentCname}`, { timeout: 10_000, stdio: "ignore" });
        } catch {
          // ignore
        }
      },
    );
    const agentTimedOut = agentRes.timedOut || agentRes.exitCode === 124 || agentRes.exitCode === 137;
    const agentWallSec = Number(((performance.now() - tAgent0) / 1000).toFixed(1));
    try {
      execSync(`docker rm -f ${agentCname}`, { timeout: 15_000, stdio: "ignore" });
    } catch {
      // ignore
    }

    const patchPath = join(artifactsDir, "model.patch");
    const patchBytes = existsSync(patchPath) ? statSync(patchPath).size : 0;

    console.error(`[deepswe] grading ${task.id} (patch=${patchBytes}B, agent=${agentWallSec}s, timedOut=${agentTimedOut}) ...`);
    const tVer0 = performance.now();
    const verRes = await runSpawnWithTimeout(
      [
        "docker",
        "run",
        "--rm",
        "--name",
        verifierCname,
        "--network",
        "none",
        "--memory=8g",
        "--cpus=2",
        "-v",
        `${join(task.taskDir, "tests")}:/tests:ro`,
        "-v",
        `${artifactsDir}:/logs/artifacts:ro`,
        "-v",
        `${verifierDir}:/logs/verifier`,
        task.dockerImage,
        "bash",
        "-c",
        "bash /tests/test.sh; RC=$?; chmod -R a+rwx /logs/verifier 2>/dev/null || true; exit $RC",
      ],
      VERIFIER_TIMEOUT_SEC * 1000,
      () => {
        try {
          execSync(`docker kill ${verifierCname}`, { timeout: 10_000, stdio: "ignore" });
        } catch {
          // ignore
        }
      },
    );
    const verifierWallSec = Number(((performance.now() - tVer0) / 1000).toFixed(1));

    let rewardJson: any = {};
    const rewardPath = join(verifierDir, "reward.json");
    if (existsSync(rewardPath)) {
      try {
        rewardJson = JSON.parse(readFileSync(rewardPath, "utf8"));
      } catch {
        // ignore
      }
    }

    const stats = parseSessionStats(sessionsDir);
    const verifierLog = existsSync(join(verifierDir, "run.log"))
      ? readFileSync(join(verifierDir, "run.log"), "utf8").slice(-800)
      : `${verRes.stdout}\n${verRes.stderr}`.slice(-800);

    console.error(
      `[deepswe] DONE ${task.id}: reward=${rewardJson.reward ?? 0} f2p=${rewardJson.f2p_passed ?? 0}/${rewardJson.f2p_total ?? 0} p2p=${rewardJson.p2p_passed ?? 0}/${rewardJson.p2p_total ?? 0} turns=${stats.assistantTurns} cost=$${stats.costUsd}`,
    );

    return {
      taskId: task.id,
      language: task.language,
      reward: Number(rewardJson.reward ?? 0),
      f2p: Number(rewardJson.f2p ?? 0),
      p2p: Number(rewardJson.p2p ?? 0),
      partial: Number(rewardJson.partial ?? 0),
      f2pPassed: Number(rewardJson.f2p_passed ?? 0),
      f2pTotal: Number(rewardJson.f2p_total ?? 0),
      p2pPassed: Number(rewardJson.p2p_passed ?? 0),
      p2pTotal: Number(rewardJson.p2p_total ?? 0),
      applyFailed: Boolean(rewardJson.apply_failed),
      patchBytes,
      agentExitCode: agentRes.exitCode,
      agentTimedOut,
      verifierExitCode: verRes.exitCode,
      agentWallSec,
      verifierWallSec,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      cacheReadTokens: stats.cacheReadTokens,
      costUsd: stats.costUsd,
      assistantTurns: stats.assistantTurns,
      toolCalls: stats.toolCalls,
      toolOutputChars: stats.toolOutputChars,
      verifierTail: verifierLog,
      agentFinalTail: stats.lastAssistantText.slice(-800),
    };
  } finally {
    try {
      execSync(`docker rm -f ${agentCname} ${verifierCname}`, { timeout: 15_000, stdio: "ignore" });
    } catch {
      // ignore
    }
    try {
      execSync(
        `docker run --rm --entrypoint sh -v ${JSON.stringify(hostTmp)}:/cleanup ${JSON.stringify(task.dockerImage)} -c 'rm -rf /cleanup/* /cleanup/.[!.]* 2>/dev/null || true'`,
        { timeout: 15_000, stdio: "ignore" },
      );
    } catch {
      // ignore
    }
    try {
      execSync(`docker rmi -f ${task.dockerImage}`, { timeout: 30_000, stdio: "ignore" });
    } catch {
      // ignore
    }
    try {
      rmSync(hostTmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

const gitSha = getGitSha();
const sampledTasks = loadSampledTasks();

Eval(process.env.BRAINTRUST_PROJECT ?? "My Project", {
  experimentName:
    process.env.BRAINTRUST_EXPERIMENT ?? `async-agent-deepswe-${SAMPLE_COUNT}-seed${SAMPLE_SEED}-${gitSha}-${MODEL}`,
  metadata: {
    benchmark: "datacurve-ai/deep-swe",
    sample_seed: SAMPLE_SEED,
    sample_count: SAMPLE_COUNT,
    harness: "async-agent",
    git_sha: gitSha,
    provider: PROVIDER,
    model: MODEL,
    thinking: THINKING,
    agent_timeout_sec: AGENT_TIMEOUT_SEC,
  },
  data: () =>
    sampledTasks.map((t) => ({
      input: t,
      expected: { reward: 1 },
      metadata: {
        task_id: t.id,
        language: t.language,
        category: t.category,
        display_title: t.displayTitle,
      },
    })),
  maxConcurrency: 1,
  task: async (input: DeepSweTask): Promise<DeepSweRunOutput> => {
    const cached = loadCache()[input.id];
    if (cached) {
      console.error(
        `[deepswe] CACHED ${input.id}: reward=${cached.reward} f2p=${cached.f2pPassed}/${cached.f2pTotal} p2p=${cached.p2pPassed}/${cached.p2pTotal} cost=$${cached.costUsd}`,
      );
      return cached;
    }
    const result = await runDeepSweTask(input);
    if (!result.error) {
      saveCacheEntry(input.id, result);
    }
    return result;
  },
  scores: [
    ({ output }) => ({
      name: "Resolved",
      score: output.reward === 1 ? 1 : 0,
      metadata: {
        f2p: `${output.f2pPassed}/${output.f2pTotal}`,
        p2p: `${output.p2pPassed}/${output.p2pTotal}`,
        apply_failed: output.applyFailed,
        patch_bytes: output.patchBytes,
        agent_timed_out: output.agentTimedOut,
        agent_wall_sec: output.agentWallSec,
        verifier_wall_sec: output.verifierWallSec,
        cost_usd: output.costUsd,
        turns: output.assistantTurns,
        tool_calls: output.toolCalls,
      },
    }),
    ({ output }) => ({
      name: "FailToPass",
      score: output.f2p,
      metadata: { passed: output.f2pPassed, total: output.f2pTotal },
    }),
    ({ output }) => ({
      name: "PassToPass",
      score: output.p2p,
      metadata: { passed: output.p2pPassed, total: output.p2pTotal },
    }),
    ({ output }) => ({
      name: "Partial",
      score: output.partial,
    }),
  ],
});
