import { describe, expect, it } from "vitest";
import {
  CailError,
  extractCailError,
  parseCailError,
} from "../src/index.js";

const baseError = {
  message: "The request was denied.",
  type: "invalid_request_error",
  code: "request_denied",
};

async function parseEnvelope(error: Record<string, unknown>) {
  return parseCailError(
    Response.json(
      { error },
      {
        status: 400,
        headers: {
          "x-request-id": "11111111-1111-4111-8111-111111111111",
        },
      },
    ),
  );
}

describe("CAIL error envelope parser parity", () => {
  it.each([
    { name: "null param", param: null },
    { name: "string param", param: "model" },
  ])("accepts the same canonical $name through both entry points", async ({
    param,
  }) => {
    const envelope = { error: { ...baseError, param } };
    const responseError = await parseEnvelope(envelope.error);
    const extractedError = extractCailError(envelope);

    expect(responseError).toBeInstanceOf(CailError);
    expect(extractedError).toBeInstanceOf(CailError);
    expect(responseError).toMatchObject({
      code: "request_denied",
      type: "invalid_request_error",
      param,
      status: 400,
    });
    expect(extractedError).toMatchObject({
      code: "request_denied",
      type: "invalid_request_error",
      param,
      status: 0,
    });
  });

  it.each([
    { name: "missing param", error: { ...baseError } },
    { name: "numeric param", error: { ...baseError, param: 1 } },
    { name: "object param", error: { ...baseError, param: {} } },
  ])("rejects the same malformed $name through both entry points", async ({
    error,
  }) => {
    const responseError = await parseEnvelope(error);

    expect(responseError).toMatchObject({
      code: "unknown_error",
      type: "unknown_error",
      param: null,
      status: 400,
    });
    expect(extractCailError({ error })).toBeNull();
  });
});
