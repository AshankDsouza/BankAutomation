# BankAutomation

Goal: Look up https://www.ngpf.org/bank-sim/
and look up their current savings account balance. 

demo video: https://www.loom.com/share/060cf230fd90454281af74d0e2ad425a


Build a system that can:
1. Take a goal in natural language for a target application (e.g. "look up member 12345
and read their current savings balance", "open a new sub-account for this member and
reach the confirmation screen", or — if you use a public proxy target — "add a specific
item to the cart and reach the checkout review page").

2. Use an LLM to accomplish that goal by driving a real application surface — observing
the current state, deciding what to do, and acting. The surface may be a browser, but
treat that as one case of a more general "computer use" problem (accessibility tree,
screenshot + coordinates, OS-level automation, etc. are all fair game).
3. Record the successful run as a structured, reusable artifact — a typed, versioned
description of the flow (the steps taken, how each target element/control is identified,
and any data to extract) that is decoupled from the raw model transcript.
4. Replay that artifact deterministically — re-run the recorded flow without the LLM in
the decision loop, using stable element/control targeting, and report success/failure.
5. Escalate to a human when stuck — when the system can't safely proceed, route an
intervention request to a human operator and let them take control of the live session,
then hand control back.
6. Stay within safety guardrails throughout — respect an allowlist of what the agent is
permitted to do, and avoid leaking or persisting sensitive data (this is regulated financial
data).
The through-line to keep in mind:
The model discovers. The artifact becomes a reusable capability. Deterministic replay is
how the AI agent invokes it in production.

## Setup

Requirements: Node.js 20+.

```bash
npm install
npx playwright install chromium
```

Create a `.env` file in the repo root with Anthropic credentials (either works):
```
ANTHROPIC_API_KEY=sk-ant-...
# or, if you use `ant auth login` locally, ANTHROPIC_AUTH_TOKEN=...
```
`.env` is loaded automatically by `llmClient.ts`/`env.ts`; it is git-ignored.

## Demo path

Run the agent on a goal (discovers + caches a recipe on first run, then executes it):
```bash
npx tsx Discovery.ts "https://www.ngpf.org/bank-sim/" "tell me my total balance"
```
This prints the final answer (e.g. `Your total balance is $446.04 — ...`) and writes a
cached recipe under `recipes/` plus a JSON-line log under `logs/`.

Replay the exact same artifact deterministically (no LLM discovery, since the recipe now
exists) by running the same command again, or any phrasing that maps to the same allowed
action, e.g.:
```bash
npx tsx Discovery.ts "https://www.ngpf.org/bank-sim/" "what is my savings balance?"
```

Set `HEADED=1` to watch the browser during either run:
```bash
HEADED=1 npx tsx Discovery.ts "https://www.ngpf.org/bank-sim/" "tell me my total balance"
```

`bash test_bank_recipe.sh` wraps one of the above commands for convenience (loads `.env`,
defaults `HEADED=1`).

See `/evidence/` for saved logs and artifacts from real discovery, replay, and
human-escalation runs, and `/REPORT.md` for the architecture write-up.

## Request flow

Each request moves through the following layers (each implemented as its own file under
`layers/`):

1. **Allowed-list screening** (`layers/allowedListScreening.ts`) — the model maps the
   natural-language request to an entry in `allowed.txt`. Requests that cannot be matched
   confidently escalate to a human (`layers/escalation.ts`) instead of proceeding.
2. **Recipe mapping** (`layers/recipeMapping.ts`) — request parameters are extracted and
   the matching recipe is selected by allowed action and website, so equivalent requests
   reuse one recipe.
3. **Recipe making** (`layers/recipeMaking.ts`) — if no cached recipe exists, discovery
   sees the allowed action rather than the individual request. Information-retrieval
   recipes collect the full related context needed to serve different requests for that
   action. If discovery gets stuck, it escalates to a human with the live browser session
   left open.
4. **Recipe execution** (`layers/recipeExecution.ts`) — the cached recipe replays
   deterministically and returns an `ExecutionOutcome`: either the extracted context on
   success, or a known `business_outcome` (e.g. an unsupported account type) passed
   straight through to the caller instead of being treated as a crash. A hard failure
   during replay (a checkpoint that never resolves, a selector that never matches) also
   escalates to a human with the live browser kept open, the same as a stuck discovery run.
5. **User request processing** (`layers/userRequestProcessing.ts`) — for information
   retrieval, the original request and recipe result are supplied to the model to produce
   the concise user-facing answer.
6. **Human escalation** (`layers/escalation.ts`) — reached from layers 1 and 3. Notifies a
   human operator with full context and, if a browser session exists, keeps it open until
   the operator releases it (Ctrl+C), rather than closing it out from under them.

`Discovery.ts` is the CLI entrypoint that wires these layers together; `env.ts`,
`llmClient.ts`, and `taskTypes.ts` are small shared infrastructure used across layers.

## Safety guardrails

`safety.ts` enforces two independent, configurable checks before/around every request:

- **Domain allowlist** (`allowed_domains.txt`, one hostname per line) — enforced at the
  Playwright navigation seam itself (`browser.ts::goto` for discovery,
  `recipeRuntime.ts::recipeGoto` for replay), so it can't be bypassed by a hallucinated
  task or a hand-edited recipe. Add a hostname there to permit automation against it.
- **Risky vs. safe action classification** (`risky_actions.txt`) — `Discovery.ts` checks
  `classifyActionRisk(action)` right after AllowedListScreening, before any browser opens.
  Actions listed in `risky_actions.txt` (currently `create a type of bank account` and
  `manage recipients (...)`) prompt for an explicit `yes`/`no` confirmation typed at the
  terminal before running unattended; typing anything other than `yes`, or running
  non-interactively (no TTY on stdin/stdout — e.g. in CI or piped output), escalates to a
  human instead. Anything *not* listed in `risky_actions.txt` defaults to `risky` unless it
  starts with `retrieve` (read-only actions are assumed safe) — a fail-closed heuristic for
  any new allowed action. See `evidence/risky-action-blocked-run/` for a captured example.

Replay also reports a three-way result instead of just success/throw
(`recipeRuntime.ts`'s `RecipeOutcome`): `success` (with outputs), a known
`business_outcome` (e.g. an unsupported account type — a legitimate answer, not a crash),
or a `failure` with the step/expected/observed detail needed to debug it. Recipes assert an
explicit checkpoint (`recipeCheckpoint()`) after key navigation steps to confirm the
expected state was actually reached, rather than assuming a click worked.

## Runtime logging

Replay/discovery logs are emitted as JSON lines on stderr with levels:
- `LOG_LEVEL=DEBUG|INFO|WARN|ERROR` (default: `INFO`)

Each run is also saved automatically under `logs/` with this naming:
- `<identified_allowed_action>_<datetime>.log`
- example: `logs/retrieve_bank_details_2026-09-18T22-30-05-123Z.log`

Each Playwright command log includes:
- `step` number
- `command` name
- `phase` (`discovery` or `replay`)
- `recipe`, `recipeTask`, `recipeUrl`
- `inputTask`, `inputUrl`
- `domSnapshot` (single-line, truncated HTML snapshot)

You can override the file path with `LOG_FILE=/custom/path.log`.

## Discovery limits

Recipe discovery runs a bounded observe -> decide -> act loop against the live UI. Defaults:
- `DISCOVERY_MAX_ITERATIONS=20`
- `DISCOVERY_MAX_RESPONSE_TOKENS=4000`
- `DISCOVERY_MAX_TOTAL_TOKENS=50000`
- `DISCOVERY_MAX_STEPS=20`
- `DISCOVERY_TIMEOUT_MS=120000`

Discovery stops with an error if it hits a limit or finishes without extracting the requested value.
