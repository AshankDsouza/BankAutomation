/**
 * Recipe Execution Layer (re_architecture.md).
 *
 * Loads the cached recipe module produced by the Recipe Making Layer and
 * runs it with the "ingredients" (parameters) extracted by
 * AllowedListScreening. The recipe runtime (recipeRuntime.ts) returns a
 * three-way RecipeOutcome - success / business_outcome / failure - and this
 * layer is responsible for turning a `failure` into a human escalation
 * (keeping the live browser session open for hand-off) rather than a bare
 * thrown error.
 */
import path from 'path';
import { pathToFileURL } from 'url';
import type { TaskParameters } from '../taskTypes.ts';
import type { HardFailureInfo } from '../recipeRuntime.ts';
import { escalateToHuman } from './escalation.ts';

export type RecipeResult = Record<string, string>;

/** What executeCachedRecipe hands back to Discovery.ts. */
export type ExecutionOutcome =
    | { kind: 'success'; result: RecipeResult }
    | { kind: 'business_outcome'; code: string; message: string; details?: Record<string, unknown> };

function isRecipeResult(value: unknown): value is RecipeResult {
    return (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.values(value).every((entry) => typeof entry === 'string')
    );
}

export async function executeCachedRecipe(
    recipePath: string,
    task: string,
    url: string,
    parameters: TaskParameters,
): Promise<ExecutionOutcome> {
    // A bare relative path is treated as a package name by import(), so resolve
    // it to an absolute file:// URL first.
    const recipe = await import(pathToFileURL(path.resolve(recipePath)).href);

    if (typeof recipe.runAction !== 'function') {
        throw new Error(`${recipePath} does not export a runAction() function`);
    }

    // Escalation for a replay-time hard failure keeps the live browser open
    // for hand-off - the same pattern already used for discovery-time
    // escalation, just triggered from inside the recipe runtime instead.
    const onHardFailure = async (info: HardFailureInfo, closeBrowser: () => Promise<void>): Promise<void> => {
        await escalateToHuman({
            reason: `Recipe replay hit a hard failure: ${info.message}`,
            task,
            url,
            parameters,
            collectedInfo: { step: info.step, expected: info.expected, observed: info.observed },
            sessionKeptAlive: true,
            onRelease: closeBrowser,
        });
    };

    const outcome = await recipe.runAction({
        recipePath,
        inputTask: task,
        inputUrl: url,
        parameters,
        onHardFailure,
    });

    if (!outcome || typeof outcome !== 'object' || !('kind' in outcome)) {
        throw new Error(`${recipePath} returned an invalid recipe outcome.`);
    }

    if (outcome.kind === 'business_outcome') {
        return outcome as ExecutionOutcome;
    }

    if (outcome.kind === 'failure') {
        // escalateToHuman (invoked via onHardFailure above) already threw
        // HumanEscalationError to unwind the run before we get here in the
        // normal case; this is a defensive fallback for a failure that
        // somehow wasn't escalated (e.g. onHardFailure was never called).
        throw new Error(`${recipePath} failed: ${outcome.message}`);
    }

    if (outcome.kind !== 'success' || !isRecipeResult(outcome.outputs)) {
        throw new Error(`${recipePath} returned an invalid recipe result.`);
    }

    const result: RecipeResult = outcome.outputs;
    const entries = Object.entries(result);
    if (entries.length === 0) {
        throw new Error(`${recipePath} completed without extracting any values.`);
    }

    if (entries.some(([, value]) => value.trim().length === 0)) {
        throw new Error(`${recipePath} completed with an empty extracted value.`);
    }

    return { kind: 'success', result };
}
