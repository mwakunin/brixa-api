import * as HttpStatusPhrases from "stoker/http-status-phrases";
import { createMessageObjectSchema } from "stoker/openapi/schemas";

export const notFoundSchema = createMessageObjectSchema(HttpStatusPhrases.NOT_FOUND);
export const unauthorizedSchema = createMessageObjectSchema(HttpStatusPhrases.UNAUTHORIZED);
export const forbiddenSchema = createMessageObjectSchema(HttpStatusPhrases.FORBIDDEN);
export const badRequestSchema = createMessageObjectSchema(HttpStatusPhrases.BAD_REQUEST);

/**
 * The header that names the facility a request acts in (CLAUDE.md §4). A
 * header rather than a session field, so two tabs can work in two facilities
 * and a request queued offline still names the facility it was made in.
 */
export const FACILITY_HEADER = "x-facility-id";
