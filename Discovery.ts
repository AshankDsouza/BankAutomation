/**
 * CLI entrypoint. Wires the layers from re_architecture.md together in
 * order: AllowedListScreening -> Recipe Mapping -> Recipe Making ->
 * Recipe Execution -> User Request Processing, escalating to a human
 * (Human Escalation Layer) whenever a layer can't proceed automatically.
 */
import { classifyTask, CONFIDENCE_SCORE_THRESHOLD, stripCodeFence } from './layers/allowedListScreening.ts';
import { configureRunLogFile } from './layers/recipeMapping.ts';
import { discoverRecipe } from './layers/recipeMaking.ts';
import { executeCachedRecipe, ExecutionOutcome } from './layers/recipeExecution.ts';
import { processUserRequest } from './layers/userRequestProcessing.ts';
import { escalateToHuman, HumanEscalationError } from './layers/escalation.ts';
import { classifyActionRisk, confirmRiskyAction } from './safety.ts';
import { client } from './llmClient.ts';
import type { TaskParameters } from './taskTypes.ts';
import fs from 'fs';

/**
 * A cached recipe is shared across every request that maps to the same
 * allowed action, so the parameters extracted once at initial screening
 * (from whichever phrasing first triggered discovery) can't be assumed to
 * apply to this request too - a later caller may use different wording, or
 * supply/omit different values. Instead of reusing the original screening's
 * parameters, this reads the recipe's own source to see which
 * `context.parameters` keys it actually reads, then asks the LLM to pull
 * exactly those values back out of *this* request. Recipes with no
 * parameter references (nothing to extract) skip the LLM call entirely.
 */
async function extractParametersFromRecipe(recipePath: string, task: string): Promise<TaskParameters> {
    const recipeSource = fs.readFileSync(recipePath, 'utf8');

    if (!recipeSource.includes('context.parameters')) {
        return {};
    }

    const response = await client.messages.create({
        model: 'claude-opus-5',
        max_tokens: 300,
        thinking: { type: 'disabled' },
        messages: [
            {
                role: 'user',
                content: `You are given the source of a cached browser-automation recipe and a new user request that will be satisfied by replaying it.

Recipe source:
\`\`\`ts
${recipeSource}
\`\`\`

User request: "${task}"

The recipe reads some of its inputs from context.parameters (e.g. context.parameters?.memberId). Read the recipe source to see exactly which parameter keys it looks up, then extract the value for each of those keys from the user request below.

Rules:
- Only include keys the recipe source actually reads off context.parameters.
- Only include a key if the user request actually supplies a value for it; omit any key the request doesn't mention.
- Never invent a value that isn't present in the user request.
- Return JSON only.

Output format:
{ "<parameter name>": "<value from user request>" }`,
            },
        ],
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
        throw new Error('Parameter extraction returned no text output.');
    }

    const raw = stripCodeFence(textBlock.text);
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(`Parameter extraction returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Parameter extraction must return a JSON object.');
    }

    return parsed as TaskParameters;
}

// This is the "main" function that ties every layer together for one request.
async function executeRecipe(url: string, task: string): Promise<void> {

    const allowedResponse = await classifyTask(task);

    if (allowedResponse.action === null || allowedResponse.confidence < CONFIDENCE_SCORE_THRESHOLD) {
        // No browser session exists yet at this point (screening happens
        // before discovery), so there is nothing to keep alive here.
        await escalateToHuman({
            reason: allowedResponse.action === null
                ? `Task "${task}" did not match any allowed action.`
                : `Task "${task}" matched "${allowedResponse.action}" but confidence ${allowedResponse.confidence} is below the ${CONFIDENCE_SCORE_THRESHOLD} threshold.`,
            task,
            url,
            allowedAction: allowedResponse.action,
            confidence: allowedResponse.confidence,
            parameters: allowedResponse.parameters,
            sessionKeptAlive: false,
        });
    }

    // Risky actions (see risky_actions.txt) require an explicit human
    // confirmation, typed at the terminal, before any browser session is
    // opened - not a pre-set flag that could be left on unattended.
    if (classifyActionRisk(allowedResponse.action!) === 'risky' && !(await confirmRiskyAction(allowedResponse.action!, task))) {
        await escalateToHuman({
            reason: `Action "${allowedResponse.action}" is classified as risky and was not confirmed at the terminal.`,
            task,
            url,
            allowedAction: allowedResponse.action,
            confidence: allowedResponse.confidence,
            parameters: allowedResponse.parameters,
            sessionKeptAlive: false,
        });
    }

    configureRunLogFile(allowedResponse.action!);

    const {path: recipePath, created: wasJustCreated} = await discoverRecipe(url, allowedResponse.action!, allowedResponse.parameters);

    // since the recipe was not just created, we need to extract the parameters from it so that parameter extracting matches what the recipe needs
    if (!wasJustCreated) {
        allowedResponse.parameters = await extractParametersFromRecipe(recipePath, task);
    }else{
        // Since the recipe was just created the task was also executed and there is no need execute it again. 
        console.log('Task was executed as part of recipe discovery.');
        return;
    }

    const outcome = await executeCachedRecipe(recipePath, task, url, allowedResponse.parameters);

    if (outcome.kind === 'business_outcome') {
        // A legitimate answer, not a crash: report it and exit cleanly.
        console.log(outcome.message);
        return;
    }

    const result = outcome.result;

    if (allowedResponse.isInformationRetrieval) {
        console.log(await processUserRequest(task, result));
        return;
    }

    const entries = Object.entries(result);
    console.log(entries.length === 1 ? entries[0][1] : entries.map(([key, value]) => `${key}: ${value}`).join('\n'));
}



const [, , url, task] = process.argv;

if (!url || !task) {
    console.error('Usage: npx tsx Discovery.ts "<url>" "<task>"');
    process.exit(1);
}

executeRecipe(url, task).catch((err) => {
    if (err instanceof HumanEscalationError) {
        console.error(`\nEscalated to a human agent: ${err.context.reason}`);
        if (err.context.sessionKeptAlive) {
            console.error('The browser session has been left open for a human operator to take over.');
        }
        process.exit(2);
    }
    console.error(err);
    process.exit(1);
});
