6. Deliverables
Please use these exact paths and headings — we read a lot of submissions side by side.
1. Source code in a public git repository, with /README.md covering:
- how to set up and run it (include any keys/config needed, and how to run without live
services if applicable),
- a demo path: the exact command(s) to run the agent on a goal, then replay the resulting
artifact.
2. A design write-up at /REPORT.md (~1–3 pages), using these seven headings:
1. Architecture — your architecture and the key decisions plus trade-offs.
2. Artifact schema — the schema and why you shaped it that way.
3. Determinism & error handling — how you make replay deterministic, and how you
detect and handle runtime errors and exceptional states (and, secondarily, any UI drift).

4. Heterogeneity & multi-tenant — how your design extends to legacy web and desktop
surfaces, and to reuse across institutions running the same app (see 3.7).
5. Escalation & handoff — how you detect "stuck," how a human takes control of the live
session, and how control is handed back.
6. Safety — your guardrail model and its limits.
7. Cuts — what you deliberately left out, and what you'd build next.
3. A demonstration of the end-to-end flow in /evidence/ — a saved example artifact plus
logs from both a discovery run and a replay run. Ideally include one replay that hits an error or
exceptional state (a bad input, a not-found result, or an injected/simulated failure) to show how
your system detects and reports it. A short screen recording is welcome but optional.