class HttpError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function badRequest(message = 'Bad request', details) {
  return new HttpError(400, 'bad_request', message, details);
}
function unauthorized(message = 'Unauthorized', details) {
  return new HttpError(401, 'unauthorized', message, details);
}
function forbidden(message = 'Forbidden', details) {
  return new HttpError(403, 'forbidden', message, details);
}
function notFound(message = 'Not found', details) {
  return new HttpError(404, 'not_found', message, details);
}
function conflict(message = 'Conflict', details) {
  return new HttpError(409, 'conflict', message, details);
}
function tooManyRequests(message = 'Too many requests', details) {
  return new HttpError(429, 'too_many_requests', message, details);
}
function internal(message = 'Internal server error', details) {
  return new HttpError(500, 'internal_error', message, details);
}

module.exports = {
  HttpError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  tooManyRequests,
  internal,
};
