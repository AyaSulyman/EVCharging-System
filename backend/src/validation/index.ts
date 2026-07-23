import { z } from "zod";

/**
 * Request validation at the API boundary.
 *
 * Validation previously existed only in the client, which is the one place a caller
 * controls, so the service accepted whatever it was sent. Parsing here gives two
 * things at once: shape checking, and field allowlisting — zod strips keys the schema
 * does not declare, so an update route physically cannot receive a field it was not
 * meant to change.
 */
export class ValidationError extends Error {
  readonly status = 400;
  readonly issues: { field: string; message: string }[];

  constructor(issues: { field: string; message: string }[]) {
    super("Invalid request");
    this.issues = issues;
  }
}

/** Parses and narrows a request body, throwing ValidationError on failure. */
export function parseBody<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((i) => ({
        field: i.path.join(".") || "(body)",
        message: i.message,
      }))
    );
  }
  return result.data;
}

export * from "./schemas";
