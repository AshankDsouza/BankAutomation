import fs from 'fs';
import path from 'path';
import type { Page } from 'playwright';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
type LogPayload = Record<string, unknown>;

export interface PlaywrightLogMetadata {
    phase: 'discovery' | 'replay';
    recipe?: string;
    recipeTask?: string;
    recipeUrl?: string;
    inputTask?: string;
    inputUrl?: string;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
    DEBUG: 10,
    INFO: 20,
    WARN: 30,
    ERROR: 40,
};

let logStream: fs.WriteStream | undefined;
let resolvedLogFilePath: string | undefined;
let runTimestamp: string | undefined;

function configuredLevel(): LogLevel {
    const candidate = process.env.LOG_LEVEL?.toUpperCase();
    if (candidate === 'DEBUG' || candidate === 'INFO' || candidate === 'WARN' || candidate === 'ERROR') {
        return candidate;
    }
    return 'INFO';
}

function shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[configuredLevel()];
}

function timestampForFilename(): string {
    if (!runTimestamp) {
        runTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
    }
    return runTimestamp;
}

function sanitizeSegment(value: string): string {
    const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    return normalized || 'run';
}

function recipeSegment(recipePath: string | undefined): string {
    if (!recipePath) {
        return 'unknown-recipe';
    }
    const withoutExt = recipePath.replace(/\.ts$/i, '');
    const afterRecipes = withoutExt.replace(/^.*recipes[\\/]/i, '');
    const parts = afterRecipes.split(/[\\/]/).filter(Boolean).map(sanitizeSegment);
    return parts.length > 0 ? parts.join('__') : 'unknown-recipe';
}

function ensureLogStream(payload: LogPayload): fs.WriteStream {
    if (logStream) {
        return logStream;
    }

    const configured = typeof process.env.LOG_FILE === 'string' && process.env.LOG_FILE.length > 0
        ? process.env.LOG_FILE
        : path.join('logs', `${recipeSegment(payload.recipe as string | undefined)}__${timestampForFilename()}.log`);

    resolvedLogFilePath = path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
    fs.mkdirSync(path.dirname(resolvedLogFilePath), { recursive: true });
    logStream = fs.createWriteStream(resolvedLogFilePath, { flags: 'a' });
    return logStream;
}

function writeLogLine(line: string, payload: LogPayload): void {
    console.error(line);
    try {
        ensureLogStream(payload).write(line + '\n');
    } catch (error) {
        console.error(
            JSON.stringify({
                ts: new Date().toISOString(),
                level: 'WARN',
                event: 'logger.file_write_failed',
                logFile: resolvedLogFilePath ?? process.env.LOG_FILE ?? '',
                error: error instanceof Error ? error.message : String(error),
            }),
        );
    }
}

function emit(level: LogLevel, event: string, payload: LogPayload): void {
    if (!shouldLog(level)) {
        return;
    }
    writeLogLine(
        JSON.stringify({
            ts: new Date().toISOString(),
            level,
            event,
            ...payload,
        }),
        payload,
    );
}

async function snapshotPreview(page?: Page): Promise<string> {
    if (!page) {
        return '';
    }
    try {
        const html = await page.content();
        const singleLine = html.replace(/\s+/g, ' ').trim();
        return singleLine.length > 1600 ? `${singleLine.slice(0, 1600)}…` : singleLine;
    } catch {
        return '';
    }
}

export class PlaywrightCommandLogger {
    private stepCounter = 0;
    private metadata: PlaywrightLogMetadata;

    constructor(metadata: PlaywrightLogMetadata) {
        this.metadata = metadata;
    }

    setMetadata(next: Partial<PlaywrightLogMetadata>): void {
        this.metadata = { ...this.metadata, ...next };
    }

    async run<T>(
        command: string,
        action: () => Promise<T>,
        options: { page?: Page; details?: Record<string, unknown> } = {},
    ): Promise<T> {
        const step = ++this.stepCounter;
        emit('INFO', 'playwright.command.start', {
            step,
            command,
            ...this.metadata,
            details: options.details ?? {},
        });

        try {
            const result = await action();
            const domSnapshot = await snapshotPreview(options.page);
            emit('INFO', 'playwright.command.finish', {
                step,
                command,
                ...this.metadata,
                details: options.details ?? {},
                domSnapshot,
            });
            return result;
        } catch (error) {
            const domSnapshot = await snapshotPreview(options.page);
            emit('ERROR', 'playwright.command.error', {
                step,
                command,
                ...this.metadata,
                details: options.details ?? {},
                domSnapshot,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    info(event: string, details: Record<string, unknown> = {}): void {
        emit('INFO', event, { ...this.metadata, details });
    }

    debug(event: string, details: Record<string, unknown> = {}): void {
        emit('DEBUG', event, { ...this.metadata, details });
    }
}
