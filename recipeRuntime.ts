import { chromium } from 'playwright';
import type { Page } from 'playwright';
import { toLocator } from './browser.ts';
import type { Selector } from './browser.ts';

export type { Selector };

/**
 * Try each recorded selector in order and use the first that matches exactly
 * one element. Zero matches and several matches both count as a miss: guessing
 * between two candidates is how a replay silently reads the wrong account.
 */
export async function resolve(page: Page, selectors: Selector[], description: string) {
    const tried: string[] = [];
    for (const selector of selectors) {
        const locator = toLocator(page, selector);
        const count = await locator.count().catch(() => 0);
        if (count === 1) return locator;
        tried.push(`${selector.kind}(${count} matches)`);
    }
    throw new Error(`Could not resolve ${description}. Tried: ${tried.join(', ')}`);
}

/** Angular routes repaint after a click, so let the next view settle. */
export async function settle(page: Page): Promise<void> {
    await page.waitForTimeout(2000);
}

/**
 * Runs a recorded flow with no model in the loop and returns whatever the flow
 * declared it would extract.
 */
export async function runRecipe(
    steps: (page: Page, out: Record<string, string>) => Promise<void>,
    options: { headed?: boolean } = {},
): Promise<Record<string, string>> {
    const browser = await chromium.launch({ headless: !options.headed });
    const page = await browser.newPage();
    const out: Record<string, string> = {};
    try {
        await steps(page, out);
        return out;
    } finally {
        await browser.close();
    }
}
