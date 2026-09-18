import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import type { BrowserSession } from './browser.ts';

/**
 * The browser, exposed to Claude as tools.
 *
 * `snapshot` is the primary sense: a text listing of everything visible, each
 * line carrying a ref to act on. `screenshot` returns the actual rendered
 * pixels for the cases where layout matters and text does not convey it.
 * Every acting tool records a replayable step as a side effect.
 */
/** Set DEBUG=1 to print every tool call and its result. */
function log(name: string, input: unknown, result: string): string {
    if (process.env.DEBUG === '1') {
        console.error(`\n[${name}] ${JSON.stringify(input)}\n${result.slice(0, 1200)}`);
    }
    return result;
}

export function browserTools(session: BrowserSession) {
    return [
        betaZodTool({
            name: 'snapshot',
            description:
                'List every visible element on the current page with a ref (e1, e2, ...), its role and its text. ' +
                'Take a fresh snapshot after every navigation -- refs from an older snapshot go stale.',
            inputSchema: z.object({}),
            run: async () => log('snapshot', {}, await session.snapshot()),
        }),

        betaZodTool({
            name: 'screenshot',
            description:
                'Look at the rendered page as an image. Use when the snapshot text is visually ambiguous ' +
                '(overlapping dialogs, which of two identical labels is which, layout questions).',
            inputSchema: z.object({}),
            run: async () => [
                {
                    type: 'image' as const,
                    source: {
                        type: 'base64' as const,
                        media_type: 'image/png' as const,
                        data: await session.screenshot(),
                    },
                },
            ],
        }),

        betaZodTool({
            name: 'click',
            description: 'Click the element with the given ref.',
            inputSchema: z.object({
                ref: z.string().describe('Element ref from the latest snapshot, e.g. "e12"'),
            }),
            run: async ({ ref }) => log('click', { ref }, await session.click(ref)),
        }),

        betaZodTool({
            name: 'fill',
            description: 'Type a value into the input with the given ref.',
            inputSchema: z.object({
                ref: z.string().describe('Element ref from the latest snapshot'),
                value: z.string().describe('Text to type'),
            }),
            run: async ({ ref, value }) => log('fill', { ref, value }, await session.fill(ref, value)),
        }),

        betaZodTool({
            name: 'press',
            description: 'Press a keyboard key, e.g. "Enter" or "Escape".',
            inputSchema: z.object({ key: z.string() }),
            run: async ({ key }) => log('press', { key }, await session.press(key)),
        }),

        betaZodTool({
            name: 'extract',
            description:
                'Record the text of the element with the given ref as an output of this flow. ' +
                'Call this on the element holding the value the task asked for.',
            inputSchema: z.object({
                ref: z.string().describe('Element ref from the latest snapshot'),
                name: z
                    .string()
                    .describe('Name for this value in the result, e.g. "savings_balance"'),
            }),
            run: async ({ ref, name }) => log('extract', { ref, name }, await session.extract(ref, name)),
        }),
    ];
}
