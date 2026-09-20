/**
 * Parameters extracted from a user request (the "ingredients" mentioned in
 * re_architecture.md's Recipe Execution Layer). Produced by the
 * AllowedListScreening Layer and threaded through Recipe Mapping, Recipe
 * Making, and Recipe Execution.
 */
export type TaskParameters = Record<string, unknown>;
