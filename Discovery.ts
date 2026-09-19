
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { BrowserSession } from './browser.ts';
import { browserTools } from './tools.ts';
import { generateRecipe } from './codegen.ts';

const CONFIDENCE_SCORE_THRESHOLD = 0.85;

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

function discoveryLimits(): DiscoveryLimits {
    return {
        maxIterations: readPositiveIntEnv('DISCOVERY_MAX_ITERATIONS', 20),
        maxResponseTokens: readPositiveIntEnv('DISCOVERY_MAX_RESPONSE_TOKENS', 4000),
        maxSteps: readPositiveIntEnv('DISCOVERY_MAX_STEPS', 20),
        maxTotalTokens: readPositiveIntEnv('DISCOVERY_MAX_TOTAL_TOKENS', 50000),
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

function loadEnvFile(envPath: string = ".env"): void {
    if (!fs.existsSync(envPath)) {
        return;
    }

    const envContent = fs.readFileSync(envPath, "utf8");

    for (const line of envContent.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            continue;
        }

        const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match) {
            continue;
        }

        const [, key, rawValue] = match;
        if (process.env[key] !== undefined) {
            continue;
        }

        let value = rawValue.trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }

        process.env[key] = value;
    }
}

loadEnvFile();

// Resolves credentials from the environment: ANTHROPIC_API_KEY,
// ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile.
const client = new Anthropic();

// Both the domain and the task become path segments, so strip anything that
// would make an unusable filename.
function recipePathFor(url: string, task: string): string {
    const domain = new URL(url).hostname;
    const slug = task.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return path.join("recipes", domain, slug + ".ts");
}

function timestampForFilename(): string {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function sanitizeSegment(value: string): string {
    const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return normalized || 'run';
}

function configureRunLogFile(allowedAction: string): void {
    if (process.env.LOG_FILE && process.env.LOG_FILE.trim().length > 0) {
        return;
    }

    process.env.LOG_FILE = path.join('logs', `${sanitizeSegment(normalizeTaskText(allowedAction))}_${timestampForFilename()}.log`);
}

function doesRecipeExist(URL: string, task: string): string {
    const recipePath = recipePathFor(URL, task);
    return fs.existsSync(recipePath) ? recipePath : "";
}


async function discoverRecipe(URL: string, task: string): Promise<string> {

    let recipePath: string = doesRecipeExist(URL, task);

    if (recipePath !== "") {
        return recipePath;
    }

    const limits = discoveryLimits();
    const abortController = new AbortController();
    const timeout = setTimeout(() => {
        abortController.abort(new Error(`Discovery timed out after ${limits.timeoutMs}ms.`));
    }, limits.timeoutMs);

    const session = new BrowserSession(process.env.HEADED === "1", {
        inputTask: task,
        inputUrl: URL,
    }, {
        maxRecordedSteps: limits.maxSteps,
    });

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
                "Do not write any code -- the steps you take are recorded automatically.",
            tools: browserTools(session, { maxToolCalls: limits.maxSteps }),
            messages: [
                {
                    role: "user",
                    content: `Website: ${URL}\nTask: ${task}`,
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
        }
    } catch (error) {
        if (abortController.signal.aborted) {
            const reason = abortController.signal.reason;
            throw reason instanceof Error ? reason : new Error(String(reason));
        }
        throw error;
    } finally {
        clearTimeout(timeout);
        await session.close();
    }

    if (session.steps.length === 0) {
        throw new Error("Claude finished without performing any browser actions.");
    }
    if (!session.steps.some((step) => step.action === 'extract')) {
        throw new Error("Claude finished without extracting the requested value.");
    }

    fs.writeFileSync("PlaywrightStepsTemporaryFile.ts", generateRecipe(URL, task, session.steps));

    return createRecipe(URL, task);

}


function createRecipe(url: string, task: string): string {
    let recipePath: string = recipePathFor(url, task);

    const playwrightSteps = fs.readFileSync('PlaywrightStepsTemporaryFile.ts', 'utf8');
    fs.mkdirSync(path.dirname(recipePath), { recursive: true });
    fs.writeFileSync(recipePath, playwrightSteps);
    return recipePath;

}

interface IConfidenceResponse {
    action: string | null;
    confidence: number;
}

function normalizeTaskText(value: string): string {
    return value.toLowerCase().replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
}

async function isTaskAllowed(task: string): Promise<IConfidenceResponse> {
    const allowedList = fs
        .readFileSync('allowed.txt', 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    const normalizedTask = normalizeTaskText(task);
    const normalizedAllowed = allowedList.map(normalizeTaskText);

    const directMatch = allowedList.find(
        (allowedTask) => {
            const normalizedAllowedTask = normalizeTaskText(allowedTask);
            return normalizedTask === normalizedAllowedTask ||
                normalizedTask.includes(normalizedAllowedTask) ||
                normalizedAllowedTask.includes(normalizedTask);
        },
    );
    if (directMatch) {
        return { action: directMatch, confidence: 1 };
    }

    const detailsLookupAction = allowedList.find((allowedTask) =>
        normalizeTaskText(allowedTask).includes('retrieve bank details'),
    );
    if (detailsLookupAction && /(balance|details?)/.test(normalizedTask) && /(account|bank)/.test(normalizedTask)) {
        return { action: detailsLookupAction, confidence: 1 };
    }

    const checkIsAllowedPrompt = `You are a task classifier.

The user will provide a natural-language request.
Determine whether the request matches one of the allowed tasks.

Allowed tasks:
${allowedList.map((task, index) => `${index + 1}. ${task}`).join('\n')}

User request: "${task}"

Rules:
- Select an allowed task only when the user's request clearly corresponds to it.
- Do not infer an action that is not explicitly supported by the allowed task.
- If no allowed task matches, return null.
- Return a confidence between 0 and 1.
- Confidence represents your confidence that the classification is correct, not how similar the wording is.
- Return JSON only.

Output format:
Return a JSON object with exactly these keys:
{
  "action": "<matched allowed task text or null>",
  "confidence": <number between 0 and 1>
}`;

    const response = await client.messages.create({
        model: "claude-opus-5",
        max_tokens: 300,
        thinking: { type: 'disabled' },
        messages: [
            {
                role: "user",
                content: checkIsAllowedPrompt,
            },
        ],
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    if (!textBlock) {
        throw new Error('Task classifier returned no text output.');
    }

    let parsed: IConfidenceResponse;
    const raw = textBlock.text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
    try {
        parsed = JSON.parse(raw) as IConfidenceResponse;
    } catch (error) {
        throw new Error(
            `Task classifier returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    if (typeof parsed.confidence !== 'number') {
        throw new Error('Task classifier response is missing a numeric confidence.');
    }

    if (parsed.action === null) {
        return parsed;
    }

    const normalizedAction = normalizeTaskText(parsed.action);
    const actionMatchesAllowed = normalizedAllowed.some((allowedTask) => allowedTask === normalizedAction);
    if (!actionMatchesAllowed) {
        return { action: null, confidence: parsed.confidence };
    }

    return parsed;
}

// This is the "main" function that will be called to execute the recipe

async function executeRecipe(url: string, task: string): Promise<void> {

    const allowedResponse: IConfidenceResponse = await isTaskAllowed(task);

    if (allowedResponse.action === null || allowedResponse.confidence < CONFIDENCE_SCORE_THRESHOLD) {
        console.error(`Task "${task}" is not allowed. Confidence: ${allowedResponse.confidence}`);
        throw new Error(`Task "${task}" is not allowed. Confidence: ${allowedResponse.confidence}`);
    }

    configureRunLogFile(allowedResponse.action);

    let recipePath: string = await discoverRecipe(url, task);

    // A bare relative path is treated as a package name by import(), so resolve
    // it to an absolute file:// URL first.
    const recipe = await import(pathToFileURL(path.resolve(recipePath)).href);

    if (typeof recipe.runAction !== "function") {
        throw new Error(`${recipePath} does not export a runAction() function`);
    }

    const result = await recipe.runAction({
        recipePath,
        inputTask: task,
        inputUrl: url,
    });
    const entries = Object.entries(result);
    if (entries.length === 0) {
        throw new Error(`${recipePath} completed without extracting any values.`);
    }

    if (entries.length === 1) {
        console.log(entries[0][1]);
    } else {
        console.log(entries.map(([key, value]) => `${key}: ${value}`).join('\n'));
    }

    return;


}


const [, , url, task] = process.argv;

if (!url || !task) {
    console.error('Usage: npx tsx Discovery.ts "<url>" "<task>"');
    process.exit(1);
}

executeRecipe(url, task).catch((err) => {
    console.error(err);
    process.exit(1);
});
