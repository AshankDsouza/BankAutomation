/**
 * Small startup/infra helper shared by every layer: loads `.env` into
 * `process.env` before anything else (e.g. the Anthropic client) reads it.
 */
import fs from 'fs';

export function loadEnvFile(envPath: string = '.env'): void {
    if (!fs.existsSync(envPath)) {
        return;
    }

    const envContent = fs.readFileSync(envPath, 'utf8');

    for (const line of envContent.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }

        const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match) {
            continue;
        }

        const [, key, rawValue] = match;
        if (process.env[key] !== undefined) {
            continue;
        }

        let value = rawValue.trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }

        process.env[key] = value;
    }
}
