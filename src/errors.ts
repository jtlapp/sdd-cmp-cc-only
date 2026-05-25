// Error model from PRD §15.6.
//
// All error responses use the JSON envelope
//   { "error": { "code": <string>, "message": <string>, "details"?: <object> } }
// with the HTTP status determined by the code via the §15.6 mapping.

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export type ApiErrorCode =
  | "validation_error"
  | "forbidden"
  | "not_found"
  | "conflict";

export const STATUS_BY_CODE: Record<ApiErrorCode, ContentfulStatusCode> = {
  validation_error: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
};

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ApiErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function errorBody(
  code: ApiErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ApiErrorBody {
  const body: ApiErrorBody = { error: { code, message } };
  if (details !== undefined) {
    body.error.details = details;
  }
  return body;
}

export function httpError(
  c: Context,
  code: ApiErrorCode,
  message: string,
  details?: Record<string, unknown>,
) {
  return c.json(errorBody(code, message, details), STATUS_BY_CODE[code]);
}
