import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FIXTURE_SERVER_ERROR_BODY,
  sendFixtureServerError
} from "../../scripts/fixture-server-error.mjs";

test("fixture server logs diagnostics without exposing them in the response", () => {
  let responseBody;
  let responseHeaders;
  let responseStatus;
  let loggedArguments;
  const diagnostic = new Error("sensitive diagnostic");
  const response = {
    writeHead(status, headers) {
      responseStatus = status;
      responseHeaders = headers;
    },
    end(body) {
      responseBody = body;
    }
  };
  const logger = {
    error(...args) {
      loggedArguments = args;
    }
  };

  sendFixtureServerError(response, diagnostic, logger);

  assert.equal(responseStatus, 500);
  assert.deepEqual(responseHeaders, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8"
  });
  assert.equal(responseBody, FIXTURE_SERVER_ERROR_BODY);
  assert.doesNotMatch(responseBody, /sensitive diagnostic/);
  assert.deepEqual(loggedArguments, ["Fixture server request failed:", diagnostic]);
});
