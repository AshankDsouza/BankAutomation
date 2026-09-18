import { chromium } from 'playwright';
import type { Browser, Page, Locator } from 'playwright';
import { PlaywrightCommandLogger } from './logger.ts';
import type { PlaywrightLogMetadata } from './logger.ts';

/**
 * A durable way to find one element, independent of where it currently sits on
 * the page. Discovery records several per element and replay tries them in
 * order, so a flow survives cosmetic DOM churn.
 */
export type Selector =
    | { kind: 'testId'; value: string }
    | { kind: 'role'; role: string; name: string }
    | { kind: 'label'; value: string }
    | { kind: 'placeholder'; value: string }
    | { kind: 'text'; value: string }
    | { kind: 'css'; value: string }
    // Scoped to a container identified by its own visible text, e.g. the card
    // titled "Saving Account Activity". Keeps ".balance" unambiguous on a page
    // with several balances.
    | { kind: 'within'; anchorText: string; ancestor: string; css: string };

export type Step =
    | { action: 'goto'; url: string }
    | { action: 'click'; selectors: Selector[]; description: string }
    | { action: 'fill'; selectors: Selector[]; description: string; value: string }
    | { action: 'press'; key: string }
    | { action: 'extract'; selectors: Selector[]; description: string; name: string };

/** What the in-page collector returns for one element. */
interface RawCandidates {
    description: string;
    testId?: string;
    role?: string;
    name?: string;
    label?: string;
    placeholder?: string;
    text?: string;
    css?: string;
    within?: { anchorText: string; ancestor: string; css: string };
}

const REF_ATTR = 'data-bg-ref';

/**
 * Drives a real browser for Claude and records every successful action as a
 * replayable step. The recording is the point: the model's job is to find the
 * path once, and what it touched becomes the artifact.
 */
export class BrowserSession {
    private browser!: Browser;
    private page!: Page;
    private readonly logger: PlaywrightCommandLogger;
    readonly steps: Step[] = [];

    constructor(private readonly headed: boolean = false, metadata: Omit<PlaywrightLogMetadata, 'phase'> = {}) {
        this.logger = new PlaywrightCommandLogger({ phase: 'discovery', ...metadata });
    }

    async start(url: string): Promise<void> {
        this.logger.setMetadata({ inputUrl: url, recipeUrl: url });
        this.browser = await this.logger.run(
            'chromium.launch',
            async () => chromium.launch({ headless: !this.headed }),
            { details: { headless: !this.headed } },
        );
        this.page = await this.logger.run('browser.newPage', async () => this.browser.newPage());
        await this.goto(url);
    }

    async close(): Promise<void> {
        if (!this.browser) {
            return;
        }
        await this.logger.run('browser.close', async () => this.browser.close(), { page: this.page });
    }

    async goto(url: string): Promise<string> {
        await this.logger.run(
            'page.goto',
            async () => this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }),
            { page: this.page, details: { url, waitUntil: 'domcontentloaded', timeout: 30000 } },
        );
        await this.settle();
        this.steps.push({ action: 'goto', url });
        return `Navigated to ${this.page.url()}`;
    }

    /** Angular re-renders after navigation, so give the route a moment to paint. */
    private async settle(): Promise<void> {
        await this.logger.run('page.waitForTimeout', async () => this.page.waitForTimeout(2000), {
            page: this.page,
            details: { timeoutMs: 2000 },
        });
        await this.logger.run('page.waitForLoadState', async () => this.page.waitForLoadState('domcontentloaded'), {
            page: this.page,
            details: { state: 'domcontentloaded' },
        });
    }

    /**
     * Tag every visible, useful element with a ref and return a compact text
     * view of the page. This is Claude's primary way of seeing -- it is what a
     * screen reader would convey, and every line carries a ref it can act on.
     */
    async snapshot(): Promise<string> {
        const lines = await this.logger.run(
            'page.evaluate(snapshot)',
            async () =>
                this.page.evaluate((refAttr) => {
                    const INTERACTIVE = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],mat-select';
                    const out: string[] = [];
                    let n = 0;

                    document.querySelectorAll(`[${refAttr}]`).forEach((el) => el.removeAttribute(refAttr));

                    const visible = (el: Element): boolean => {
                        const r = el.getBoundingClientRect();
                        const s = getComputedStyle(el);
                        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
                    };

                    const roleOf = (el: Element): string => {
                        const explicit = el.getAttribute('role');
                        if (explicit) return explicit;
                        const tag = el.tagName.toLowerCase();
                        if (tag === 'a') return 'link';
                        if (tag === 'button') return 'button';
                        if (tag === 'select' || tag === 'mat-select') return 'combobox';
                        if (tag === 'textarea') return 'textbox';
                        if (tag === 'input') {
                            const t = (el as HTMLInputElement).type;
                            if (t === 'checkbox') return 'checkbox';
                            if (t === 'radio') return 'radio';
                            if (t === 'submit' || t === 'button') return 'button';
                            return 'textbox';
                        }
                        return '';
                    };

                    const nameOf = (el: Element): string =>
                        (el.getAttribute('aria-label') || (el as HTMLElement).innerText || '')
                            .replace(/\s+/g, ' ')
                            .trim()
                            .slice(0, 80);

                    const tag = (el: Element, line: (ref: string) => string): void => {
                        const ref = 'e' + ++n;
                        el.setAttribute(refAttr, ref);
                        out.push(line(ref));
                    };

                    document.querySelectorAll(INTERACTIVE).forEach((el) => {
                        if (!visible(el)) return;
                        const role = roleOf(el) || el.tagName.toLowerCase();
                        const name = nameOf(el);
                        const ph = el.getAttribute('placeholder');
                        tag(el, (ref) => `${ref} ${role} "${name}"${ph ? ` placeholder="${ph}"` : ''}`);
                    });

                    // Leaf text nodes: these are what an extraction reads. A balance on
                    // this kind of app is often an unlabeled div, so include them.
                    document.querySelectorAll('body *').forEach((el) => {
                        if (el.children.length > 0 || !visible(el)) return;
                        if (el.hasAttribute(refAttr) || el.closest(INTERACTIVE)) return;
                        const text = ((el as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim();
                        if (!text || text.length > 120) return;
                        const card = el.closest('mat-card,section,article,form,li,tr');
                        const heading = card?.querySelector('mat-card-title,h1,h2,h3,h4,[class*="title"]');
                        const context = heading ? ` (in "${(heading as HTMLElement).innerText.trim().slice(0, 60)}")` : '';
                        tag(el, (ref) => `${ref} text "${text}"${context}`);
                    });

                    return out;
                }, REF_ATTR),
            { page: this.page },
        );

        return `URL: ${this.page.url()}\n\n${lines.join('\n')}`;
    }

    /** A real screenshot, for when the text view is visually ambiguous. */
    async screenshot(): Promise<string> {
        const buffer = await this.logger.run('page.screenshot', async () => this.page.screenshot({ fullPage: false }), {
            page: this.page,
            details: { fullPage: false },
        });
        return buffer.toString('base64');
    }

    async click(ref: string): Promise<string> {
        const { locator, selectors, description } = await this.prepare(ref);
        await this.logger.run('locator.click', async () => locator.click({ timeout: 10000 }), {
            page: this.page,
            details: { ref, description, timeout: 10000 },
        });
        await this.settle();
        this.steps.push({ action: 'click', selectors, description });
        return `Clicked ${description}. Now at ${this.page.url()}. Call snapshot to see the new state.`;
    }

    async fill(ref: string, value: string): Promise<string> {
        const { locator, selectors, description } = await this.prepare(ref);
        await this.logger.run('locator.fill', async () => locator.fill(value, { timeout: 10000 }), {
            page: this.page,
            details: { ref, description, timeout: 10000 },
        });
        this.steps.push({ action: 'fill', selectors, description, value });
        return `Filled ${description}.`;
    }

    async press(key: string): Promise<string> {
        await this.logger.run('keyboard.press', async () => this.page.keyboard.press(key), {
            page: this.page,
            details: { key },
        });
        await this.settle();
        this.steps.push({ action: 'press', key });
        return `Pressed ${key}. Call snapshot to see the new state.`;
    }

    async extract(ref: string, name: string): Promise<string> {
        const { locator, selectors, description } = await this.prepare(ref);
        const text = (
            await this.logger.run('locator.innerText', async () => locator.innerText({ timeout: 10000 }), {
                page: this.page,
                details: { ref, name, description, timeout: 10000 },
            })
        ).trim();
        this.steps.push({ action: 'extract', selectors, description, name });
        return `Extracted ${name} = ${JSON.stringify(text)} from ${description}.`;
    }

    /**
     * Resolve a ref to a live locator, and work out how to find the same
     * element again tomorrow. Candidates are generated in the page, then
     * verified here -- anything matching zero or several elements is dropped,
     * because an ambiguous selector is worse than no selector.
     */
    private async prepare(ref: string): Promise<{ locator: Locator; selectors: Selector[]; description: string }> {
        const live = this.page.locator(`[${REF_ATTR}="${ref}"]`);
        if (
            (await this.logger.run('locator.count', async () => live.count(), {
                page: this.page,
                details: { ref, locator: `[${REF_ATTR}="${ref}"]` },
            })) !== 1
        ) {
            throw new Error(`ref ${ref} is stale -- call snapshot again to get current refs`);
        }

        const raw = await this.logger.run(
            'locator.evaluate(collect-selector-candidates)',
            async () =>
                live.evaluate((el: Element): RawCandidates => {
                    const text = ((el as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim();
                    const tagName = el.tagName.toLowerCase();

                    const cssFor = (node: Element): string => {
                        if (node.id) return `#${CSS.escape(node.id)}`;
                        const classes = Array.from(node.classList)
                            // Framework-generated and state classes churn between builds.
                            .filter((c) => !/^(ng-|cdk-|mat-focus|mat-ripple)/.test(c) && !/\d/.test(c))
                            .slice(0, 2);
                        return node.tagName.toLowerCase() + classes.map((c) => `.${CSS.escape(c)}`).join('');
                    };

                    const roleOf = (): string => {
                        const explicit = el.getAttribute('role');
                        if (explicit) return explicit;
                        if (tagName === 'a') return 'link';
                        if (tagName === 'button') return 'button';
                        if (tagName === 'textarea') return 'textbox';
                        if (tagName === 'select') return 'combobox';
                        if (tagName === 'input') {
                            const t = (el as HTMLInputElement).type;
                            if (t === 'checkbox' || t === 'radio') return t;
                            if (t === 'submit' || t === 'button') return 'button';
                            return 'textbox';
                        }
                        return '';
                    };

                    const labelText = ((): string | undefined => {
                        const id = el.getAttribute('id');
                        if (id) {
                            const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
                            if (lbl) return (lbl as HTMLElement).innerText.trim();
                        }
                        const wrapper = el.closest('label');
                        return wrapper ? (wrapper as HTMLElement).innerText.trim() : undefined;
                    })();

                    const within = ((): RawCandidates['within'] => {
                        const container = el.closest('mat-card,section,article,form,li,tr');
                        if (!container || container === el) return undefined;
                        const heading = container.querySelector('mat-card-title,h1,h2,h3,h4,[class*="title"]');
                        const anchorText = heading ? (heading as HTMLElement).innerText.trim() : '';
                        if (!anchorText) return undefined;
                        return {
                            anchorText: anchorText.slice(0, 60),
                            ancestor: container.tagName.toLowerCase(),
                            css: cssFor(el),
                        };
                    })();

                    const name = (el.getAttribute('aria-label') || text).slice(0, 60);

                    return {
                        description: `${roleOf() || tagName} "${(name || text).slice(0, 40)}"`,
                        testId: el.getAttribute('data-testid') ?? el.getAttribute('data-test') ?? undefined,
                        role: roleOf() || undefined,
                        name: name || undefined,
                        label: labelText,
                        placeholder: el.getAttribute('placeholder') ?? undefined,
                        text: text && text.length <= 60 ? text : undefined,
                        css: el.id ? `#${el.id}` : undefined,
                        within,
                    };
                }),
            { page: this.page, details: { ref } },
        );

        const candidates: Selector[] = [];
        if (raw.testId) candidates.push({ kind: 'testId', value: raw.testId });
        if (raw.role && raw.name) candidates.push({ kind: 'role', role: raw.role, name: raw.name });
        if (raw.label) candidates.push({ kind: 'label', value: raw.label });
        if (raw.placeholder) candidates.push({ kind: 'placeholder', value: raw.placeholder });
        if (raw.within) candidates.push({ kind: 'within', ...raw.within });
        if (raw.text) candidates.push({ kind: 'text', value: raw.text });
        if (raw.css) candidates.push({ kind: 'css', value: raw.css });

        const selectors: Selector[] = [];
        for (const candidate of candidates) {
            const locator = toLocator(this.page, candidate);
            const count = await this.logger
                .run('locator.count', async () => locator.count(), {
                    page: this.page,
                    details: { candidate },
                })
                .catch(() => 0);
            if (count === 1) selectors.push(candidate);
        }

        if (selectors.length === 0) {
            throw new Error(
                `No stable selector found for ${raw.description}. Pick an element with a name, label or heading near it.`,
            );
        }

        return { locator: live, selectors, description: raw.description };
    }
}

/** Shared by discovery (for verification) and by every generated recipe. */
export function toLocator(page: Page, selector: Selector): Locator {
    switch (selector.kind) {
        case 'testId':
            return page.getByTestId(selector.value);
        case 'role':
            return page.getByRole(selector.role as Parameters<Page['getByRole']>[0], {
                name: selector.name,
                exact: true,
            });
        case 'label':
            return page.getByLabel(selector.value, { exact: true });
        case 'placeholder':
            return page.getByPlaceholder(selector.value, { exact: true });
        case 'text':
            return page.getByText(selector.value, { exact: true });
        case 'css':
            return page.locator(selector.value);
        case 'within':
            return page
                .getByText(selector.anchorText, { exact: true })
                .first()
                .locator(`xpath=ancestor::${selector.ancestor}[1]`)
                .locator(selector.css);
    }
}
