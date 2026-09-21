/**
 * Domain allowlist (safety guardrail, see REPORT.md §6).
 *
 * Every navigation - discovery (browser.ts) and replay (recipeRuntime.ts) -
 * goes through assertDomainAllowed() before Playwright is told to go
 * anywhere. This is enforced at the one seam all navigation must pass
 * through, so it can't be bypassed by a hallucinated task, a malformed
 * parameter, or a recipe that was edited by hand.
 */
import fs from 'fs';

const ALLOWED_DOMAINS_FILE = 'allowed_domains.txt';

let cachedDomains: string[] | null = null;

function readAllowedDomains(): string[] {
    if (cachedDomains) {
        return cachedDomains;
    }

    if (!fs.existsSync(ALLOWED_DOMAINS_FILE)) {
        cachedDomains = [];
        return cachedDomains;
    }

    cachedDomains = fs
        .readFileSync(ALLOWED_DOMAINS_FILE, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim().toLowerCase())
        .filter((line) => line.length > 0 && !line.startsWith('#'));

    return cachedDomains;
}

function hostnameOf(url: string): string {
    return new URL(url).hostname.toLowerCase();
}

export function isDomainAllowed(url: string): boolean {
    const hostname = hostnameOf(url);
    return readAllowedDomains().some(
        (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    );
}

/** Throws with a clear, debuggable message if `url`'s host isn't allowlisted. */
export function assertDomainAllowed(url: string, context: 'discovery' | 'replay'): void {
    if (isDomainAllowed(url)) {
        return;
    }
    throw new Error(
        `Refusing to navigate to disallowed domain during ${context}: "${hostnameOf(url)}". ` +
        `Add it to ${ALLOWED_DOMAINS_FILE} to permit automation against this host.`,
    );
}

// --- Risky vs. safe/reversible action classification ---

const RISKY_ACTIONS_FILE = 'risky_actions.txt';

let cachedRiskyActions: string[] | null = null;

function normalize(value: string): string {
    return value.toLowerCase().replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
}

function readRiskyActions(): string[] {
    if (cachedRiskyActions) {
        return cachedRiskyActions;
    }

    if (!fs.existsSync(RISKY_ACTIONS_FILE)) {
        cachedRiskyActions = [];
        return cachedRiskyActions;
    }

    cachedRiskyActions = fs
        .readFileSync(RISKY_ACTIONS_FILE, 'utf8')
        .split(/\r?\n/)
        .map((line) => normalize(line))
        .filter((line) => line.length > 0 && !line.startsWith('#'));

    return cachedRiskyActions;
}

export type ActionRisk = 'safe' | 'risky';

/**
 * Explicit allowlisted actions are classified as `risky` when they appear in
 * risky_actions.txt. Anything not explicitly listed there falls back to a
 * conservative heuristic: read-only ("retrieve ...") actions are `safe`,
 * everything else defaults to `risky` (fail closed on unrecognized shapes,
 * rather than silently treating a new allowed action as safe).
 */
export function classifyActionRisk(allowedAction: string): ActionRisk {
    const normalized = normalize(allowedAction);
    if (readRiskyActions().includes(normalized)) {
        return 'risky';
    }
    return normalized.startsWith('retrieve') ? 'safe' : 'risky';
}

/**
 * Prompts on the terminal for explicit y/n confirmation before a risky
 * action is allowed to run unattended. Requires an interactive TTY on
 * stdin/stdout - if the process isn't attached to one (e.g. run in CI or
 * piped), there is no one to ask, so this fails closed (returns false)
 * rather than silently proceeding or blocking forever on input that will
 * never arrive.
 */
export async function confirmRiskyAction(allowedAction: string, task: string): Promise<boolean> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error(
            `Cannot prompt for confirmation of risky action "${allowedAction}": no interactive terminal attached.`,
        );
        return false;
    }

    const readline = await import('node:readline/promises');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await rl.question(
            `\nThe request "${task}" requires the risky action "${allowedAction}".\n` +
            'Confirm you want this to proceed (yes/no): ',
        );
        return /^y(es)?$/i.test(answer.trim());
    } finally {
        rl.close();
    }
}
