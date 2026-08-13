import { describe, expect, test } from "bun:test";
import {
  normalizeHttpMock,
  requestTarget,
  resolveHttpRequest,
  usesFullResponse,
} from "./http-request-contract.ts";

describe("HTTP Request contract", () => {
  test("redacts unsafe headers and raw bodies from current request evidence", () => {
    const request = resolveHttpRequest({
      method: "POST",
      url: "https://example.com/resources?signature=private-query",
      sendHeaders: true,
      specifyHeaders: "json",
      jsonHeaders: JSON.stringify({
        "Content-Type": "text/plain",
        "X-Custom": "private-header",
      }),
      sendBody: true,
      contentType: "raw",
      rawContentType: "text/plain",
      body: "private-body",
    });

    expect(request).toEqual({
      method: "POST",
      url: "https://example.com/resources?signature=%5BREDACTED%5D",
      headers: {
        "Content-Type": "text/plain",
        "X-Custom": "[REDACTED]",
      },
      body: { redacted: true, contentType: "text/plain" },
    });
    expect(JSON.stringify(request)).not.toContain("private-");
  });

  test("reconstructs legacy JSON parameters and fullResponse settings", () => {
    const request = resolveHttpRequest(
      {
        requestMethod: "PUT",
        url: "https://example.com/resources",
        jsonParameters: true,
        queryParametersJson: '{"view":"compact"}',
        headerParametersJson: '{"Accept":"application/json"}',
        bodyParametersJson: '{"state":"ready"}',
        options: { fullResponse: true, bodyContentType: "json" },
      },
      2,
    );
    expect(request).toEqual({
      method: "PUT",
      url: "https://example.com/resources?view=compact",
      headers: { Accept: "application/json" },
      body: { state: "ready" },
    });
    expect(
      usesFullResponse(
        { requestMethod: "PUT", options: { fullResponse: true } },
        2,
      ),
    ).toBe(true);
  });

  test("requires the complete full-response shape", () => {
    expect(
      normalizeHttpMock({ body: {}, statusCode: 200 }, true).warnings,
    ).toHaveLength(1);
    expect(
      normalizeHttpMock(
        { body: {}, headers: {}, statusCode: 200, statusMessage: "OK" },
        true,
      ).warnings,
    ).toEqual([]);
    expect(
      normalizeHttpMock({ body: {}, statusCode: 200 }, false).warnings,
    ).toEqual([]);
    expect(
      normalizeHttpMock(
        { body: {}, headers: {}, statusCode: 200, statusMessage: "OK" },
        false,
      ).warnings,
    ).toHaveLength(1);
  });

  test("limits pending diagnostics to the request origin", () => {
    expect(
      requestTarget(
        "https://example.com/hooks/private-path?code=private-query",
      ),
    ).toBe("https://example.com");
  });
});
