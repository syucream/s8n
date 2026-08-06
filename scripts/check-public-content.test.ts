import { describe, expect, test } from "bun:test";

import {
  findPublicContentRisks,
  isRiskyRepositoryPath,
} from "./check-public-content";

describe("findPublicContentRisks", () => {
  test("detects high-confidence credentials and local home paths", () => {
    const text = [
      `key=${"AKIA"}${"IOSFODNN7EXAMPLE"}`,
      `path=${"/Users"}/example/private/workflow.json`,
      `-----BEGIN ${"PRIVATE KEY"}-----`,
    ].join("\n");

    expect(findPublicContentRisks(text).map((match) => match.rule)).toEqual([
      "AWS access key",
      "absolute user home path",
      "private key material",
    ]);
  });

  test("does not flag documented placeholders or the local Slack oracle", () => {
    const text = [
      "https://api.example.com/users/123",
      "Bearer xoxb-s8n-quality-oracle",
      "/tmp/s8n-test/workflow.json",
    ].join("\n");

    expect(findPublicContentRisks(text)).toEqual([]);
  });
});

describe("isRiskyRepositoryPath", () => {
  test("rejects secret-bearing file names", () => {
    expect(isRiskyRepositoryPath(".env.local")).toBe(true);
    expect(isRiskyRepositoryPath("certificates/client.pem")).toBe(true);
    expect(isRiskyRepositoryPath("secrets/id_rsa")).toBe(true);
  });

  test("allows a documented environment template", () => {
    expect(isRiskyRepositoryPath(".env.example")).toBe(false);
  });
});
