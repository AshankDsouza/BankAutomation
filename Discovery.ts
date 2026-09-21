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
import { classifyActionRisk, confirmRiskyAction } from './safety.ts';

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

    const recipePath = await discoverRecipe(url, allowedResponse.action!, allowedResponse.parameters);

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
