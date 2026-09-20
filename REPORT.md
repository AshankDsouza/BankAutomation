# REPORT

## 1. Architecture

The system is split into the six layers proposed in `re_architecture.md`, each its own
file under `layers/`, wired together by the CLI entrypoint `Discovery.ts`:

```
AllowedListScreening -> Recipe Mapping -> Recipe Making -> Recipe Execution -> User Request Processing
                                                  |
                                                  v
                                          Human Escalation (from screening or making)
```

- **AllowedListScreening** (`layers/allowedListScreening.ts`) sends the raw user request
  plus the contents of `allowed.txt` to Claude and gets back `{ action, confidence,
  parameters, isInformationRetrieval }`. A confidence threshold (`CONFIDENCE_SCORE_THRESHOLD
  = 0.85`) and a hard check that `action` string-matches an allowed entry both have to pass
  before the request is allowed to proceed — the model can't launder an out-of-scope
  request into an allowed one just by asserting high confidence.
- **Recipe Mapping** (`layers/recipeMapping.ts`) turns `(allowedAction, websiteUrl)` into a
  canonical, flat path: `recipes/<allowed-action-slug>-<website-slug>.ts`. Two different
  phrasings that classify to the same allowed action against the same site collapse onto the
  same recipe file — this is the reuse mechanism the spec asks for.
- **Recipe Making** (`layers/recipeMaking.ts`) is the only layer that runs the LLM against a
  live browser. It only fires on a cache miss. Claude is given the browser as a tool
  (`tools.ts` + `browser.ts`) and told to accomplish the *allowed action*, not the user's
  literal wording — for retrieval tasks this deliberately biases discovery toward gathering
  more general information (e.g. both account balances) than one specific phrasing asked
  for, so the same recipe can answer many phrasings later (see §2 and the codegen special
  case for the bank-balance action). Successful runs are compiled into a recipe `.ts` file.
- **Recipe Execution** (`layers/recipeExecution.ts`) `import()`s the cached recipe module
  and calls its `runAction()` with the extracted parameters, validating the shape and
  non-emptiness of the result before treating it as a success.
- **User Request Processing** (`layers/userRequestProcessing.ts`) only runs for
  information-retrieval actions: it hands the *original* user request plus the recipe's
  (deliberately general) result back to the LLM to produce the specific answer the user
  asked for (e.g. picks `savings_balance` out of a result containing both balances).
- **Human Escalation** (`layers/escalation.ts`) is reachable from both AllowedListScreening
  (reject before any browser exists) and Recipe Making (browser got stuck mid-discovery).
  See §5.

**Key decisions & trade-offs:**
- *Discovery sees the allowed action, not the raw request* — trades a small amount of
  discovery-time specificity for much better recipe reuse and long-term determinism (fewer,
  more general recipes vs. one recipe per phrasing).
- *One process, one Playwright browser instance per request* — simple and easy to reason
  about, but means concurrent requests each pay full browser startup cost; no session pool.
- *Recipes are executable TypeScript, not pure data* — chosen for developer ergonomics
  (recipes are readable/diffable code, and the bank-balance recipe encodes real branching
  logic), at the cost of recipes not being safely sandboxable/data-only (see §7).
- *Classification and parameter extraction are one LLM call*, not two — keeps latency and
  cost down for the common case at the cost of coupling the two concerns in one prompt.

## 2. Artifact schema

A recipe is a generated `.ts` module with three required exports:

```ts
export const TASK: string;   // human-readable task/action label
export const ACTION: string; // the allowed-action this recipe implements
export const URL: string;    // the site it was discovered against
export async function runAction(context: {
  recipePath?: string;
  inputTask?: string;
  inputUrl?: string;
  parameters?: Record<string, unknown>;
}): Promise<Record<string, string>>
```

`runAction` is implemented in terms of a small typed step vocabulary shared with the
discovery-time recorder (`browser.ts`):

```ts
type Selector =
  | { kind: 'testId'; value: string }
  | { kind: 'role'; role: string; name: string }
  | { kind: 'label'; value: string }
  | { kind: 'placeholder'; value: string }
  | { kind: 'text'; value: string }
  | { kind: 'css'; value: string }
  | { kind: 'within'; anchorText: string; ancestor: string; css: string };

type Step =
  | { action: 'goto'; url: string }
  | { action: 'click'; selectors: Selector[]; description: string }
  | { action: 'fill'; selectors: Selector[]; description: string; value: string }
  | { action: 'press'; key: string }
  | { action: 'extract'; selectors: Selector[]; description: string; name: string };
```

Every recorded action carries a *list* of selectors, not one — discovery records several
independent ways to find the same element (test id, ARIA role+name, visible text, a
`within`-scoped CSS selector anchored to a nearby heading, ...). Replay (`recipeRuntime.ts`
`resolve()`) tries them in order and takes the first that matches exactly one element. This
is why the schema is shaped as "selector list per step" rather than "one selector per step":
it's the main lever for surviving cosmetic DOM churn without re-running discovery.

For the one allowed action with real branching needs (`retrieve bank account balance
details`), the codegen path in `layers/recipeMaking.ts::buildBankBalanceRecipe` emits a
different, hand-designed template instead of a literal `Step[]` replay: a small `ACCOUNTS`
config array plus a loop that extracts every account's balance unconditionally. This
matches the "expose only the allowed action to discovery, retrieve everything" design in
`re_architecture.md` — the artifact schema stays typed and versioned, but isn't required to
be a 1:1 transcript of one discovery run when a small, well-scoped piece of hand-authored
branching logic is more robust and readable than trying to make the *generic* step-replay
format support conditionals. See `evidence/replay-run/artifact-retrieve-bank-account-balance-details.ts`
for the emitted result.

## 3. Determinism & error handling

Replay never calls the LLM. `runAction()` is plain Playwright driven by the typed
`Step`/`Selector` data above, run through `recipeRuntime.ts`'s `resolve()`, which:
1. Tries each selector for a step in order.
2. Requires the resolved locator to match **exactly one** element (`locator.count() === 1`)
   before acting — ambiguous matches are treated as a failure, not silently resolved to
   "first match", so a recipe never silently clicks the wrong element after a DOM change.
3. Throws a descriptive error (`No selector matched for "<description>"`) if nothing
   resolves, which propagates up through `executeCachedRecipe` (`layers/recipeExecution.ts`)
   as a hard failure rather than a false "success".

`executeCachedRecipe` additionally treats a run as failed (not just "recipe threw") if:
- `runAction()` doesn't return an object of `Record<string, string>`,
- it returns zero extracted keys, or
- any extracted value is an empty/whitespace-only string.

This directly implements the spec's example: a `null`/blank saving-balance extraction is
never reported as success.

Every Playwright command (discovery *and* replay) is wrapped by `PlaywrightCommandLogger`
(`logger.ts`), which logs, per command: a monotonic step number, the command name, the
`phase` (`discovery`/`replay`), recipe/task/URL metadata, and a truncated DOM snapshot taken
right after the command finishes (or on error). This is the primary tool for diagnosing
*why* replay drifted from the recorded flow — the DOM snapshot around the failing step is
right there in the log (see `evidence/replay-run/replay.log`, `evidence/discovery-run/discovery-and-first-execution.log`).

UI drift is handled secondarily by the multi-selector fallback described in §2; it isn't
detected proactively (no diffing against a stored "expected DOM" — see §7 for what's cut).

## 4. Heterogeneity & multi-tenant

The design already separates three concerns that heterogeneity requires keeping separate:
- **What action is allowed** (`allowed.txt`) is app-agnostic English text.
- **Which recipe answers it for a given site** (`layers/recipeMapping.ts`) is keyed by
  `(allowedAction, websiteUrl)`, so the same allowed action against a different bank's site
  gets its own recipe file automatically — no code change needed, just a new discovery run
  the first time a given institution is seen.
- **How the recipe is executed** (`Selector`/`Step`, `browser.ts`) is currently Playwright/
  DOM-specific, but is isolated behind `recipeRuntime.ts`'s small helper surface
  (`recipeGoto`, `recipeClick`, `recipeFill`, `recipePress`, `recipeExtract`, `resolve`,
  `settle`). Extending to legacy web (frames, older jQuery-driven UIs) is mostly a matter of
  adding selector kinds (e.g. `iframe`-scoped `within`) without touching the layer
  boundaries above it.
- Extending to **desktop surfaces** would mean adding a second "driver" behind the same
  `runAction(context)` contract — e.g. an OS-accessibility-tree driver with its own
  `Selector` variants (window title, control automation ID, ...) — while AllowedListScreening,
  Recipe Mapping, Recipe Making's LLM-loop shape, Recipe Execution's result-validation
  contract, and Human Escalation all stay unchanged. This isn't implemented, but the seam is
  where `browser.ts`/`recipeRuntime.ts` currently sit.
- **Reuse across institutions running the same underlying app**: because the recipe path is
  `<allowed-action>-<canonical-website-slug>.ts`, two tenants on the same white-labeled
  platform but different domains currently get two separate (identical-looking) recipes.
  The natural next step (not yet built) is to key recipes by *app template* rather than
  raw hostname when the platform is known to be shared, falling back to per-host discovery
  otherwise.

## 5. Escalation & handoff

"Stuck" is detected in two places, both routed through `layers/escalation.ts`:

1. **AllowedListScreening rejects the request** (`action === null` or
   `confidence < CONFIDENCE_SCORE_THRESHOLD`) — no browser session exists yet, so escalation
   is just a notification + non-zero exit (`sessionKeptAlive: false`). Evidence:
   `evidence/escalation-run/console-output-out-of-scope-request.txt` (exit code `2`).
2. **Recipe Making gets stuck mid-discovery** — Claude finishes without performing any
   action, without extracting a value, hits the iteration/token/time budget
   (`DISCOVERY_MAX_*` env vars in `layers/recipeMaking.ts`), or throws for any other reason.
   Here a *live* Playwright browser session already exists. The `catch` block in
   `discoverRecipe()` calls `escalateToHuman({ ..., sessionKeptAlive: true, onRelease: () =>
   session.close() })` — critically, it does **not** call `session.close()` itself.
   Evidence: `evidence/escalation-run/discovery-stuck-and-escalated.log`.

`escalateToHuman()` (`layers/escalation.ts`) always calls a `notifyHumanAgent(context)`
placeholder first — logging the reason, task, URL, matched action, confidence, parameters,
and anything already collected (e.g. the partial `Step[]` trace) — the hook where a real
paging/ticketing integration (Slack, PagerDuty, a queue) would plug in.

When `sessionKeptAlive` is true, `escalateToHuman()` then **blocks the process** on a single
`SIGINT` (Ctrl+C) instead of returning or exiting — this is what keeps the Chromium child
process (and the open, navigable browser window in headed mode) alive so a human operator
can literally take over the mouse/keyboard on the same page the agent was looking at. Once
the operator is done and presses Ctrl+C, `onRelease()` runs (closing the browser) and *then*
a `HumanEscalationError` is thrown, unwinding back to `Discovery.ts`'s top-level handler,
which prints the reason and exits with code `2`. This was verified manually: the Node
process and the Playwright-launched Chrome process were both confirmed still running via
`ps` while escalated, and both exited cleanly only after sending `SIGINT`.

Handoff back to the automated system is currently manual/out of scope: a human who
completes the task is not yet fed back into recipe-making as a new branch (see §7).

## 6. Safety

- **Allowlist is the only path to real actions.** `AllowedListScreening` runs before any
  browser is opened; a request that doesn't map (with sufficient confidence) to an entry in
  `allowed.txt` never reaches Recipe Making/Execution at all — it's escalated instead.
- **The model can't silently redefine the allowlist.** Even if the LLM asserts an `action`
  string, `classifyTask()` re-checks it against a normalized version of `allowed.txt` server
  side (`normalizeTaskText` + exact match) and forces it to `null` if it doesn't match a
  real entry — a hallucinated or paraphrased "allowed" action is rejected, not trusted.
- **Regulated data minimization by design, not by prompt.** `allowed.txt`'s balance-retrieval
  entry explicitly excludes "account numbers or passwords", and the bank-balance recipe
  template (`layers/recipeMaking.ts::buildBankBalanceRecipe`) only ever extracts balance
  text — there's no code path in that recipe that could extract or log an account number,
  independent of what any prompt says.
- **Bounded discovery.** `DISCOVERY_MAX_ITERATIONS`, `DISCOVERY_MAX_STEPS`,
  `DISCOVERY_MAX_TOTAL_TOKENS`, and `DISCOVERY_TIMEOUT_MS` (all in `layers/recipeMaking.ts`)
  put a hard ceiling on how much the agent can do/spend per discovery run before it's forced
  to stop (and, per §5, escalate) rather than loop indefinitely against a live financial
  site.
- **Result validation before anything is reported as done.** See §3 — empty/blank/malformed
  results are treated as failures, not silently reported as success, which limits the blast
  radius of a confidently-wrong extraction.

**Limits:** the guardrail is a flat English string-match allowlist, not a formal policy
engine — it can't express constraints like "read-only for account X but not Y", per-user
authorization, or rate limits. Logs currently capture full DOM snapshots
(`logger.ts::snapshotPreview`), which is useful for debugging but is itself a place
sensitive on-screen data (if ever present) could leak into `logs/`; there's no redaction
pass on log content today.

## 7. Cuts

Deliberately left out, given time constraints:
- **Real human-notification integration.** `notifyHumanAgent()` only logs to the console;
  there's no Slack/PagerDuty/ticket-queue wiring, though the call site and payload shape are
  already in place.
- **Recipe versioning/migration.** Recipes are overwritten in place by filename; there's no
  schema version field, no way to detect an artifact was generated by an older codegen
  template, and no migration path if the `Step`/`Selector` schema changes.
- **Learning from a human takeover.** When a human completes a task Discovery escalated,
  that resolution isn't captured back into a new recipe branch, so the same class of
  request will escalate again next time (planning.md's "exceptional state handling" idea).
- **Non-DOM/non-Playwright drivers.** Only a browser/DOM driver exists; the desktop/legacy
  surface extension point described in §4 is a seam, not an implementation.
- **Cross-institution recipe reuse for shared platforms.** Recipes key on the concrete
  hostname, not an app-template identity (§4).
- **Concurrency/session pooling.** One browser per request; no shared pool or queueing for
  concurrent discovery runs.
- **Log redaction.** DOM-snapshot-based logs are useful for debugging (§3) but are not
  scrubbed for sensitive substrings before being written to `logs/`.

What I'd build next, in priority order: (1) a real `notifyHumanAgent` integration + a way to
record the human's resolution as a recipe variant, since that's the biggest lever on
long-run automation coverage; (2) log redaction, since these are meant to be regulated
financial flows; (3) an app-template-keyed recipe cache for true multi-tenant reuse.
