/**
 * Recipe Execution Layer (re_architecture.md).
 *
 * Loads the cached recipe module produced by the Recipe Making Layer and
 * runs it with the "ingredients" (parameters) extracted by
 * AllowedListScreening. A run is only considered a success if the recipe
 * returned at least one non-empty extracted value.
 */
import path from 'path';
import { pathToFileURL } from 'url';
import type { TaskParameters } from '../taskTypes.ts';

export type RecipeResult = Record<string, string>;

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
): Promise<RecipeResult> {
    // A bare relative path is treated as a package name by import(), so resolve
    // it to an absolute file:// URL first.
    const recipe = await import(pathToFileURL(path.resolve(recipePath)).href);

    if (typeof recipe.runAction !== 'function') {
        throw new Error(`${recipePath} does not export a runAction() function`);
    }

    const result: unknown = await recipe.runAction({
        recipePath,
        inputTask: task,
        inputUrl: url,
        parameters,
    });
    if (!isRecipeResult(result)) {
        throw new Error(`${recipePath} returned an invalid recipe result.`);
    }

    const entries = Object.entries(result);
    if (entries.length === 0) {
        throw new Error(`${recipePath} completed without extracting any values.`);
    }

    if (entries.some(([, value]) => value.trim().length === 0)) {
        throw new Error(`${recipePath} completed with an empty extracted value.`);
    }

    return result;
}
