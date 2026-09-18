# BankAutomation

Goal: Look up https://www.ngpf.org/bank-sim/
and look up their current savings account balance. 



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

## Runtime logging

Replay/discovery logs are emitted as JSON lines on stderr with levels:
- `LOG_LEVEL=DEBUG|INFO|WARN|ERROR` (default: `INFO`)

Each run is also saved automatically under `logs/` with this naming:
- `<recipe-name>__<datetime>.log`
- example: `logs/www.ngpf.org__tell-me-my-saving-account-balance__2026-09-18T22-30-05-123Z.log`

Each Playwright command log includes:
- `step` number
- `command` name
- `phase` (`discovery` or `replay`)
- `recipe`, `recipeTask`, `recipeUrl`
- `inputTask`, `inputUrl`
- `domSnapshot` (single-line, truncated HTML snapshot)

You can override the file path with `LOG_FILE=/custom/path.log`.