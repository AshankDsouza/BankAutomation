/**
 * AllowedListScreening Layer (re_architecture.md).
 *
 * Checks whether a natural-language user request matches one of the allowed
 * actions in allowed.txt, and extracts the parameters ("ingredients") needed
 * to run the recipe for that action. If the request doesn't clearly match an
 * allowed action, the caller is expected to escalate to a human (Human
 * Escalation Layer) instead of proceeding.
 */
import fs from 'fs';
import { client } from '../llmClient.ts';
import type { TaskParameters } from '../taskTypes.ts';

export const CONFIDENCE_SCORE_THRESHOLD = 0.85;

export interface IConfidenceResponse {
    action: string | null;
    confidence: number;
    parameters: TaskParameters;
    isInformationRetrieval: boolean;
}

export function normalizeTaskText(value: string): string {
    return value.toLowerCase().replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
}

function isTaskParameters(value: unknown): value is TaskParameters {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripCodeFence(source: string): string {
    return source
        .trim()
        .replace(/^```(?:typescript|ts)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
}

export async function classifyTask(task: string): Promise<IConfidenceResponse> {
    const allowedList = fs
        .readFileSync('allowed.txt', 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    const normalizedAllowed = allowedList.map(normalizeTaskText);

    const checkIsAllowedPrompt = `You are a task classifier.

The user will provide a natural-language request.
Determine whether the request matches one of the allowed tasks and extract the parameters needed to run the recipe.

Allowed tasks:
${allowedList.map((task, index) => `${index + 1}. ${task}`).join('\n')}

User request: "${task}"

Rules:
- Select an allowed task only when the user's request clearly corresponds to it.
- Do not infer an action that is not explicitly supported by the allowed task.
- If no allowed task matches, return null.
- Return a confidence between 0 and 1.
- Confidence represents your confidence that the classification is correct, not how similar the wording is.
- Parameters must be an object containing only values explicitly provided by the user and needed to perform the selected action.
- Use an empty object when the request provides no action parameters.
- Set isInformationRetrieval to true only when the selected action retrieves information for the user to read.
- Return JSON only.

Output format:
Return a JSON object with exactly these keys:
{
  "action": "<matched allowed task text or null>",
  "confidence": <number between 0 and 1>,
  "parameters": { "<parameter name>": "<parameter value>" },
  "isInformationRetrieval": <boolean>
}`;

    const response = await client.messages.create({
        model: 'claude-opus-5',
        max_tokens: 300,
        thinking: { type: 'disabled' },
        messages: [
            {
                role: 'user',
                content: checkIsAllowedPrompt,
            },
        ],
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    if (!textBlock) {
        throw new Error('Task classifier returned no text output.');
    }

    let parsed: IConfidenceResponse;
    const raw = stripCodeFence(textBlock.text);
    try {
        parsed = JSON.parse(raw) as IConfidenceResponse;
    } catch (error) {
        throw new Error(
            `Task classifier returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    if (
        typeof parsed.confidence !== 'number' ||
        !Number.isFinite(parsed.confidence) ||
        parsed.confidence < 0 ||
        parsed.confidence > 1
    ) {
        throw new Error('Task classifier response must contain a confidence between 0 and 1.');
    }

    if (!isTaskParameters(parsed.parameters)) {
        throw new Error('Task classifier response must contain a parameters object.');
    }

    if (parsed.action !== null && typeof parsed.action !== 'string') {
        throw new Error('Task classifier response action must be a string or null.');
    }

    if (typeof parsed.isInformationRetrieval !== 'boolean') {
        throw new Error('Task classifier response must contain an isInformationRetrieval boolean.');
    }

    if (parsed.action === null) {
        return parsed;
    }

    const normalizedAction = normalizeTaskText(parsed.action);
    const actionMatchesAllowed = normalizedAllowed.some((allowedTask) => allowedTask === normalizedAction);
    if (!actionMatchesAllowed) {
        return {
            action: null,
            confidence: parsed.confidence,
            parameters: parsed.parameters,
            isInformationRetrieval: parsed.isInformationRetrieval,
        };
    }

    return parsed;
}
