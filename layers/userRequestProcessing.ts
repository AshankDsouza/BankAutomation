/**
 * User Request Processing Layer (re_architecture.md).
 *
 * For information-retrieval requests, takes the (deliberately generalized)
 * result produced by the Recipe Execution Layer plus the original user
 * request, and asks the LLM to produce the specific, concise answer the user
 * asked for.
 */
import { client } from '../llmClient.ts';
import type { RecipeResult } from './recipeExecution.ts';

function extractText(content: Array<{ type: string; text?: string }>): string {
    return content
        .filter((block): block is { type: string; text: string } => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim();
}

export async function processUserRequest(task: string, result: RecipeResult): Promise<string> {
    console.log(`Processing user request: ${task}`);
    console.log(`Recipe result: ${JSON.stringify(result, null, 2)}`);
    const response = await client.messages.create({
        model: 'claude-opus-5',
        max_tokens: 300,
        thinking: { type: 'disabled' },
        messages: [
            {
                role: 'user',
                content: `Answer this user request using the context provided.

User request: ${JSON.stringify(task)}

Recipe result:
${JSON.stringify(result, null, 2)}

Return only the concise answer for the user. Do not mention unrelated information, context, or unavailable information.`,
            },
        ],
    });
    const text = extractText(response.content);
    if (!text) {
        throw new Error('User request processing returned no text output.');
    }
    return text;
}
