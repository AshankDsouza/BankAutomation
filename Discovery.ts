
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { BrowserSession } from './browser.ts';
import { browserTools } from './tools.ts';
import { generateRecipe } from './codegen.ts';

const CONFIDENCE_SCORE_THRESHOLD = 0.85;


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
    const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    return normalized || 'run';
}

function configureRunLogFile(url: string, task: string): void {
    if (process.env.LOG_FILE && process.env.LOG_FILE.trim().length > 0) {
        return;
    }

    const recipePath = recipePathFor(url, task).replace(/\.ts$/i, '');
    const recipeName = recipePath
        .replace(/^recipes[\\/]/i, '')
        .split(/[\\/]/)
        .filter(Boolean)
        .map(sanitizeSegment)
        .join('__') || 'unknown-recipe';

    process.env.LOG_FILE = path.join('logs', `${recipeName}__${timestampForFilename()}.log`);
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

    const session = new BrowserSession(process.env.HEADED === "1", {
        inputTask: task,
        inputUrl: URL,
    });
    await session.start(URL);

    try {
        await client.beta.messages.toolRunner({
            model: "claude-opus-5",
            max_tokens: 16000,
            thinking: { type: "adaptive" },
            max_iterations: 30,
            system:
                "You are driving a real browser to accomplish a task on a live website. " +
                "Call snapshot to see the page: it lists every visible element with a ref (e1, e2, ...). " +
                "Act on elements by ref. Call screenshot only when the text snapshot is visually ambiguous. " +
                "Refs change after every navigation, so take a fresh snapshot after each click. " +
                "When you have located the information the task asks for, call extract on the element " +
                "holding the value, then stop and state the value. " +
                "Do not write any code -- the steps you take are recorded automatically.",
            tools: browserTools(session),
            messages: [
                {
                    role: "user",
                    content: `Website: ${URL}\nTask: ${task}`,
                },
            ],
        });
    } finally {
        await session.close();
    }

    if (session.steps.length === 0) {
        throw new Error("Claude finished without performing any browser actions.");
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

async function isTaskAllowed(task: string): Promise<boolean> {
    const allowedList = fs
        .readFileSync('allowed.txt', 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    const normalizedTask = normalizeTaskText(task);
    const normalizedAllowed = allowedList.map(normalizeTaskText);

    const directMatch = normalizedAllowed.some(
        (allowedTask) =>
            normalizedTask === allowedTask ||
            normalizedTask.includes(allowedTask) ||
            allowedTask.includes(normalizedTask),
    );
    if (directMatch) {
        return true;
    }

    const allowsDetailsLookup = normalizedAllowed.some((allowedTask) => allowedTask.includes('retrieve bank details'));
    if (allowsDetailsLookup && /(balance|details?)/.test(normalizedTask) && /(account|bank)/.test(normalizedTask)) {
        return true;
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
        return false;
    }

    const normalizedAction = normalizeTaskText(parsed.action);
    const actionMatchesAllowed = normalizedAllowed.some((allowedTask) => normalizeTaskText(allowedTask) === normalizedAction);
    return actionMatchesAllowed && parsed.confidence >= CONFIDENCE_SCORE_THRESHOLD;
}

// This is the "main" function that will be called to execute the recipe

async function executeRecipe(url: string, task: string): Promise<void> {
    configureRunLogFile(url, task);

    const allowed = await isTaskAllowed(task);

    if (!allowed) {
        // log the error into the log file and throw an error
        console.error(`Task "${task}" is not allowed.`);
        throw new Error(`Task "${task}" is not allowed.`);
    }

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
