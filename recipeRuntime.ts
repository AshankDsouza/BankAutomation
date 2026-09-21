import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { AsyncLocalStorage } from 'node:async_hooks';
import { toLocator } from './browser.ts';
import type { Selector } from './browser.ts';
import { PlaywrightCommandLogger } from './logger.ts';
import { assertDomainAllowed } from './safety.ts';

export type { Selector };
interface ReplayLogContext {
    logger: PlaywrightCommandLogger;
}

const replayLogging = new AsyncLocalStorage<ReplayLogContext>();

export interface RunRecipeOptions {
    headed?: boolean;
    recipe?: string;
    recipeTask?: string;
    recipeUrl?: string;
    inputTask?: string;
    inputUrl?: string;
    parameters?: Record<string, unknown>;
    /**
     * Invoked when the recipe hits a hard failure it can't recover from. The
     * live browser is *not* closed before this is called - `closeBrowser` is
     * handed to the callback so a human-escalation path (see
     * layers/escalation.ts) can keep the session open for hand-off and close
     * it only once a human operator releases it. If omitted, the browser is
     * closed immediately on hard failure, same as before.
     */
    onHardFailure?: (info: HardFailureInfo, closeBrowser: () => Promise<void>) => Promise<void>;
}

/**
 * Runtime result contract (see REPORT.md §3). Replay must distinguish three
 * kinds of outcome, not collapse them into "threw" vs "didn't throw":
 *  - success: the happy path, with the declared outputs.
 *  - business_outcome: a legitimate answer the caller needs to know about
 *    (e.g. "no such account type"), not a crash.
 *  - failure: a hard, unrecoverable runtime error, with enough detail
 *    (step/expected/observed) to debug what went wrong.
 */
export type RecipeOutcome =
    | { kind: 'success'; outputs: Record<string, string> }
    | { kind: 'business_outcome'; code: string; message: string; details?: Record<string, unknown> }
    | { kind: 'failure'; message: string; step?: string; expected?: string; observed?: string };

export interface HardFailureInfo {
    message: string;
    step?: string;
    expected?: string;
    observed?: string;
}

/** Raised by a recipe to report a legitimate business outcome (not a crash). */
export class BusinessOutcomeError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly details?: Record<string, unknown>,
    ) {
        super(message);
        this.name = 'BusinessOutcomeError';
    }
}

/** Raised for a runtime condition the recipe can't safely proceed past. */
export class HardFailureError extends Error {
    constructor(
        message: string,
        readonly step?: string,
        readonly expected?: string,
        readonly observed?: string,
    ) {
        super(message);
        this.name = 'HardFailureError';
    }
}

/** Recipes call this to report a business outcome instead of throwing a bare Error. */
export function businessOutcome(code: string, message: string, details?: Record<string, unknown>): never {
    throw new BusinessOutcomeError(code, message, details);
}

function replayLogger(): PlaywrightCommandLogger | undefined {
    return replayLogging.getStore()?.logger;
}

async function withReplayLog<T>(
    page: Page,
    command: string,
    details: Record<string, unknown>,
    action: () => Promise<T>,
): Promise<T> {
    const logger = replayLogger();
    if (!logger) {
        return action();
    }
    return logger.run(command, action, { page, details });
}

const RESOLVE_RETRY_ATTEMPTS = 2;
const RESOLVE_RETRY_DELAY_MS = 1000;

/**
 * Try each recorded selector in order and use the first that matches exactly
 * one element. Zero matches and several matches both count as a miss: guessing
 * between two candidates is how a replay silently reads the wrong account.
 *
 * A miss is retried a bounded number of times first (recoverable: transient
 * slow load/render), logged at WARN, before being treated as a hard failure.
 */
export async function resolve(page: Page, selectors: Selector[], description: string) {
    for (let attempt = 0; attempt <= RESOLVE_RETRY_ATTEMPTS; attempt++) {
        const tried: string[] = [];
        for (const selector of selectors) {
            const locator = toLocator(page, selector);
            const count = await withReplayLog(page, 'locator.count', { selector, description }, async () =>
                locator.count(),
            ).catch(() => 0);
            if (count === 1) return locator;
            tried.push(`${selector.kind}(${count} matches)`);
        }

        if (attempt < RESOLVE_RETRY_ATTEMPTS) {
            replayLogger()?.warn('resolve.retry', {
                description,
                attempt: attempt + 1,
                maxAttempts: RESOLVE_RETRY_ATTEMPTS,
                tried,
            });
            await page.waitForTimeout(RESOLVE_RETRY_DELAY_MS);
            continue;
        }

        throw new HardFailureError(
            `Could not resolve "${description}" after ${RESOLVE_RETRY_ATTEMPTS + 1} attempts.`,
            description,
            'exactly one matching element',
            tried.join(', ') || 'no candidate selectors',
        );
    }
    // Unreachable, but keeps TypeScript's control-flow analysis happy.
    throw new HardFailureError(`Could not resolve "${description}".`, description);
}

/** Angular routes repaint after a click, so let the next view settle. */
export async function settle(page: Page): Promise<void> {
    await withReplayLog(page, 'page.waitForTimeout', { timeoutMs: 2000 }, async () => page.waitForTimeout(2000));
}

/**
 * Explicit checkpoint (see REPORT.md §2/§3): asserts the flow actually
 * reached the state it expected, rather than assuming the previous click
 * worked. Failing a checkpoint is a hard failure, not a silent continue.
 */
export async function recipeCheckpoint(page: Page, selectors: Selector[], description: string): Promise<void> {
    await resolve(page, selectors, `checkpoint: ${description}`);
}

function toHardFailureInfo(error: unknown): HardFailureInfo {
    if (error instanceof HardFailureError) {
        return { message: error.message, step: error.step, expected: error.expected, observed: error.observed };
    }
    return { message: error instanceof Error ? error.message : String(error) };
}

/**
 * Runs a recorded flow with no model in the loop and returns a discriminated
 * RecipeOutcome (success / business_outcome / failure) instead of a bare
 * value-or-throw, so callers can tell "no such account" apart from "the
 * automation broke".
 */
export async function runRecipe(
    steps: (page: Page, out: Record<string, string>) => Promise<void>,
    options: RunRecipeOptions = {},
): Promise<RecipeOutcome> {
    const logger = new PlaywrightCommandLogger({
        phase: 'replay',
        recipe: options.recipe,
        recipeTask: options.recipeTask,
        recipeUrl: options.recipeUrl,
        inputTask: options.inputTask,
        inputUrl: options.inputUrl,
        parameters: options.parameters,
    });

    const browser = await logger.run('chromium.launch', async () => chromium.launch({ headless: !options.headed }), {
        details: { headless: !options.headed },
    });
    const page = await logger.run('browser.newPage', async () => browser.newPage());
    const out: Record<string, string> = {};

    const closeBrowser = async (): Promise<void> => {
        await logger.run('browser.close', async () => browser.close(), { page });
    };

    try {
        await replayLogging.run({ logger }, async () => {
            await steps(page, out);
        });
        await closeBrowser();
        return { kind: 'success', outputs: out };
    } catch (error) {
        if (error instanceof BusinessOutcomeError) {
            // Not a crash: a legitimate answer. The browser has nothing left
            // to do, so close it immediately - there's no human decision
            // needed here.
            await closeBrowser();
            return { kind: 'business_outcome', code: error.code, message: error.message, details: error.details };
        }

        const info = toHardFailureInfo(error);
        if (options.onHardFailure) {
            // Deliberately do not close the browser here: the callback owns
            // the decision (e.g. keep the live session open for a human
            // operator) and is handed closeBrowser to call once it's safe to.
            await options.onHardFailure(info, closeBrowser);
        } else {
            await closeBrowser();
        }
        return { kind: 'failure', ...info };
    }
}

export async function recipeGoto(page: Page, url: string): Promise<void> {
    assertDomainAllowed(url, 'replay');
    await withReplayLog(
        page,
        'page.goto',
        { url, waitUntil: 'domcontentloaded' },
        async () => page.goto(url, { waitUntil: 'domcontentloaded' }),
    );
}

export async function recipeClick(page: Page, selectors: Selector[], description: string): Promise<void> {
    const locator = await resolve(page, selectors, description);
    await withReplayLog(page, 'locator.click', { selectors, description }, async () => locator.click());
}

export async function recipeFill(page: Page, selectors: Selector[], description: string, value: string): Promise<void> {
    const locator = await resolve(page, selectors, description);
    await withReplayLog(page, 'locator.fill', { selectors, description }, async () => locator.fill(value));
}

export async function recipePress(page: Page, key: string): Promise<void> {
    await withReplayLog(page, 'keyboard.press', { key }, async () => page.keyboard.press(key));
}

export async function recipeExtract(page: Page, selectors: Selector[], description: string): Promise<string> {
    const locator = await resolve(page, selectors, description);
    return withReplayLog(page, 'locator.innerText', { selectors, description }, async () => locator.innerText());
}
