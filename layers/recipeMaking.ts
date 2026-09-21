/**
 * Recipe Making Layer (re_architecture.md).
 *
 * Creates (and caches) the recipe that will later be replayed by the Recipe
 * Execution Layer. If a recipe already exists for the mapped
 * action+website (Recipe Mapping Layer), it's reused as-is. Otherwise Claude
 * drives a real browser once to discover a working path, and the recorded
 * steps are compiled into a deterministic, parameterized recipe file.
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { client } from '../llmClient.ts';
import { BrowserSession } from '../browser.ts';
import type { Step } from '../browser.ts';
import { browserTools } from '../tools.ts';
import { escalateToHuman } from './escalation.ts';
import { doesRecipeExist, recipePathFor } from './recipeMapping.ts';
import type { TaskParameters } from '../taskTypes.ts';
import type { HardFailureInfo } from '../recipeRuntime.ts';

/** Extra context every generated runAction() accepts, on top of the recipe/task/url fields. */
interface RunActionContext {
    recipePath?: string;
    inputTask?: string;
    inputUrl?: string;
    parameters?: Record<string, unknown>;
    onHardFailure?: (info: HardFailureInfo, closeBrowser: () => Promise<void>) => Promise<void>;
}

interface DiscoveryLimits {
    maxIterations: number;
    maxResponseTokens: number;
    maxSteps: number;
    maxTotalTokens: number;
    timeoutMs: number;
}

function readPositiveIntEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') {
        return fallback;
    }

    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer.`);
    }

    return value;
}

function getLimits(): DiscoveryLimits {
    return {
        maxIterations: readPositiveIntEnv('DISCOVERY_MAX_ITERATIONS', 20),
        maxResponseTokens: readPositiveIntEnv('DISCOVERY_MAX_RESPONSE_TOKENS', 4000),
        maxSteps: readPositiveIntEnv('DISCOVERY_MAX_STEPS', 20),
        maxTotalTokens: readPositiveIntEnv('DISCOVERY_MAX_TOTAL_TOKENS', 150000),
        timeoutMs: readPositiveIntEnv('DISCOVERY_TIMEOUT_MS', 320000),
    };
}

function usedTokens(usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
}): number {
    return usage.input_tokens +
        usage.output_tokens +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0);
}

export interface DiscoverRecipeResult {
    path: string;
    /** False when an existing cached recipe was reused instead of running discovery. */
    created: boolean;
}

export async function discoverRecipe(URL: string, allowedAction: string, parameters: TaskParameters): Promise<DiscoverRecipeResult> {

    let recipePath: string = doesRecipeExist(allowedAction, URL);

    if (recipePath !== "") {
        return {path:recipePath, created: false};
    }

    const limits = getLimits();
    const abortController = new AbortController();
    const timeout = setTimeout(() => {
        abortController.abort(new Error(`Discovery timed out after ${limits.timeoutMs}ms.`));
    }, limits.timeoutMs);

    // Discovery only ever sees the allowed action, never the caller's raw
    // request text - that's what keeps the resulting recipe general enough
    // to be reused by any request that maps to the same allowed action.
    const session = new BrowserSession(process.env.HEADED === "1", {
        inputTask: allowedAction,
        inputUrl: URL,
        parameters,
    }, {
        maxRecordedSteps: limits.maxSteps,
    });
    let recipeSource = '';
    let escalatedDuringDiscovery = false;

    try {
        await session.start(URL);

        let totalTokens = 0;
        const runner = client.beta.messages.toolRunner({
            stream: false,
            model: "claude-opus-5",
            max_tokens: Math.min(limits.maxResponseTokens, limits.maxTotalTokens),
            thinking: { type: "adaptive" },
            max_iterations: limits.maxIterations,
            system:
                "You are driving a real browser to accomplish a task on a live website. " +
                "Call snapshot to see the page: it lists every visible element with a ref (e1, e2, ...). " +
                "Act on elements by ref. Call screenshot only when the text snapshot is visually ambiguous. " +
                "Refs change after every navigation, so take a fresh snapshot after each click. " +
                "When doing a retrieval type of action, once you have located the information the task asks for, call extract on the element " +
                "holding the value, then stop and state the value. " +
                "If you don't have enough information to proceed with any step then escalate to the human operator using escalateToHuman(). " +
                "Do not write any code -- the steps you take are recorded automatically.",
            tools: browserTools(session, { maxToolCalls: limits.maxSteps }),
            messages: [
                {
                    role: "user",
                    content: `Website: ${URL}\nTask: ${allowedAction}\n Task Parameters: ${JSON.stringify(parameters)}`,
                },
            ],
        }, {
            signal: abortController.signal,
        });

        for await (const message of runner) {
            totalTokens += usedTokens(message.usage);
            if (totalTokens > limits.maxTotalTokens) {
                abortController.abort(new Error(`Discovery token budget exceeded (${totalTokens}/${limits.maxTotalTokens}).`));
                throw new Error(`Discovery token budget exceeded (${totalTokens}/${limits.maxTotalTokens}).`);
            }
            console.log(message);
        }

        if (session.steps.length === 0) {
            throw new Error("Claude finished without performing any browser actions.");
        }
        // if (!session.steps.some((step) => step.action === 'extract')) {
        //     throw new Error("Claude finished without extracting the requested value.");
        // }
        console.log({parameters});

        recipeSource = generateRecipe(URL, allowedAction, parameters, session.steps);

        // The bank-balance template already reads directly from
        // context.parameters (see buildBankBalanceRecipe) by design, so only
        // the generic step-replay template needs this pass. Skip it entirely
        // if discovery ran with no parameters -- there's nothing to
        // parameterize and no reason to spend a model call.
        if (Object.keys(parameters ?? {}).length > 0 && normalizeAction(allowedAction) !== normalizeAction(BANK_BALANCE_ACTION)) {
            recipeSource = await parameterizeRecipeSource(recipeSource, parameters);
        }


    } catch (error) {
        escalatedDuringDiscovery = true;
        const reason = abortController.signal.aborted
            ? abortController.signal.reason
            : error;
        const reasonMessage = reason instanceof Error ? reason.message : String(reason);

        // The agent got stuck and can't resolve this on its own: leave the
        // live browser session open (session.close() is deferred to
        // onRelease, invoked only after the human operator lets go) so a
        // human operator can take over from exactly where discovery left off.
        await escalateToHuman({
            reason: `Recipe discovery could not complete automatically: ${reasonMessage}`,
            task: allowedAction,
            url: URL,
            allowedAction,
            parameters,
            collectedInfo: { steps: session.steps },
            sessionKeptAlive: true,
            onRelease: async () => {
                await session.close();
            },
        });
    } finally {
        clearTimeout(timeout);
        if (!escalatedDuringDiscovery) {
            await session.close();
        }
    }

    return {path: createRecipe(URL, allowedAction, recipeSource), created: true};

}

function createRecipe(url: string, allowedAction: string, playwrightSteps: string): string {
    let recipePath: string = recipePathFor(allowedAction, url);

    fs.mkdirSync(path.dirname(recipePath), { recursive: true });
    fs.writeFileSync(recipePath, playwrightSteps);
    return recipePath;

}

// --- Recipe code generation (compiles recorded Steps into a recipe .ts file) ---

const BANK_BALANCE_ACTION = 'retrieve bank account balance details';

function generateRecipe(
    url: string,
    allowedAction: string,
    parameters: TaskParameters,
    steps: Step[],
): string {
    if (normalizeAction(allowedAction) === normalizeAction(BANK_BALANCE_ACTION)) {
        return buildBankBalanceRecipe(url, allowedAction, parameters);
    }

    const body = steps.map(render).join('\n');
    return `// Generated by Discovery.ts -- do not edit by hand.
// Action: ${allowedAction}
// Site: ${url}
// Recorded: ${new Date().toISOString()}

import { recipeClick, recipeExtract, recipeFill, recipeGoto, recipePress, runRecipe, settle } from '../recipeRuntime.ts';
import type { RecipeOutcome } from '../recipeRuntime.ts';

export const TASK = ${JSON.stringify(allowedAction)};
export const ACTION = ${JSON.stringify(allowedAction)};
export const URL = ${JSON.stringify(url)};

export async function runAction(context: { recipePath?: string; inputTask?: string; inputUrl?: string; parameters?: Record<string, unknown>; onHardFailure?: (info: { message: string; step?: string; expected?: string; observed?: string }, closeBrowser: () => Promise<void>) => Promise<void> } = {}): Promise<RecipeOutcome> {
    return runRecipe(async (page, out) => {
${body}
    }, {
        headed: process.env.HEADED === "1",
        recipe: context.recipePath,
        recipeTask: ACTION,
        recipeUrl: URL,
        inputTask: context.inputTask,
        inputUrl: context.inputUrl,
        parameters: context.parameters,
        onHardFailure: context.onHardFailure,
    });
}
`;
}

function buildBankBalanceRecipe(url: string, allowedAction: string, parameters: TaskParameters): string {
    return `// Generated by Discovery.ts -- do not edit by hand.
// Action: ${allowedAction}
// Site: ${url}
// Recorded: ${new Date().toISOString()}

import { recipeCheckpoint, recipeClick, recipeExtract, recipeGoto, runRecipe, settle } from '../recipeRuntime.ts';
import { businessOutcome } from '../recipeRuntime.ts';
import type { RecipeOutcome, Selector } from '../recipeRuntime.ts';

export const TASK = ${JSON.stringify(allowedAction)};
export const ACTION = ${JSON.stringify(allowedAction)};
export const URL = ${JSON.stringify(url)};

interface AccountConfig {
    label: string;
    anchors: string[];
    outputKey: string;
}

const ACCOUNTS: AccountConfig[] = [
    {
        label: 'Savings',
        anchors: ['Saving Account Activity', 'Savings Account', 'SAVINGS'],
        outputKey: 'savings_balance',
    },
    {
        label: 'Checking',
        anchors: ['Checking Account Activity', 'Checking Account', 'CHECKING'],
        outputKey: 'checking_balance',
    },
];

function balanceSelectors(account: AccountConfig): Selector[] {
    return account.anchors.flatMap((anchor) => [
        { kind: 'within', anchorText: anchor, ancestor: 'mat-card', css: '.balance' },
        { kind: 'within', anchorText: anchor, ancestor: 'mat-card', css: 'div' },
        { kind: 'within', anchorText: anchor, ancestor: 'div', css: '.balance' },
    ]);
}

async function extractBalance(
    page: Parameters<typeof recipeGoto>[0],
    account: AccountConfig,
): Promise<string> {
    return recipeExtract(page, balanceSelectors(account), \`\${account.label} account balance\`);
}

/**
 * If the caller asked for a specific account type, requesting something
 * this recipe doesn't know how to look up (e.g. "credit card") is a
 * legitimate business outcome, not a crash: the recipe genuinely has no
 * way to answer that question, distinct from a runtime failure.
 */
function requestedAccounts(parameters: Record<string, unknown> | undefined): AccountConfig[] {
    const requested = parameters?.accountType ?? parameters?.account ?? parameters?.accountScope;
    if (typeof requested !== 'string' || requested.trim().length === 0) {
        return ACCOUNTS;
    }

    const normalized = requested.trim().toLowerCase();
    const matches = ACCOUNTS.filter((account) => account.label.toLowerCase() === normalized);
    if (matches.length === 0) {
        businessOutcome(
            'unsupported_account_type',
            \`This recipe only supports Savings and Checking accounts; "\${requested}" is not one of them.\`,
            { requested, supported: ACCOUNTS.map((account) => account.label) },
        );
    }
    return matches;
}

export async function runAction(
    context: { recipePath?: string; inputTask?: string; inputUrl?: string; parameters?: Record<string, unknown>; onHardFailure?: (info: { message: string; step?: string; expected?: string; observed?: string }, closeBrowser: () => Promise<void>) => Promise<void> } = {},
): Promise<RecipeOutcome> {
    const targetUrl = context.inputUrl && context.inputUrl.trim().length > 0 ? context.inputUrl : URL;
    const accounts = requestedAccounts(context.parameters);

    return runRecipe(async (page, out) => {
        await recipeGoto(page, targetUrl);
        await settle(page);
        await recipeClick(
            page,
            [
                { kind: 'role', role: 'button', name: 'GET STARTED NOW' },
                { kind: 'text', value: 'GET STARTED NOW' },
            ],
            'button "GET STARTED NOW"',
        );
        await settle(page);
        // Checkpoint: confirm the dashboard actually loaded before trusting
        // any balance we're about to read off it.
        await recipeCheckpoint(
            page,
            [
                { kind: 'text', value: 'Saving Account Activity' },
                { kind: 'text', value: 'Checking Account Activity' },
            ],
            'dashboard loaded after GET STARTED NOW',
        );

        for (const account of accounts) {
            out[account.outputKey] = (await extractBalance(page, account)).trim();
        }
    }, {
        headed: process.env.HEADED === '1',
        recipe: context.recipePath,
        recipeTask: ACTION,
        recipeUrl: URL,
        inputTask: context.inputTask,
        inputUrl: context.inputUrl,
        parameters: context.parameters,
        onHardFailure: context.onHardFailure,
    });
}
`;
}

// --- Recipe parameterization (replaces hardcoded, discovery-time values
// with references to context.parameters, so the recipe generalizes to other
// inputs instead of only ever replaying the one value used during
// discovery) ---

/**
 * Asks the LLM to rewrite a freshly generated recipe so any literal copied
 * from the discovery-time parameters (e.g. a member ID typed into a form
 * while discovering the flow) is replaced with a reference to
 * `context.parameters` instead - so the cached recipe can be replayed with
 * different parameter values rather than always re-entering whatever value
 * happened to be used during the one discovery run that created it.
 *
 * This is model-authored code, so it is never trusted blindly: the
 * rewritten source must still export the expected shape and must actually
 * load without a syntax/structural error (checked via a real dynamic
 * import, not just string matching) before it replaces the original. If it
 * fails validation for any reason, the original, unparameterized-but-known-
 * good recipeSource is used instead - a less reusable recipe beats a broken
 * one.
 */
async function parameterizeRecipeSource(
    recipeSource: string,
    parameters: TaskParameters,
): Promise<string> {
    let rewritten: string;
    try {
        const response = await client.messages.create({
            model: 'claude-opus-5',
            max_tokens: 4000,
            thinking: { type: 'disabled' },
            messages: [
                {
                    role: 'user',
                    content:
                        'The text below is a generated TypeScript recipe file for a browser-automation replay ' +
                        'system. It was produced from one discovery run against a live site, using these input ' +
                        `parameters: ${JSON.stringify(parameters)}.\n\n` +
                        'Some literal values inside the file (for example, the "value" argument passed to ' +
                        'recipeFill) may be copies of these parameter values, hardcoded from that one run. ' +
                        'Rewrite the file so every such literal is replaced with a reference to the parameter ' +
                        'it came from, read off context.parameters (e.g. ' +
                        'String(context.parameters?.memberId ?? "<original literal>")), so the recipe can be ' +
                        'replayed with different parameter values in the future instead of only ever reusing ' +
                        'the value from this one discovery run.\n\n' +
                        'Also, rewrite it so that it removes hardcoding in terms of how many times a particular action should be done.\n' +
                        '(eg. if an action is add new recipient named Watson, it should be generalised to work for multiple recipients not just one. We cannot assume a set number of recipients.)\n' +
                        'Also, make sure that there is no fallbacks in the code: if there is no parameter provided, the code should throw an error or exception.\n' + 
                        'Do not change anything else: selectors used to locate elements, control flow, ' +
                        'imports, and exports must stay exactly as they are, and any literal that is NOT a ' +
                        'copy of one of the parameters above (e.g. fixed site text, button labels) must also ' +
                        'stay exactly as it is. If none of the parameters appear as hardcoded literals, return ' +
                        'the file unchanged. Return only the full, updated file contents - no explanation, no ' +
                        'markdown code fences.\n\n' +
                        `\`\`\`ts\n${recipeSource}\n\`\`\``,
                },
            ],
        });
        rewritten = stripMarkdownFence(extractResponseText(response.content));
    } catch (error) {
        console.warn(
            `Skipping recipe parameterization: model call failed (${error instanceof Error ? error.message : String(error)}). ` +
            'Using the unparameterized recipe.',
        );
        return recipeSource;
    }

    if (!(await isValidRecipeSource(rewritten))) {
        console.warn('Skipping recipe parameterization: rewritten recipe failed validation. Using the unparameterized recipe.');
        return recipeSource;
    }

    return rewritten;
}

function extractResponseText(content: Array<{ type: string; text?: string }>): string {
    return content
        .filter((block): block is { type: string; text: string } => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim();
}

function stripMarkdownFence(source: string): string {
    const fenced = source.match(/^```(?:ts|typescript)?\n([\s\S]*?)\n```$/);
    return fenced ? fenced[1].trim() : source.trim();
}

/**
 * Validates model-rewritten recipe source before it's trusted: checks the
 * required exports are textually present, then actually loads it (via a
 * throwaway file under recipes/, since the generated code's imports --
 * '../recipeRuntime.ts' etc. -- are relative to that directory) to catch
 * any syntax or structural error the rewrite introduced. The throwaway
 * file is always removed afterward, whether validation passed or failed.
 */
async function isValidRecipeSource(source: string): Promise<boolean> {
    if (!source || source.trim().length === 0) {
        return false;
    }
    const requiredMarkers = ['export const TASK', 'export const ACTION', 'export const URL', 'export async function runAction'];
    if (!requiredMarkers.every((marker) => source.includes(marker))) {
        return false;
    }

    const tempPath = path.join('recipes', `.tmp-parameterize-${process.pid}-${Date.now()}.ts`);
    try {
        fs.mkdirSync(path.dirname(tempPath), { recursive: true });
        fs.writeFileSync(tempPath, source);
        const loaded = await import(pathToFileURL(path.resolve(tempPath)).href + `?t=${Date.now()}`);
        return typeof loaded.runAction === 'function';
    } catch {
        return false;
    } finally {
        fs.rmSync(tempPath, { force: true });
    }
}

function render(step: Step): string {
    const pad = '        ';
    switch (step.action) {
        case 'goto':
            return (
                `${pad}await recipeGoto(page, ${JSON.stringify(step.url)});\n` +
                `${pad}await settle(page);`
            );
        case 'click':
            return (
                `${pad}await recipeClick(page, ${json(step.selectors)}, ${JSON.stringify(step.description)});\n` +
                `${pad}await settle(page);`
            );
        case 'fill':
            return `${pad}await recipeFill(page, ${json(step.selectors)}, ${JSON.stringify(step.description)}, ${JSON.stringify(step.value)});`;
        case 'press':
            return `${pad}await recipePress(page, ${JSON.stringify(step.key)});\n${pad}await settle(page);`;
        case 'extract':
            return (
                `${pad}out[${JSON.stringify(step.name)}] = (await recipeExtract(page, ${json(step.selectors)}, ` +
                `${JSON.stringify(step.description)})).trim();`
            );
    }
}

function json(value: unknown): string {
    return JSON.stringify(value);
}

function normalizeAction(value: string): string {
    return value.toLowerCase().replace(/\s+/g, ' ').trim();
}
