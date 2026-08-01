#!/usr/bin/env node
// AgentManager CLI — thin npm wrapper
// Checks version, updates if needed (via tarball download), launches the app.
// No delegation to install.sh for updates — avoids recursive loops and signal issues.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const INSTALL_DIR = resolve(process.env.AGENTMANAGER_INSTALL_DIR || join(homedir(), "agentmanager"));
const GITHUB_REPO = "ai-genius-automations/agentmanager";
const LOCAL_CLI = join(INSTALL_DIR, "bin", "agentmanager");

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const NC = "\x1b[0m";

function log(color, msg) {
  console.log(`${color}[AgentManager]${NC} ${msg}`);
}

function isInstalled() {
  return existsSync(LOCAL_CLI) && existsSync(join(INSTALL_DIR, "server", "dist"));
}

function getPackageVersion() {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf8")).version || null;
  } catch { return null; }
}

function getLocalVersion() {
  try {
    return JSON.parse(readFileSync(join(INSTALL_DIR, "version.json"), "utf8")).version || null;
  } catch { return null; }
}

function isNewer(a, b) {
  if (!a || !b) return false;
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

export function assertValidVersion(version) {
  if (typeof version !== "string" ||
      !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)) {
    throw new Error(`Invalid release version: ${String(version)}`);
  }
  return version;
}

function assertSafeInstallDir(installDir) {
  const target = resolve(installDir);
  const home = resolve(homedir());
  if (target === parse(target).root || target === home) {
    throw new Error(`Unsafe install directory: ${target}`);
  }
  if (existsSync(target) && (!existsSync(join(target, "version.json")) ||
      !existsSync(join(target, "bin", "agentmanager")) ||
      !existsSync(join(target, "server")))) {
    throw new Error(`Refusing to replace a directory that is not an AgentManager installation: ${target}`);
  }
  return target;
}

function acquireInstallLock(parentDir) {
  const lockDir = join(parentDir, ".agentmanager-install.lock");
  const create = () => {
    mkdirSync(lockDir, { mode: 0o700 });
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { mode: 0o600 });
  };
  try {
    create();
  } catch (error) {
    let ownerAlive = false;
    try {
      const owner = JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8"));
      if (Number.isSafeInteger(owner.pid) && owner.pid > 1) {
        process.kill(owner.pid, 0);
        ownerAlive = true;
      }
    } catch { /* stale or malformed lock */ }
    if (ownerAlive) throw new Error("Another AgentManager install or update is already running");
    rmSync(lockDir, { recursive: true, force: true });
    create();
  }
  return () => rmSync(lockDir, { recursive: true, force: true });
}

function run(command, args, options = {}) {
  return execFileSync(command, args, options);
}

function tryRun(command, args, options = {}) {
  try {
    return run(command, args, options);
  } catch {
    return null;
  }
}

function hashFile(path) {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

export function parseChecksum(text, expectedFilename) {
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-fA-F]{64})(?:\s+\*?([^\s]+))?$/);
    if (!match) continue;
    if (match[2] && basename(match[2]) !== expectedFilename) {
      throw new Error(`Checksum is for ${match[2]}, expected ${expectedFilename}`);
    }
    return match[1].toLowerCase();
  }
  throw new Error("Release checksum file is invalid");
}

export function validateArchiveEntryNames(names, expectedRoot) {
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error("Release archive is empty");
  }
  for (const rawName of names) {
    const name = rawName.replace(/\/$/, "");
    if (!name || name.includes("\\") || name.startsWith("/") || name.includes("\0")) {
      throw new Error(`Unsafe archive entry: ${rawName}`);
    }
    const parts = name.split("/");
    if (parts.some((part) => !part || part === "." || part === "..") || parts[0] !== expectedRoot) {
      throw new Error(`Archive entry escapes ${expectedRoot}: ${rawName}`);
    }
  }
}

export function validateArchive(archivePath, version) {
  assertValidVersion(version);
  const expectedRoot = `agentmanager-v${version}`;
  const names = run("tar", ["-tzf", archivePath], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).split(/\r?\n/).filter(Boolean);
  validateArchiveEntryNames(names, expectedRoot);

  const verbose = run("tar", ["-tvzf", archivePath], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).split(/\r?\n/).filter(Boolean);
  for (const line of verbose) {
    const type = line.trimStart()[0];
    if (type !== "-" && type !== "d") {
      throw new Error("Release archive may only contain regular files and directories");
    }
  }
  return expectedRoot;
}

function verifyStagedInstall(stagedDir, version) {
  const versionPath = join(stagedDir, "version.json");
  const installedVersion = JSON.parse(readFileSync(versionPath, "utf8")).version;
  if (installedVersion !== version) {
    throw new Error(`Archive version mismatch: expected ${version}, got ${String(installedVersion)}`);
  }
  for (const required of [
    join(stagedDir, "bin", "agentmanager"),
    join(stagedDir, "server", "dist", "index.js"),
    join(stagedDir, "server", "package.json"),
    join(stagedDir, "server", "package-lock.json"),
  ]) {
    if (!existsSync(required)) throw new Error(`Archive is missing ${required.slice(stagedDir.length + 1)}`);
  }
}

function installDependencies(stagedDir) {
  const serverDir = join(stagedDir, "server");
  log(CYAN, "Installing dependencies in staging...");
  tryRun("npm", ["ci", "--omit=dev", "--prefix", serverDir], {
    cwd: stagedDir,
    stdio: "inherit",
  });
  run("npm", ["ls", "--omit=dev", "--depth=0", "--prefix", serverDir], {
    cwd: stagedDir,
    stdio: "pipe",
  });

  const nativeCheck = ["-e", "require('better-sqlite3'); require('node-pty-prebuilt-multiarch')"];
  if (!tryRun(process.execPath, nativeCheck, { cwd: serverDir, stdio: "pipe" })) {
    log(CYAN, "Rebuilding native modules for current Node...");
    run("npm", ["rebuild", "better-sqlite3", "node-pty-prebuilt-multiarch", "--prefix", serverDir], {
      stdio: "inherit",
    });
  }
  run(process.execPath, nativeCheck, { cwd: serverDir, stdio: "pipe" });
}

function serviceCommand(args, options = {}) {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return run("systemctl", args, options);
  }
  return run("sudo", ["systemctl", ...args], options);
}

function detectRunningService() {
  if (process.platform === "linux" && tryRun("systemctl", ["is-active", "--quiet", "agentmanager"], { stdio: "pipe" }) !== null) {
    return "systemd";
  }
  if (process.platform === "darwin" && tryRun("launchctl", ["list", "com.aigenius.agentmanager"], { stdio: "pipe" }) !== null) {
    return "launchd";
  }
  return null;
}

function stopInstalled(serviceType, cliPath = LOCAL_CLI) {
  if (serviceType === "systemd") {
    serviceCommand(["stop", "agentmanager"], { stdio: "inherit" });
  } else if (serviceType === "launchd") {
    run("launchctl", ["stop", "com.aigenius.agentmanager"], { stdio: "pipe" });
  } else if (existsSync(cliPath)) {
    tryRun(cliPath, ["stop"], { cwd: dirname(dirname(cliPath)), stdio: "inherit" });
  }

  const pidFile = join(INSTALL_DIR, ".agentmanager.pid");
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (Number.isSafeInteger(pid) && pid > 1) {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
  }
}

function startInstalled(serviceType, cliPath) {
  if (serviceType === "systemd") {
    serviceCommand(["start", "agentmanager"], { stdio: "inherit" });
  } else if (serviceType === "launchd") {
    run("launchctl", ["start", "com.aigenius.agentmanager"], { stdio: "pipe" });
  } else {
    run(cliPath, ["start"], { cwd: INSTALL_DIR, stdio: "inherit" });
  }
}

function configuredPort() {
  const validPort = (value) => {
    const port = Number(value);
    return Number.isSafeInteger(port) && port > 0 && port <= 65535 ? port : null;
  };
  const environmentPort = validPort(process.env.PORT);
  if (environmentPort) return environmentPort;

  const envPath = join(INSTALL_DIR, "server", ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/).reverse()) {
      const match = line.match(/^\s*PORT\s*=\s*["']?([0-9]+)["']?\s*$/);
      const port = validPort(match?.[1]);
      if (port) return port;
    }
  }

  const dbPath = join(homedir(), ".agentmanager", "agentmanager.db");
  const modulesPath = join(INSTALL_DIR, "server", "node_modules");
  if (existsSync(dbPath) && existsSync(join(modulesPath, "better-sqlite3"))) {
    const output = tryRun(process.execPath, ["-e", `
      const Database=require(process.env.AGENTMANAGER_MODULES + '/better-sqlite3');
      const db=new Database(process.env.AGENTMANAGER_DB, {readonly:true, fileMustExist:true});
      const row=db.prepare("SELECT value FROM settings WHERE key=?").get("server_port");
      db.close(); if(row?.value)process.stdout.write(String(row.value));
    `], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        AGENTMANAGER_DB: dbPath,
        AGENTMANAGER_MODULES: modulesPath,
      },
    });
    const databasePort = validPort(output?.trim());
    if (databasePort) return databasePort;
  }
  return 42010;
}

function verifyStarted(serviceType) {
  const port = configuredPort();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    let running = false;
    if (serviceType === "systemd") {
      running = tryRun("systemctl", ["is-active", "--quiet", "agentmanager"], { stdio: "pipe" }) !== null;
    } else if (serviceType === "launchd") {
      running = tryRun("launchctl", ["list", "com.aigenius.agentmanager"], { stdio: "pipe" }) !== null;
    } else {
      const pidPath = join(INSTALL_DIR, ".agentmanager.pid");
      if (existsSync(pidPath)) {
        const pid = Number(readFileSync(pidPath, "utf8").trim());
        if (Number.isSafeInteger(pid) && pid > 1) {
          try { process.kill(pid, 0); running = true; } catch {}
        }
      }
    }
    if (running && tryRun("curl", ["-fsS", "--max-time", "1", `http://127.0.0.1:${port}/api/health`], { stdio: "pipe" }) !== null) {
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error(`Server did not pass its health check on port ${port}`);
}

function preserveUserData(sourceDir, stagedDir) {
  const paths = ["logs", ".agentmanager", join("server", ".env")];
  for (const relative of paths) {
    const source = join(sourceDir, relative);
    if (!existsSync(source)) continue;
    const destination = join(stagedDir, relative);
    mkdirSync(dirname(destination), { recursive: true });
    rmSync(destination, { recursive: true, force: true });
    cpSync(source, destination, { recursive: true, force: true });
  }
  rmSync(join(stagedDir, ".agentmanager.pid"), { force: true });
}

/**
 * Install or update — download pre-built tarball, extract, install deps, setup CLI.
 * Handles both fresh install and upgrade. No install.sh (avoids signal/loop issues).
 */
export function runInstallOrUpdate(version) {
  assertValidVersion(version);
  const installDir = assertSafeInstallDir(INSTALL_DIR);
  const tarballUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/agentmanager-v${version}.tar.gz`;
  const archiveName = `agentmanager-v${version}.tar.gz`;
  const parentDir = dirname(installDir);
  mkdirSync(parentDir, { recursive: true });
  const workDir = mkdtempSync(join(parentDir, ".agentmanager-update-"));
  let releaseInstallLock;
  try {
    releaseInstallLock = acquireInstallLock(parentDir);
  } catch (error) {
    rmSync(workDir, { recursive: true, force: true });
    throw error;
  }
  const archivePath = join(workDir, archiveName);
  const checksumPath = `${archivePath}.sha256`;
  const extractDir = join(workDir, "extract");
  const previousDir = join(workDir, "previous");
  const failedDir = join(workDir, "failed");
  let serviceType = null;
  let stopped = false;
  let replaced = false;
  let hadPrevious = false;
  let preserveWorkDir = false;

  try {
    log(CYAN, `Downloading v${version}...`);
    run("curl", ["-fsSL", "-o", archivePath, tarballUrl], { stdio: "inherit" });
    run("curl", ["-fsSL", "-o", checksumPath, `${tarballUrl}.sha256`], { stdio: "inherit" });
    const expectedHash = parseChecksum(readFileSync(checksumPath, "utf8"), archiveName);
    const actualHash = hashFile(archivePath);
    if (actualHash !== expectedHash) throw new Error("Release checksum verification failed");

    const expectedRoot = validateArchive(archivePath, version);
    mkdirSync(extractDir);
    run("tar", ["-xzf", archivePath, "-C", extractDir], { stdio: "pipe" });
    const stagedDir = join(extractDir, expectedRoot);
    verifyStagedInstall(stagedDir, version);
    installDependencies(stagedDir);
    chmodSync(join(stagedDir, "bin", "agentmanager"), 0o755);

    // The existing service keeps running while all slow and failure-prone work
    // above is performed. Only the final directory exchange needs downtime.
    serviceType = detectRunningService();
    stopInstalled(serviceType);
    stopped = true;
    if (existsSync(installDir)) {
      preserveUserData(installDir, stagedDir);
      renameSync(installDir, previousDir);
      hadPrevious = true;
    }
    renameSync(stagedDir, installDir);
    replaced = true;
    mkdirSync(join(installDir, "logs"), { recursive: true });

    const newCli = join(installDir, "bin", "agentmanager");
    const binDir = join(homedir(), ".local", "bin");
    mkdirSync(binDir, { recursive: true });
    const linkPath = join(binDir, "agentmanager");
    rmSync(linkPath, { force: true });
    symlinkSync(newCli, linkPath);

    startInstalled(serviceType, newCli);
    verifyStarted(serviceType);
    // Startup is now committed. Cleanup failure must never turn a healthy new
    // installation into a rollback with a partially deleted backup.
    replaced = false;
    stopped = false;
    hadPrevious = false;
    try {
      rmSync(previousDir, { recursive: true, force: true });
    } catch {
      preserveWorkDir = true;
      log(YELLOW, `Could not remove update backup at ${previousDir}`);
    }
    log(GREEN, `AgentManager v${version} installed!`);
  } catch (error) {
    if (replaced || hadPrevious) {
      log(YELLOW, "Update failed after replacement; restoring the previous installation...");
      if (replaced) {
        try { stopInstalled(serviceType, join(installDir, "bin", "agentmanager")); } catch {}
      }
      try {
        if (existsSync(installDir)) renameSync(installDir, failedDir);
        if (hadPrevious && existsSync(previousDir)) {
          renameSync(previousDir, installDir);
          hadPrevious = false;
          startInstalled(serviceType, join(installDir, "bin", "agentmanager"));
        }
      } catch (rollbackError) {
        preserveWorkDir = true;
        throw new Error(`${error.message}; rollback failed: ${rollbackError.message}; recovery files: ${workDir}`);
      }
    } else if (stopped && existsSync(installDir)) {
      try { startInstalled(serviceType, join(installDir, "bin", "agentmanager")); } catch {}
    }
    throw error;
  } finally {
    if (!preserveWorkDir) {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        log(YELLOW, `Could not remove update staging directory at ${workDir}`);
      }
    }
    releaseInstallLock();
  }
}

function launch(args) {
  const child = spawn(LOCAL_CLI, args, {
    stdio: "inherit",
    cwd: INSTALL_DIR,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (err) => {
    log(RED, `Failed to run: ${err.message}`);
    process.exit(1);
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Re-entrancy guard: an installer command resolved through npx must proxy to
  // the real installed CLI instead of starting another installation.
  if (process.env.__AGENTMANAGER_NPX_ACTIVE === "1") {
    if (existsSync(LOCAL_CLI)) {
      const child = spawn(LOCAL_CLI, process.argv.slice(2), {
        stdio: "inherit",
        cwd: INSTALL_DIR,
      });
      child.on("exit", (code) => process.exit(code ?? 0));
      child.on("error", () => process.exit(1));
      await new Promise(() => {});
    }
    return;
  }

  const args = process.argv.slice(2);
  const command = args[0] || "";

  if (command === "--install" || command === "install" || command === "--update") {
    const version = getPackageVersion();
    if (!version) throw new Error("Cannot determine version");
    runInstallOrUpdate(version);
    return;
  }

  if (!isInstalled()) {
    const version = getPackageVersion();
    if (!version) throw new Error("Cannot determine version");
    log(CYAN, `Installing AgentManager v${version}...`);
    runInstallOrUpdate(version);
    return;
  }

  const packageVersion = getPackageVersion();
  const localVersion = getLocalVersion();
  if (packageVersion && localVersion && isNewer(packageVersion, localVersion)) {
    log(CYAN, `Updating v${localVersion} → v${packageVersion}...`);
    try {
      runInstallOrUpdate(packageVersion);
      return;
    } catch (error) {
      log(RED, `Update failed: ${error.message}`);
      log(CYAN, "Launching existing version...");
    }
  }
  launch(args.length ? args : ["start"]);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    log(RED, `Failed: ${error.message}`);
    process.exitCode = 1;
  }
}
