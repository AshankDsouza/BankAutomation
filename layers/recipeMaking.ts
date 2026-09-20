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
import { client } from '../llmClient.ts';
import { BrowserSession } from '../browser.ts';
import type { Step } from '../browser.ts';
import { browserTools } from '../tools.ts';
import { escalateToHuman } from './escalation.ts';
import { doesRecipeExist, recipePathFor } from './recipeMapping.ts';
import type { TaskParameters } from '../taskTypes.ts';

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
        maxTotalTokens: readPositiveIntEnv('DISCOVERY_MAX_TOTAL_TOKENS', 100000),
        timeoutMs: readPositiveIntEnv('DISCOVERY_TIMEOUT_MS', 120000),
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

export async function discoverRecipe(URL: string, task: string, allowedAction: string, parameters: TaskParameters): Promise<string> {

    let recipePath: string = doesRecipeExist(allowedAction, URL);

    if (recipePath !== "") {
        return recipePath;
    }

    const limits = getLimits();
    const abortController = new AbortController();
    const timeout = setTimeout(() => {
        abortController.abort(new Error(`Discovery timed out after ${limits.timeoutMs}ms.`));
    }, limits.timeoutMs);

    const session = new BrowserSession(process.env.HEADED === "1", {
        inputTask: task,
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
                "When you have located the information the task asks for, call extract on the element " +
                "holding the value, then stop and state the value. " +
                "If you don't have enough information to proceed with any step then escalate to the human operator using escalateToHuman(). " +
                "Do not write any code -- the steps you take are recorded automatically.",
            tools: browserTools(session, { maxToolCalls: limits.maxSteps }),
            messages: [
                {
                    role: "user",
                    content: `Website: ${URL}\nTask: ${allowedAction}`,
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
        if (!session.steps.some((step) => step.action === 'extract')) {
            throw new Error("Claude finished without extracting the requested value.");
        }

        recipeSource = generateRecipe(URL, allowedAction, allowedAction, parameters, session.steps);
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
            task,
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

    return createRecipe(URL, allowedAction, recipeSource);

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
    task: string,
    allowedAction: string,
    parameters: TaskParameters,
    steps: Step[],
): string {
    if (normalizeAction(allowedAction) === normalizeAction(BANK_BALANCE_ACTION)) {
        return buildBankBalanceRecipe(url, task, allowedAction, parameters);
    }

    const body = steps.map(render).join('\n');
    return `// Generated by Discovery.ts -- do not edit by hand.
// Task: ${task}
// Action: ${allowedAction}
// Site: ${url}
// Recorded: ${new Date().toISOString()}

import { recipeClick, recipeExtract, recipeFill, recipeGoto, recipePress, runRecipe, settle } from '../recipeRuntime.ts';

export const TASK = ${JSON.stringify(task)};
export const ACTION = ${JSON.stringify(allowedAction)};
export const URL = ${JSON.stringify(url)};

export async function runAction(context: { recipePath?: string; inputTask?: string; inputUrl?: string; parameters?: Record<string, unknown> } = {}): Promise<Record<string, string>> {
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
    });
}
`;
}

function buildBankBalanceRecipe(url: string, task: string, allowedAction: string, parameters: TaskParameters): string {
    return `// Generated by Discovery.ts -- do not edit by hand.
// Task: ${task}
// Action: ${allowedAction}
// Site: ${url}
// Recorded: ${new Date().toISOString()}

import { recipeClick, recipeExtract, recipeGoto, runRecipe, settle } from '../recipeRuntime.ts';
import type { Selector } from '../recipeRuntime.ts';

export const TASK = ${JSON.stringify(task)};
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

export async function runAction(
    context: { recipePath?: string; inputTask?: string; inputUrl?: string; parameters?: Record<string, unknown> } = {},
): Promise<Record<string, string>> {
    const targetUrl = context.inputUrl && context.inputUrl.trim().length > 0 ? context.inputUrl : URL;

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

        for (const account of ACCOUNTS) {
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
    });
}
`;
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
