/**
 * Human Escalation Layer (see re_architecture.md).
 *
 * When the AllowedListScreening layer rejects a request, or the Recipe
 * Making/Execution layers get stuck in a way the agent cannot resolve on its
 * own, control is handed off here instead of just failing the run. If a live
 * browser session exists, it is left open (never closed) so a human operator
 * can pick up exactly where the AI agent stopped.
 */

export interface EscalationContext {
    /** Why the request is being escalated. */
    reason: string;
    task: string;
    url: string;
    /** The allowed action the classifier matched, if any. */
    allowedAction?: string | null;
    confidence?: number;
    parameters?: Record<string, unknown>;
    /** Anything already collected by the agent that a human can build on. */
    collectedInfo?: Record<string, unknown>;
    /** Whether a live browser session was kept open for hand-off. */
    sessionKeptAlive: boolean;
    /**
     * Called once the human operator signals they're done with the session
     * (Ctrl+C) so the caller can close the browser it kept open. Only
     * relevant when sessionKeptAlive is true.
     */
    onRelease?: () => Promise<void>;
}

/**
 * Placeholder for paging/notifying a human operator (e.g. Slack, PagerDuty,
 * a support ticket queue). For now this just logs the escalation context so
 * the hand-off point is visible and easy to wire up to a real channel later.
 */
export function notifyHumanAgent(context: EscalationContext): void {
    // here, later on we will send a notification to slack or microsoft teams or any other human operator channel
    console.warn('\n=== HUMAN ESCALATION ===');
    console.warn(JSON.stringify(context, null, 2));
    console.warn('=========================\n');
}

export class HumanEscalationError extends Error {
    readonly context: EscalationContext;

    constructor(context: EscalationContext) {
        super(`Escalated to human agent: ${context.reason}`);
        this.name = 'HumanEscalationError';
        this.context = context;
    }
}

/** Notifies the human agent and raises a HumanEscalationError to unwind the run. */
export async function escalateToHuman(context: EscalationContext): Promise<never> {
    notifyHumanAgent(context);

    if (context.sessionKeptAlive) {
        // Park here instead of exiting: the browser (and the Playwright
        // connection keeping it alive) must survive so a human operator can
        // take over the live session exactly where the agent left off.
        console.warn(
            'Browser session left open for hand-off. Take over the live browser window; ' +
            'press Ctrl+C in this terminal when you are done to close the session.',
        );

        await new Promise<void>((resolve) => {
            process.once('SIGINT', () => {
                console.warn('\nHuman operator released the session. Closing browser...');
                resolve();
            });
        });

        if (context.onRelease) {
            await context.onRelease();
        }
    }

    throw new HumanEscalationError(context);
}
