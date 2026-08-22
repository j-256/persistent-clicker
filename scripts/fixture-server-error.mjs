export const FIXTURE_SERVER_ERROR_BODY = "Internal server error";

export function sendFixtureServerError(response, error, logger = console) {
  logger.error("Fixture server request failed:", error);
  response.writeHead(500, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8"
  });
  response.end(FIXTURE_SERVER_ERROR_BODY);
}
