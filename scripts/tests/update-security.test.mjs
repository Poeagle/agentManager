import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertValidVersion,
  parseChecksum,
  validateArchive,
  validateArchiveEntryNames,
} from "../../cli.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(testDir, "..", "..");

test("release versions reject path and shell metacharacters", () => {
  assert.equal(assertValidVersion("1.2.3-beta.1"), "1.2.3-beta.1");
  for (const value of ["latest", "1.2", "1.2.3/../../tmp", "1.2.3;touch-x", "v1.2.3", "1.2.3+build", "1.2.3-a..b"]) {
    assert.throws(() => assertValidVersion(value), /Invalid release version/);
  }
});

test("checksum parser binds a digest to the expected asset name", () => {
  const digest = "a".repeat(64);
  assert.equal(parseChecksum(`${digest}  agentmanager-v1.2.3.tar.gz\n`, "agentmanager-v1.2.3.tar.gz"), digest);
  assert.throws(
    () => parseChecksum(`${digest}  another-file.tar.gz\n`, "agentmanager-v1.2.3.tar.gz"),
    /Checksum is for/,
  );
  assert.throws(() => parseChecksum("not-a-checksum", "release.tar.gz"), /invalid/);
});

test("archive entry validation confines every entry to one versioned root", () => {
  validateArchiveEntryNames(
    ["agentmanager-v1.2.3/", "agentmanager-v1.2.3/server/dist/index.js"],
    "agentmanager-v1.2.3",
  );
  for (const entries of [
    ["../escape"],
    ["/absolute/path"],
    ["agentmanager-v1.2.3/../../escape"],
    ["agentmanager-v1.2.3\\..\\escape"],
    ["another-root/file"],
  ]) {
    assert.throws(
      () => validateArchiveEntryNames(entries, "agentmanager-v1.2.3"),
      /archive entry|Unsafe archive entry/i,
    );
  }
});

test("real archive validation accepts files and rejects symbolic links", () => {
  const workDir = mkdtempSync(join(tmpdir(), "agentmanager-archive-test-"));
  try {
    const releaseRoot = join(workDir, "agentmanager-v1.2.3");
    mkdirSync(join(releaseRoot, "server", "dist"), { recursive: true });
    writeFileSync(join(releaseRoot, "server", "dist", "index.js"), "export {};\n");
    const goodArchive = join(workDir, "good.tar.gz");
    execFileSync("tar", ["-czf", goodArchive, "-C", workDir, "agentmanager-v1.2.3"]);
    assert.equal(validateArchive(goodArchive, "1.2.3"), "agentmanager-v1.2.3");

    symlinkSync("../../outside", join(releaseRoot, "server", "escape"));
    const linkedArchive = join(workDir, "linked.tar.gz");
    execFileSync("tar", ["-czf", linkedArchive, "-C", workDir, "agentmanager-v1.2.3"]);
    assert.throws(() => validateArchive(linkedArchive, "1.2.3"), /regular files and directories/);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("shell installer keeps verification and rollback gates", () => {
  const installer = readFileSync(join(rootDir, "scripts", "install.sh"), "utf8");
  assert.match(installer, /AGENTMANAGER_ARCHIVE_SHA256/);
  assert.match(installer, /ROLLBACK_ARMED=true/);
  assert.match(installer, /Installing server dependencies in staging/);
  assert.doesNotMatch(installer, /rm -rf "\$INSTALL_DIR"/);
  execFileSync("bash", ["-n", join(rootDir, "scripts", "install.sh")]);
  execFileSync("bash", ["-n", join(rootDir, "scripts", "build-archive.sh")]);
});
