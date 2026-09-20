/**
 * Recipe Mapping Layer (re_architecture.md).
 *
 * Maps an allowed action + website to the canonical recipe file that should
 * handle it (`<allowedAction>-<websiteUrl>.ts`), so that different phrasings
 * of a user request which classify to the same allowed action reuse the same
 * cached recipe.
 */
import fs from 'fs';
import path from 'path';
import { normalizeTaskText } from './allowedListScreening.ts';

function canonicalWebsiteSlug(websiteUrl: string): string {
    const parsed = new URL(websiteUrl);
    const canonical = `${parsed.hostname}${parsed.pathname}`.replace(/\/+$/, '');
    return canonical.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Both the allowed action and the website become path segments, so strip
// anything that would make an unusable filename.
export function recipePathFor(allowedAction: string, websiteUrl: string): string {
    const actionSlug = normalizeTaskText(allowedAction).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const websiteSlug = canonicalWebsiteSlug(websiteUrl);
    return path.join('recipes', `${actionSlug}-${websiteSlug}.ts`);
}

export function doesRecipeExist(allowedAction: string, websiteUrl: string): string {
    const recipePath = recipePathFor(allowedAction, websiteUrl);
    return fs.existsSync(recipePath) ? recipePath : '';
}

function timestampForFilename(): string {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function sanitizeSegment(value: string): string {
    const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return normalized || 'run';
}

/** Points the run's log file (see logger.ts) at a name derived from the mapped action, unless LOG_FILE is already set. */
export function configureRunLogFile(allowedAction: string): void {
    if (process.env.LOG_FILE && process.env.LOG_FILE.trim().length > 0) {
        return;
    }

    process.env.LOG_FILE = path.join('logs', `${sanitizeSegment(normalizeTaskText(allowedAction))}_${timestampForFilename()}.log`);
}
