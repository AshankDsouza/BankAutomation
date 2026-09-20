/**
 * Shared Anthropic client singleton. Every layer that talks to the model
 * (AllowedListScreening, Recipe Making, User Request Processing) imports
 * `client` from here instead of constructing its own -- one place to manage
 * credentials and env loading.
 */
import Anthropic from '@anthropic-ai/sdk';
import { loadEnvFile } from './env.ts';

loadEnvFile();

// Resolves credentials from the environment: ANTHROPIC_API_KEY,
// ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile.
export const client = new Anthropic();
