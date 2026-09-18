
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { BrowserSession } from './browser.ts';
import { browserTools } from './tools.ts';
import { generateRecipe } from './codegen.ts';

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

function doesRecipeExist(URL: string, task: string): string {
    const recipePath = recipePathFor(URL, task);
    return fs.existsSync(recipePath) ? recipePath : "";
}


async function discoverRecipe(URL: string, task: string): Promise<string> {

    let recipePath: string = doesRecipeExist(URL, task);

    if (recipePath !== "") {
        return recipePath;
    }

    const session = new BrowserSession(process.env.HEADED === "1");
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

// This is the "main" function that will be called to execute the recipe

async function executeRecipe(url: string, task: string): Promise<void> {

    let recipePath: string = await discoverRecipe(url, task);

    // A bare relative path is treated as a package name by import(), so resolve
    // it to an absolute file:// URL first.
    const recipe = await import(pathToFileURL(path.resolve(recipePath)).href);

    if (typeof recipe.runAction !== "function") {
        throw new Error(`${recipePath} does not export a runAction() function`);
    }

    const result = await recipe.runAction();
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
