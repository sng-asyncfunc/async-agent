import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface EvalWorkspace {
  root: string;
  cwd: string;
}

export interface AgentRunResult {
  finalText: string;
  exitCode: number;
  timedOut: boolean;
  wallSec: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  peakTurnTokens: number;
  assistantTurns: number;
  toolCalls: number;
  toolOutputChars: number;
  maxToolResultChars: number;
  childSessions: number;
  stderrTail: string;
  workspaceCheck?: {
    passed: boolean;
    details: string;
  };
}

export interface RunAgentOptions {
  prompt: string;
  isSwarm?: boolean;
  setupWorkspace?: (ws: EvalWorkspace) => void;
  verifyWorkspace?: (ws: EvalWorkspace) => { passed: boolean; details: string };
  timeoutMs?: number;
  provider?: string;
  model?: string;
  thinking?: string;
}

export function getGitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export function extractJsonBlock(text: string): Record<string, unknown> | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (let i = fenced.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(fenced[i][1].trim());
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // try earlier block
    }
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

function collectSessionJsonlFiles(dirs: string[]): string[] {
  const seen = new Set<string>();
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".jsonl") && !entry.name.includes("ledger")) seen.add(full);
    }
  };
  for (const dir of dirs) walk(dir);
  return [...seen].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

function parseSessionStats(sessionDir: string, agentDir: string) {
  const parentFiles = collectSessionJsonlFiles([sessionDir]);
  const childDirs = [join(agentDir, "session-artifacts"), join(agentDir, "sessions")];
  const allFiles = collectSessionJsonlFiles([sessionDir, ...childDirs]);
  const parentSet = new Set(parentFiles);
  const files = [...parentFiles, ...allFiles.filter((f) => !parentSet.has(f))];
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let peakTurnTokens = 0;
  let assistantTurns = 0;
  let toolCalls = 0;
  let toolOutputChars = 0;
  let maxToolResultChars = 0;
  let lastAssistantText = "";

  for (let fi = 0; fi < files.length; fi++) {
    const isParent = parentSet.size > 0 ? parentSet.has(files[fi]) : fi === 0;
    const content = readFileSync(files[fi], "utf8");
    for (const line of content.split("\n")) {
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
        const inp = Number(u.input ?? u.inputTokens ?? u.promptTokens ?? 0);
        const out = Number(u.output ?? u.outputTokens ?? u.completionTokens ?? 0);
        const cr = Number(u.cacheRead ?? u.cacheReadTokens ?? 0);
        inputTokens += inp;
        outputTokens += out;
        cacheReadTokens += cr;
        if (inp + cr > peakTurnTokens) peakTurnTokens = inp + cr;
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block?.type === "toolCall" || block?.type === "tool_use") toolCalls++;
            if (isParent && block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
              lastAssistantText = block.text;
            }
          }
        } else if (isParent && typeof msg.content === "string" && msg.content.trim()) {
          lastAssistantText = msg.content;
        }
      } else if (msg.role === "toolResult") {
        let chars = 0;
        if (typeof msg.content === "string") chars = msg.content.length;
        else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (typeof block?.text === "string") chars += block.text.length;
          }
        }
        toolOutputChars += chars;
        if (chars > maxToolResultChars) maxToolResultChars = chars;
      }
    }
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    peakTurnTokens,
    assistantTurns,
    toolCalls,
    toolOutputChars,
    maxToolResultChars,
    childSessions: Math.max(0, files.length - Math.max(1, parentFiles.length)),
    lastAssistantText,
  };
}

export async function runAsyncAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  const bin = process.env.ASYNC_AGENT_BIN ?? "async-agent";
  const provider = options.provider ?? process.env.EVAL_PROVIDER ?? "google";
  const model = options.model ?? process.env.EVAL_MODEL ?? "gemini-4-neon";
  const thinking = options.thinking ?? process.env.EVAL_THINKING ?? "low";

  const root = mkdtempSync(join(tmpdir(), "aa-bt-eval-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });

  const hostAuthPath = join(process.env.HOME ?? "", ".async-agent", "auth.json");
  if (existsSync(hostAuthPath)) {
    writeFileSync(join(agentDir, "auth.json"), readFileSync(hostAuthPath));
  }
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      onboardingCompleted: true,
      onboardingShown: true,
      telemetry: { noticeShown: true, enabled: false },
      defaultProvider: provider,
      defaultModel: model,
    }),
  );

  let daemonProc: ReturnType<typeof Bun.spawn> | null = null;
  try {
    if (options.setupWorkspace) {
      options.setupWorkspace({ root, cwd });
    }

    const env: Record<string, string | undefined> = {
      ...process.env,
      ASYNC_AGENT_CODING_AGENT_DIR: agentDir,
      DO_NOT_TRACK: "1",
    };

    const daemonSocket = join(root, "daemon.sock");
    if (options.isSwarm) {
      daemonProc = Bun.spawn([bin, "--mode", "daemon", "--daemon-socket", daemonSocket], {
        cwd,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      for (let i = 0; i < 80; i++) {
        if (existsSync(daemonSocket)) break;
        await Bun.sleep(100);
      }
    }

    const args = [
      bin,
      "-p",
      "--mode",
      "json",
      "--provider",
      provider,
      "--model",
      model,
      "--thinking",
      thinking,
      "--cwd",
      cwd,
      "--session-dir",
      sessionDir,
      "--no-context-files",
    ];
    if (options.isSwarm) {
      args.push("--daemon-socket", daemonSocket);
    }
    args.push("--", options.prompt);

    const t0 = performance.now();
    const proc = Bun.spawn(args, {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeoutMs = options.timeoutMs ?? (options.isSwarm ? 240_000 : 150_000);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
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
    const wallSec = Number(((performance.now() - t0) / 1000).toFixed(2));

    let streamText = "";
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        const msg = ev?.message ?? ev?.data?.message;
        if (msg?.role === "assistant" && Array.isArray(msg.content)) {
          const text = msg.content
            .filter((b: any) => b?.type === "text" && typeof b.text === "string")
            .map((b: any) => b.text)
            .join("\n")
            .trim();
          if (text) streamText = text;
        }
      } catch {
        // ignore non-json lines
      }
    }

    const stats = parseSessionStats(sessionDir, agentDir);
    const finalText = stats.lastAssistantText || streamText;
    const workspaceCheck = options.verifyWorkspace ? options.verifyWorkspace({ root, cwd }) : undefined;

    return {
      finalText,
      exitCode,
      timedOut,
      wallSec,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      cacheReadTokens: stats.cacheReadTokens,
      peakTurnTokens: stats.peakTurnTokens,
      assistantTurns: stats.assistantTurns,
      toolCalls: stats.toolCalls,
      toolOutputChars: stats.toolOutputChars,
      maxToolResultChars: stats.maxToolResultChars,
      childSessions: stats.childSessions,
      stderrTail: stderr.trim().slice(-600),
      workspaceCheck,
    };
  } finally {
    if (daemonProc) {
      try {
        daemonProc.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
