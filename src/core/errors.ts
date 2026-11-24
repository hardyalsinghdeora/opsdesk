/** Errors carry an HTTP status and a stable machine-readable code. */
export class OpsdeskError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class NotFoundError extends OpsdeskError {
  constructor(what: string) {
    super(404, "not_found", `${what} not found`);
  }
}

export class ValidationError extends OpsdeskError {
  constructor(message: string, details?: unknown) {
    super(422, "validation_failed", message, details);
  }
}

export class ToolDisabledError extends OpsdeskError {
  constructor(tool: string) {
    super(409, "tool_disabled", `Tool "${tool}" is not enabled for this company`);
  }
}

export class ConflictError extends OpsdeskError {
  constructor(code: string, message: string) {
    super(409, code, message);
  }
}

export class ForbiddenError extends OpsdeskError {
  constructor(message = "Not allowed") {
    super(403, "forbidden", message);
  }
}

export class ConfigError extends OpsdeskError {
  constructor(message: string, details?: unknown) {
    super(500, "config_invalid", message, details);
  }
}
