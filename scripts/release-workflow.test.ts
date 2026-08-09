import { expect, test } from "bun:test";

const releaseWorkflow = await Bun.file(".github/workflows/release.yml").text();
const tagReleaseWorkflow = await Bun.file(
  ".github/workflows/tag-release.yml",
).text();

test("reusable releases prefer the explicit tag input", () => {
  expect(releaseWorkflow).toContain("workflow_dispatch:");
  expect(releaseWorkflow).toContain(
    `RELEASE_TAG: \${{ inputs.release_tag || github.ref_name }}`,
  );
  expect(releaseWorkflow).not.toContain("github.event_name == 'workflow_call'");
});

test("package releases pass the resolved tag to the release workflow", () => {
  expect(tagReleaseWorkflow).toContain(
    `release_tag: \${{ needs.prepare.outputs.tag }}`,
  );
});
