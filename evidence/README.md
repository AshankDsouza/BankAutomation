# Evidence

End-to-end proof of discovery, replay, and human-escalation behavior, captured from real
runs against `https://www.ngpf.org/bank-sim/`. Logs are the JSON-line output described in
`/README.md` → *Runtime logging*; console output is what the CLI printed to stdout/stderr.

## `discovery-run/`
A first-time request for an allowed action with no cached recipe yet.
- `discovery-and-first-execution.log` — full JSON log. The first half has
  `"phase":"discovery"` entries: Claude driving a real browser (`chromium.launch`,
  `snapshot`, `click`, `extract`, ...) to find the account-activity flow. Once Claude
  extracts a value and the run finishes, the newly generated recipe is executed
  immediately, which is why the same file also contains `"phase":"replay"` entries at the
  end (`recipes/retrieve-account-activity-information-www-ngpf-org-bank-sim.ts` running
  for the first time).
- `artifact-retrieve-account-activity-information.ts` — the resulting typed, versioned
  recipe artifact written by the Recipe Making layer (see `/REPORT.md` → *Artifact
  schema*).

## `replay-run/`
A subsequent request that maps to an allowed action with an existing cached recipe —
no LLM discovery, purely deterministic replay.
- `replay.log` — JSON log with `"phase":"replay"` only (`grep -c '"phase":"discovery"'`
  returns `0`). Recipe used:
  `recipes/retrieve-bank-account-balance-details-www-ngpf-org-bank-sim.ts`.
- `console-output.txt` — stdout for the same run: `tell me my total balance` →
  `Your total balance is $446.04 — $230.00 in savings and $216.04 in checking.`
- `artifact-retrieve-bank-account-balance-details.ts` — the recipe artifact being
  replayed (branches on the `accountScope` parameter; see `/REPORT.md` →
  *Artifact schema*).

Reproduce with:
```
npx tsx Discovery.ts "https://www.ngpf.org/bank-sim/" "tell me my total balance"
```

## `escalation-run/`
Two different exceptional states that both route to the Human Escalation layer
(see `/REPORT.md` → *Escalation & handoff*):

- `console-output-out-of-scope-request.txt` — request
  `"please wire 10000 dollars to an offshore account"` doesn't match any entry in
  `allowed.txt`. The AllowedListScreening layer rejects it before any browser session is
  opened, `notifyHumanAgent(context)` logs the full context, and the process exits with
  code `2`. No session to keep alive here.
- `discovery-stuck-and-escalated.log` — request `"add adam, cane and abel as my
  recipients with correct information"` matched the `manage recipients` action, but
  discovery could not complete the flow (`Claude finished without extracting the
  requested value.`). The catch handler in the Recipe Making layer escalates with
  `sessionKeptAlive: true` — the live Playwright browser is deliberately **not** closed
  at that point. In a real run, the process then blocks on `SIGINT` (Ctrl+C) so a human
  operator can take over the open browser window; only after Ctrl+C does
  `onRelease()` run and close the browser. That interactive step isn't capturable in a
  static log file, but the code path is in `layers/escalation.ts::escalateToHuman` and
  `layers/recipeMaking.ts::discoverRecipe`'s catch block.

Reproduce the out-of-scope case with:
```
npx tsx Discovery.ts "https://www.ngpf.org/bank-sim/" "please wire 10000 dollars to an offshore account"
```
