<h1 align="center">Async Agent</h1>

<p align="center">
  <strong>A Bun-Native JavaScript RLM Agent</strong>
</p>

<p align="center">
  <a href="https://github.com/sng-asyncfunc/async-agent/actions/workflows/ci.yml">
    <img src="https://github.com/sng-asyncfunc/async-agent/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" />
  </a>
</p>

## Bun-native by design

Async Agent replaces the Python/IPython notebook with a native **Bun** runtime behind a fast Rust CLI, daemon supervisor, and TUI. RLM programs execute as persistent JavaScript or TypeScript directly in Bun—not through a Python wrapper or subprocess bridge—with retained session state, prepared runtime globals, native shell execution, abort and recovery handling, and snapshot support.

Lower is better. These are end-to-end host/kernel timings from the `prime-bun` lineage (`Prime Bun v0.7.4` on Bun 1.4.0 versus upstream Prime Agent [v0.8.0](https://github.com/PrimeIntellect-ai/prime-agent/releases/tag/v0.8.0) on Python 3.11.15):

| Operation | Bun-native RLM | Python IPython | Delta |
|---|---:|---:|---:|
| Cold kernel startup | 44.88 ms | 273.38 ms | 83.6% faster |
| Scalar cell | 0.81 ms | 2.51 ms | 67.8% faster |
| 64 KiB output | 0.96 ms | 2.64 ms | 63.7% faster |
| 10,000 one-byte writes | 1.17 ms | 14.57 ms | 92.0% faster |
| Shell command | 3.39 ms | 8.78 ms | 61.3% faster |
| Abort synchronous loop | 113.13 ms | 76.32 ms | 48.2% slower |
| First cell after recovery | 2.93 ms | 2.78 ms | 5.3% slower |
| 32 MiB snapshot | 12.81 ms | 16.78 ms | 23.6% faster |
| 2,000-cell loop, per cell | 0.78 ms | 2.71 ms | 71.2% faster |

Measured on an Apple M1 Pro running macOS 26.4.1. Each value is the median across three matched rounds (12 cold startups, 40 ordinary-operation samples, six abort/recovery and snapshot samples, and 2,000 scalar cells per round), excluding one-time runtime installation and bootstrap.

> [!NOTE]
> Async Agent is a fork of [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent), with TUI lineage from [`pi`](https://github.com/earendil-works/pi). All credit for the original agent, RLM architecture, Continual Harness, and surrounding design goes to the Prime Agent and `pi` contributors. This fork rebuilds the persistent RLM REPL natively in JavaScript and TypeScript on Bun.

## Core Abstractions

Async Agent is an open-source coding and research agent for general and long-running work, built around two core abstractions:

- The **[Recursive Language Model (RLM)](https://www.primeintellect.ai/blog/rlm)** treats context as variables (*prompt-as-a-variable*) and tools like recursive subagents as function calls (*programmatic tool / subagent calling*) inside a persistent REPL.
- The **[Continual Harness](https://arxiv.org/abs/2605.09998)** stores supplemental prompts, memories, skill descriptions, and reusable subagent specifications as durable state under `~/.async-agent` that Async Agent can refine through small, evidence-backed updates, local to the session by default.

Async Agent combines a persistent Bun JavaScript control environment with durable harness state, so useful working context and reusable operating patterns can outlive a single chat window:

- **Everything is programmatic:** the persistent Bun JavaScript REPL (`javascript` tool) is the built-in model tool; file operations, shell commands, skill use, subagents, and context management happen through JavaScript or TypeScript.
- **Subagents are built in:** `rlm.spawn(...)` spawns real child agents for parallel or background work and returns their results programmatically.
- **The harness can improve:** `/refine` reviews the current trajectory and can apply small, evidence-backed updates to supplemental harness state. It never rewrites the immutable base system prompt, and recorded snapshots support rollback.
- **Skills are executable:** JavaScript/TypeScript skills in `~/.async-agent` load prepared globals into the Bun kernel; repository skills provide Markdown instructions without automatic code execution.
- **Sessions run in the background:** daemon-backed agents keep running when the terminal disconnects and can be reattached later.
- **Agents communicate directly:** running agents can exchange messages and orchestrate one another without routing everything through the user.
- **Long tasks keep moving:** automatic compaction, persistent goals, heartbeats, schedules, autonomous mode, and retained subagents preserve progress across turns and terminal sessions.

## Getting Started

### Prerequisites

- **Bun** 1.3.14 or newer (used for the persistent JavaScript/TypeScript RLM kernel)
- **Rust** toolchain (when building from source)

### Install

Install via the one-command installer on macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/sng-asyncfunc/async-agent/main/install.sh | sh
```

On Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/sng-asyncfunc/async-agent/main/install.ps1 | iex
```

Or build and run from source:

```bash
git clone https://github.com/sng-asyncfunc/async-agent.git
cd async-agent
cargo build --release -p aa-cli --bin async-agent
```

### Quickstart

Start Async Agent from the repository or directory you want it to work in:

```bash
cd /path/to/project
async-agent
```

On first launch, run `/login` to choose a subscription or API-key provider. Configuration, sessions, and harness state live in `~/.async-agent`. Async Agent works in the current directory and can run commands and modify files there—use a disposable clone, clean worktree, or another checkpoint you can inspect and restore.

> [!WARNING]
> Async Agent executes model-generated JavaScript, TypeScript, and project commands with your user permissions. Its worker and kernel processes improve lifecycle isolation and recovery; they are **not** a security sandbox. Review changes and use trusted repositories, instructions, and skills only. Run untrusted code or instructions in an external sandbox or restricted environment.

Useful commands:

```bash
async-agent agents                   # Browse running, idle, and saved sessions
async-agent attach <agent>           # Reattach to a running session
async-agent --resume [path|id]       # Browse sessions or resume one directly
async-agent status                   # Inspect background service state
async-agent doctor [--fix]           # Inspect or repair background services
async-agent update [--force]         # Update Async Agent
async-agent shutdown [--force]       # Stop every agent, worker, and background service
```

## Built for Long-Running Work

Async Agent is built for long-running work across coding, research, and evaluations. These features work both in the interactive TUI and in headless/autonomous runs:

- **Continual Harness:** `/refine` persists focused, reviewable lessons as supplemental prompts, memories, reusable skill descriptions, or subagent specifications, with recorded refinement history. It does not replace packaging and reviewing new executable skills.
- **Direct agent-to-agent communication:** running agents and retained subagents can discover one another, exchange messages, and steer active work.
- **Daemon-backed continuity:** active sessions, Bun JavaScript REPL state, schedules, and subagents keep running when the terminal detaches and can be reattached later.
- **Heartbeats and schedules:** `/heartbeat`, `rlmHeartbeat`, and `async-agent schedule` re-enter a session periodically or at a specific time.
- **Persistent goals:** `/goal` keeps an objective and its progress active across turns until it is completed, paused, or cleared.
- **Bounded autonomous mode:** `/autonomous` continues within configured turn, token, and time budgets and can run user-defined quality gates. A passed gate checks only what that gate verifies; reaching a limit does not imply task success.

## Contributing

Start with a [GitHub Discussion](https://github.com/sng-asyncfunc/async-agent/discussions) or read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) for development rules and crate boundaries.

## Disclaimer

I am not claiming JavaScript wins every RLM race. If you are building data pipelines, running heavy numerical analysis, or using the classic scientific stack, upstream Prime Agent's native IPython setup is exactly what you need.

But the future of coding agents isn't strictly data science. It is web infrastructure, edge deployments, and massive TypeScript monorepos. Prime Agent is an incredible leap forward for autonomous coding—and if you are building for the web, kill the Python kernel and run it in Bun.

## Acknowledgements

Async Agent is a fork of [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent), whose agent and TUI descend from [`pi`](https://github.com/earendil-works/pi). We thank the authors and contributors of both projects for their foundational open-source work.

## License

Async Agent is open source and released under the [MIT License](LICENSE).
