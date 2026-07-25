/**
 * API version identifier emitted on every JSON response (Requirement 9.8).
 *
 * `API_VERSION` is the URL-path major version — every loyalty operation lives
 * under `/v1` (Requirement 9.1). Breaking changes are reserved for a future
 * `/v2`; changes within v1 are additive-only.
 */
export const API_VERSION = "v1" as const;

/**
 * The header used to surface the version identifier on every response.
 */
export const API_VERSION_HEADER = "x-api-version";

/**
 * The JSON envelope field name carrying the version identifier.
 */
export const API_VERSION_FIELD = "apiVersion";
