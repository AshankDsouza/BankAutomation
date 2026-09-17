
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

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

    const PROMPT: string = "Using this website: " + URL + " and this task: " + task 
                        + ", excecute this task on the website using playwright and"
                        +" please store the playwright codegen steps to reproduce the action needed to be done "
                        +" and store it in the folder called recipes. "
                        + "You will do this by first adding it to the file PlaywrightStepsTemporaryFile.ts"

    const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model:  "llama-3.1-8b-instant",
            messages: [
                {
                    role: "user",
                    content: PROMPT,
                },
            ],
        }),
    });

    if (!groqResponse.ok) {
        throw new Error(`Groq request failed: ${groqResponse.status} ${await groqResponse.text()}`);
    }

    const groqCompletion = await groqResponse.json();
    const playwrightSteps = groqCompletion.choices?.[0]?.message?.content;

    if (!playwrightSteps) {
        throw new Error("Groq response did not include generated Playwright steps.");
    }

    fs.writeFileSync("PlaywrightStepsTemporaryFile.ts", playwrightSteps);

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

    await recipe.runAction();

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
