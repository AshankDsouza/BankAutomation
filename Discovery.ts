/**
 * CLI entrypoint. Wires the layers from re_architecture.md together in
 * order: AllowedListScreening -> Recipe Mapping -> Recipe Making ->
 * Recipe Execution -> User Request Processing, escalating to a human
 * (Human Escalation Layer) whenever a layer can't proceed automatically.
 */
import { classifyTask, CONFIDENCE_SCORE_THRESHOLD } from './layers/allowedListScreening.ts';
import { configureRunLogFile } from './layers/recipeMapping.ts';
import { discoverRecipe } from './layers/recipeMaking.ts';
import { executeCachedRecipe } from './layers/recipeExecution.ts';
import { processUserRequest } from './layers/userRequestProcessing.ts';
import { escalateToHuman, HumanEscalationError } from './layers/escalation.ts';

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

    configureRunLogFile(allowedResponse.action!);

    const recipePath = await discoverRecipe(url, task, allowedResponse.action!, allowedResponse.parameters);

    const result = await executeCachedRecipe(recipePath, task, url, allowedResponse.parameters);

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
