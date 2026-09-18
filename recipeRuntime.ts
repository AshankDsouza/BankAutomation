import { chromium } from 'playwright';
import type { Page } from 'playwright';
import { AsyncLocalStorage } from 'node:async_hooks';
import { toLocator } from './browser.ts';
import type { Selector } from './browser.ts';
import { PlaywrightCommandLogger } from './logger.ts';

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

/**
 * Try each recorded selector in order and use the first that matches exactly
 * one element. Zero matches and several matches both count as a miss: guessing
 * between two candidates is how a replay silently reads the wrong account.
 */
export async function resolve(page: Page, selectors: Selector[], description: string) {
    const tried: string[] = [];
    for (const selector of selectors) {
        const locator = toLocator(page, selector);
        const count = await withReplayLog(page, 'locator.count', { selector, description }, async () =>
            locator.count(),
        ).catch(() => 0);
        if (count === 1) return locator;
        tried.push(`${selector.kind}(${count} matches)`);
    }
    throw new Error(`Could not resolve ${description}. Tried: ${tried.join(', ')}`);
}

/** Angular routes repaint after a click, so let the next view settle. */
export async function settle(page: Page): Promise<void> {
    await withReplayLog(page, 'page.waitForTimeout', { timeoutMs: 2000 }, async () => page.waitForTimeout(2000));
}

/**
 * Runs a recorded flow with no model in the loop and returns whatever the flow
 * declared it would extract.
 */
export async function runRecipe(
    steps: (page: Page, out: Record<string, string>) => Promise<void>,
    options: RunRecipeOptions = {},
): Promise<Record<string, string>> {
    const logger = new PlaywrightCommandLogger({
        phase: 'replay',
        recipe: options.recipe,
        recipeTask: options.recipeTask,
        recipeUrl: options.recipeUrl,
        inputTask: options.inputTask,
        inputUrl: options.inputUrl,
    });

    const browser = await logger.run('chromium.launch', async () => chromium.launch({ headless: !options.headed }), {
        details: { headless: !options.headed },
    });
    const page = await logger.run('browser.newPage', async () => browser.newPage());
    const out: Record<string, string> = {};
    try {
        await replayLogging.run({ logger }, async () => {
            await steps(page, out);
        });
        return out;
    } finally {
        await logger.run('browser.close', async () => browser.close(), { page });
    }
}

export async function recipeGoto(page: Page, url: string): Promise<void> {
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
