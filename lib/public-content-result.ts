export type PublicContentResult<T> =
  | { status: "ready"; data: T }
  | { status: "error"; data: T };

export function publicContentReady<T>(data: T): PublicContentResult<T> {
  return { status: "ready", data };
}

export function publicContentError<T>(data: T): PublicContentResult<T> {
  return { status: "error", data };
}
