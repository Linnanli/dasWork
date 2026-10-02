import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { arch, platform, release, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import {
  buildLinuxIsolatedStraceExecAuditInvocation,
  buildMacOfficeCliExecAuditProfile,
  probePosixOfficeCliExecAudit,
  validateLinuxExecTrace,
} from "./officecli-exec-audit-posix.mjs";
import {
  probeWindowsChildProcessRestriction,
  runWindowsOfficeCliExecAudit,
} from "./officecli-exec-audit-windows.mjs";

export const officeCliIsolationSchemaVersion = "dascowork-officecli-isolation.v1";

const defaultTimeoutMs = 45_000;
const capturedOutputBytes = 16_384;
const networkDeniedExitCode = 70;
const networkAllowedExitCode = 71;
const networkProbeScript = `
import net from "node:net";
const host = process.argv[1];
const port = Number(process.argv[2]);
const socket = net.createConnection({ host, port });
let finished = false;
const finish = (result) => {
  if (finished) return;
  finished = true;
  console.log(JSON.stringify(result));
  process.exit(result.denied ? ${networkDeniedExitCode} : ${networkAllowedExitCode});
};
const timer = setTimeout(() => finish({ denied: true, reason: "timeout" }), 3000);
socket.once("connect", () => {
  clearTimeout(timer);
  socket.destroy();
  finish({ denied: false, reason: "connected" });
});
socket.on("error", (error) => {
  if (finished) return;
  clearTimeout(timer);
  const code = String(error.code ?? "");
  finish({
    denied: ["EACCES", "EPERM", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT"].includes(code),
    reason: code || String(error.message ?? error),
  });
});
`;

export function isolationStrategyForTarget(target, hostPlatform = platform()) {
  if (target.startsWith("darwin")) {
    return {
      kind: "macos-sandbox-exec",
      availableOnHost: hostPlatform === "darwin",
      executable: "/usr/bin/sandbox-exec",
    };
  }
  if (target.startsWith("linux")) {
    return {
      kind: "linux-network-namespace",
      availableOnHost: hostPlatform === "linux",
      executable: "/usr/bin/sudo",
      helperExecutable: "/usr/bin/unshare",
    };
  }
  if (target.startsWith("win32")) {
    return {
      kind: "windows-defender-firewall",
      availableOnHost: hostPlatform === "win32",
      executable: "netsh.exe",
    };
  }
  throw new Error(`Unsupported OfficeCLI Runtime target: ${target}`);
}

export async function createOfficeCliIsolationContext(options) {
  const target = requireNonEmptyString(options?.target, "target");
  const officecliPath = resolve(requireNonEmptyString(options?.officecliPath, "officecliPath"));
  const root = await mkdtemp(join(resolve(options?.tempParent ?? tmpdir()), "primary-runtime-officecli-isolated-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const xdgCache = join(root, "xdg-cache");
  const xdgConfig = join(root, "xdg-config");
  const dotnetHome = join(root, "dotnet");
  const env = buildOfficeCliIsolationEnvironment({
    target,
    officecliPath,
    home,
    bin,
    xdgCache,
    xdgConfig,
    dotnetHome,
    extraEnv: options?.extraEnv,
  });
  const environmentDirectories = [
    home,
    bin,
    xdgCache,
    xdgConfig,
    dotnetHome,
    env.TMPDIR,
    env.TEMP,
    env.TMP,
    env.LOCALAPPDATA,
    env.APPDATA,
  ].filter(Boolean);
  await Promise.all(environmentDirectories.map((path) => mkdir(path, { recursive: true })));
  return {
    schemaVersion: officeCliIsolationSchemaVersion,
    target,
    host: { platform: platform(), architecture: arch(), release: release() },
    root,
    paths: { home, bin, xdgCache, xdgConfig, dotnetHome, officecliPath },
    env,
    strategy: isolationStrategyForTarget(target),
    networkProbeReceipt: null,
    executionProbeReceipt: null,
    executionCommandReceipts: [],
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function buildOfficeCliIsolationEnvironment(options) {
  const target = requireNonEmptyString(options?.target, "target");
  const officecliPath = resolve(requireNonEmptyString(options?.officecliPath, "officecliPath"));
  const home = resolve(requireNonEmptyString(options?.home, "home"));
  const bin = resolve(requireNonEmptyString(options?.bin, "bin"));
  const xdgCache = resolve(requireNonEmptyString(options?.xdgCache, "xdgCache"));
  const xdgConfig = resolve(requireNonEmptyString(options?.xdgConfig, "xdgConfig"));
  const dotnetHome = resolve(requireNonEmptyString(options?.dotnetHome, "dotnetHome"));
  const pathValue = [dirname(officecliPath), bin].join(delimiter);
  const shared = {
    HOME: home,
    PATH: pathValue,
    PYTHONDONTWRITEBYTECODE: "1",
    OFFICECLI_SKIP_UPDATE: "1",
    OFFICECLI_NO_AUTO_RESIDENT: "1",
    DOTNET_CLI_HOME: dotnetHome,
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
    DOTNET_NOLOGO: "1",
    XDG_CACHE_HOME: xdgCache,
    XDG_CONFIG_HOME: xdgConfig,
    NO_PROXY: "*",
    no_proxy: "*",
    ...sanitizeExtraEnv(options?.extraEnv),
  };
  if (target.startsWith("win32")) {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
    const windir = process.env.WINDIR ?? systemRoot;
    return {
      ...shared,
      SystemRoot: systemRoot,
      WINDIR: windir,
      USERPROFILE: home,
      LOCALAPPDATA: join(home, "AppData", "Local"),
      APPDATA: join(home, "AppData", "Roaming"),
      TEMP: join(home, "Temp"),
      TMP: join(home, "Temp"),
    };
  }
  return {
    ...shared,
    USERPROFILE: home,
    TMPDIR: join(home, "tmp"),
  };
}

export async function probeOfficeCliIsolation(options) {
  const target = requireNonEmptyString(options?.target, "target");
  const probeExecutable = resolve(options?.probeExecutable ?? process.execPath);
  const context = options?.context ?? await createOfficeCliIsolationContext({
    target,
    officecliPath: options?.officecliPath ?? probeExecutable,
    tempParent: options?.tempParent,
    extraEnv: options?.extraEnv,
  });
  const ownsContext = !options?.context;
  const timeoutMs = Number(options?.timeoutMs ?? 10_000);
  let server = null;
  try {
    const endpoint = target.startsWith("win32")
      ? { kind: "external", host: "1.1.1.1", port: 443 }
      : { kind: "loopback", ...(await createLoopbackEndpoint()) };
    server = endpoint.server ?? null;
    delete endpoint.server;
    const probeArgs = ["--input-type=module", "--eval", networkProbeScript, endpoint.host, String(endpoint.port)];
    const positiveControl = await runNetworkProbe({
      executable: probeExecutable,
      args: probeArgs,
      env: context.env,
      timeoutMs,
      isolated: false,
      name: "officecli-isolation-positive-control",
    });
    const isolatedAttempt = await runOfficeCliIsolated({
      target,
      officecliPath: options?.officecliPath ?? probeExecutable,
      executable: probeExecutable,
      args: probeArgs,
      name: options?.name ?? "officecli-isolation-network-probe",
      allowedExitCodes: [networkDeniedExitCode],
      probeNetwork: false,
      probeExecution: false,
      context,
      timeoutMs,
    });
    const isolatedResult = parseProbeOutput(isolatedAttempt.command.output);
    const receipt = {
      schemaVersion: officeCliIsolationSchemaVersion,
      target,
      endpoint,
      positiveControl: positiveControl.result,
      isolatedAttempt: isolatedResult,
      isolatedCommand: {
        strategy: isolatedAttempt.strategy,
        exitCode: isolatedAttempt.command.exitCode,
        signal: isolatedAttempt.command.signal,
        elapsedMs: isolatedAttempt.command.elapsedMs,
        outputTruncated: isolatedAttempt.command.outputTruncated,
        firewallRuleName: isolatedAttempt.firewallRuleName,
      },
      passed: positiveControl.result.denied === false && isolatedResult.denied === true,
    };
    if (!receipt.passed) {
      throw new Error(`OfficeCLI isolation network probe failed: ${JSON.stringify(receipt)}`);
    }
    context.networkProbeReceipt = receipt;
    return receipt;
  } finally {
    if (server) await closeServer(server);
    if (ownsContext) await context.cleanup();
  }
}

export async function probeOfficeCliExecutionAudit({ context, timeoutMs = 15_000 }) {
  context.executionProbeReceipt ??= context.target.startsWith("win32")
    ? await probeWindowsChildProcessRestriction({ env: context.env, tempParent: context.root, timeoutMs })
    : await probePosixOfficeCliExecAudit({ target: context.target, env: context.env, tempParent: context.root, timeoutMs });
  if (context.executionProbeReceipt.passed !== true) {
    throw new Error("OfficeCLI executable exclusion probe did not pass.");
  }
  return context.executionProbeReceipt;
}

export async function runOfficeCliIsolated(options) {
  const target = requireNonEmptyString(options?.target, "target");
  const executable = resolve(requireNonEmptyString(options?.executable ?? options?.officecliPath, "officecliPath"));
  const args = Array.isArray(options?.args) ? options.args.map(String) : [];
  const strategy = isolationStrategyForTarget(target);
  if (!strategy.availableOnHost) {
    throw new Error(`OfficeCLI isolation for ${target} requires native host ${targetPlatformName(target)}; current host is ${platform()}.`);
  }
  const context = options?.context ?? await createOfficeCliIsolationContext({
    target,
    officecliPath: options?.officecliPath ?? executable,
    tempParent: options?.tempParent,
    extraEnv: options?.extraEnv,
  });
  const ownsContext = !options?.context;
  const allowedExitCodes = options?.allowedExitCodes ?? [0];
  const timeoutMs = Number(options?.timeoutMs ?? defaultTimeoutMs);
  let firewallRule = null;
  let resultReceipt = null;
  let commandFailure = null;
  try {
    if (options?.probeNetwork !== false && executable === resolve(options?.officecliPath ?? executable)) {
      context.networkProbeReceipt ??= await probeOfficeCliIsolation({
        target,
        officecliPath: executable,
        context,
        timeoutMs: Math.min(timeoutMs, 10_000),
      });
    }
    if (options?.probeExecution !== false && executable === resolve(options?.officecliPath ?? executable)) {
      await probeOfficeCliExecutionAudit({ context, timeoutMs: Math.min(timeoutMs, 45_000) });
    }
    const canonicalExecutable = await realpath(executable);
    let invocation = buildIsolatedInvocation({
      strategy,
      executable: canonicalExecutable,
      args,
      env: context.env,
      firewallRuleName: `dascowork-officecli-${randomUUID()}`,
    });
    if (target.startsWith("linux")) {
      invocation = buildLinuxIsolatedStraceExecAuditInvocation({
        isolationInvocation: invocation,
        officecliPath: canonicalExecutable,
        args,
        tracePath: join(context.root, `exec-trace-${randomUUID()}.log`),
      });
    }
    firewallRule = invocation.firewallRule;
    if (firewallRule) await installFirewallRule(firewallRule, timeoutMs);
    const commandOptions = { cwd: options?.cwd, timeoutMs, allowedExitCodes, name: options?.name ?? "officecli-isolated-command" };
    let result;
    let executionAudit;
    if (target.startsWith("win32")) {
      const audited = await runWindowsOfficeCliExecAudit({
        ...commandOptions, executable: invocation.command, args: invocation.args, env: invocation.env,
        tempParent: context.root,
      });
      if (audited.policy?.childProcessRestricted !== true || audited.command?.timedOut !== false) {
        throw new Error("OfficeCLI Windows child process restriction was not verified.");
      }
      const stdout = Buffer.from(audited.command.stdout, "utf8");
      const stderr = Buffer.from(audited.command.stderr, "utf8");
      const output = Buffer.concat([stdout, stderr]);
      if (output.length > capturedOutputBytes) throw new Error("OfficeCLI audited command exceeded combined output limit.");
      result = { ...audited.command, stdout, stderr, output, outputBytes: output.length, outputTruncated: false, signal: null };
      executionAudit = { strategy: "windows-child-process-policy", passed: true, policy: audited.policy };
    } else {
      result = await runRawCommand({
        ...commandOptions, command: invocation.command, args: invocation.args, env: invocation.env,
      });
      executionAudit = { strategy: "macos-sandbox-exec-process-allowlist", passed: true, allowedExecPaths: [canonicalExecutable] };
      if (invocation.tracePath) {
        const traceText = await readFile(invocation.tracePath, "utf8");
        const trace = validateLinuxExecTrace({ traceText, allowedExecPaths: invocation.allowedExecPaths });
        executionAudit = {
          strategy: invocation.strategy, passed: true, ...trace,
          traceSha256: createHash("sha256").update(traceText).digest("hex"),
        };
      }
    }
    if (executable === resolve(options?.officecliPath ?? executable)) {
      context.executionCommandReceipts.push({ name: commandOptions.name, executable: canonicalExecutable, args, exitCode: result.exitCode, ...executionAudit });
    }
    resultReceipt = {
      schemaVersion: officeCliIsolationSchemaVersion,
      target,
      strategy: strategy.kind,
      paths: context.paths,
      envReceipt: environmentReceipt(context.env),
      networkProbe: context.networkProbeReceipt,
      executionAudit,
      command: {
        executable,
        args,
        exitCode: result.exitCode,
        signal: result.signal,
        elapsedMs: result.elapsedMs,
        output: result.output,
        stdout: result.stdout,
        stderr: result.stderr,
        outputBytes: result.outputBytes,
        outputTruncated: result.outputTruncated,
      },
      firewallRuleName: firewallRule?.name ?? null,
    };
  } catch (error) {
    commandFailure = error;
  }
  let cleanupFailure = null;
  if (firewallRule) {
    try {
      await uninstallFirewallRule(firewallRule, timeoutMs);
    } catch (error) {
      cleanupFailure = error;
    }
  }
  try {
    if (commandFailure || cleanupFailure) {
      throw buildIsolationFailure({ commandFailure, cleanupFailure, firewallRule });
    }
    return resultReceipt;
  } finally {
    if (ownsContext) await context.cleanup();
  }
}

export function buildIsolatedInvocation({ strategy, executable, args, env, firewallRuleName }) {
  if (strategy.kind === "macos-sandbox-exec") {
    return {
      command: strategy.executable,
      args: ["-p", buildMacOfficeCliExecAuditProfile({ officecliPath: executable }), executable, ...args],
      env,
    };
  }
  if (strategy.kind === "linux-network-namespace") {
    const envAssignments = Object.entries(env).map(([key, value]) => `${key}=${value}`);
    return {
      command: strategy.executable,
      args: ["-n", "/usr/bin/env", "-i", ...envAssignments, strategy.helperExecutable, "--net", "--", executable, ...args],
      env: {},
    };
  }
  if (strategy.kind === "windows-defender-firewall") {
    const name = firewallRuleName ?? `dascowork-officecli-${randomUUID()}`;
    return {
      command: executable,
      args,
      env,
      firewallRule: {
        name,
        program: executable,
        add: ["advfirewall", "firewall", "add", "rule", `name=${name}`, "dir=out", "action=block", `program=${executable}`, "enable=yes", "profile=any"],
        show: ["advfirewall", "firewall", "show", "rule", `name=${name}`, "verbose"],
        delete: ["advfirewall", "firewall", "delete", "rule", `name=${name}`],
      },
    };
  }
  throw new Error(`Unsupported OfficeCLI isolation strategy: ${strategy.kind}`);
}

export async function runCappedCommandForTest(options) {
  return await runRawCommand({
    command: requireNonEmptyString(options?.command, "command"),
    args: Array.isArray(options?.args) ? options.args.map(String) : [],
    env: options?.env ?? process.env,
    cwd: options?.cwd,
    timeoutMs: Number(options?.timeoutMs ?? 10_000),
    allowedExitCodes: options?.allowedExitCodes ?? [0],
    name: options?.name ?? "officecli-isolation-capped-command-test",
  });
}

function environmentReceipt(env) {
  return {
    pathEntries: String(env.PATH ?? "").split(delimiter).filter(Boolean),
    home: env.HOME,
    userProfile: env.USERPROFILE,
    xdgCacheHome: env.XDG_CACHE_HOME,
    xdgConfigHome: env.XDG_CONFIG_HOME,
    dotnetCliHome: env.DOTNET_CLI_HOME,
    officeCliSkipUpdate: env.OFFICECLI_SKIP_UPDATE,
    officeCliNoAutoResident: env.OFFICECLI_NO_AUTO_RESIDENT,
  };
}

async function runFirewallCommand(args, timeoutMs) {
  return await runRawCommand({
    command: windowsNetshPath(),
    args,
    env: windowsSystemEnvironment(),
    timeoutMs,
    allowedExitCodes: [0],
    name: "officecli-isolation-firewall",
  });
}

async function installFirewallRule(rule, timeoutMs) {
  await runFirewallCommand(rule.add, timeoutMs);
  const shown = await runFirewallCommand(rule.show, timeoutMs);
  const output = shown.output.toString("utf8");
  if (!output.includes(rule.program) || !/Direction:\s*Out/iu.test(output) || !/Action:\s*Block/iu.test(output)) {
    throw new Error(`OfficeCLI isolation firewall rule ${rule.name} does not bind outbound block to ${rule.program}: ${output.slice(-500)}`);
  }
}

async function uninstallFirewallRule(rule, timeoutMs) {
  await runFirewallCommand(rule.delete, timeoutMs);
}

async function runRawCommand({ command, args, env, cwd, timeoutMs, allowedExitCodes, name }) {
  return await new Promise((resolveCommand, rejectCommand) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const output = createCappedCapture("combined");
    const stdout = createCappedCapture("stdout");
    const stderr = createCappedCapture("stderr");
    let settled = false;
    let timedOut = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 5_000).unref();
    }, timeoutMs);
    timer.unref();
    const capture = (streamCapture, chunk) => {
      const buffer = Buffer.from(chunk);
      streamCapture.push(buffer);
      output.push(buffer);
    };
    child.stdout.on("data", (chunk) => capture(stdout, chunk));
    child.stderr.on("data", (chunk) => capture(stderr, chunk));
    child.once("error", (error) => finish(() => rejectCommand(error)));
    child.once("close", (exitCode, signal) => {
      finish(() => {
        const elapsedMs = Date.now() - startedAt;
        const outputBuffer = output.buffer();
        const overflow = [stdout, stderr, output].find((captureState) => captureState.truncated);
        if (overflow) {
          rejectCommand(
            new Error(
              `${name} exceeded ${overflow.label} output limit ${capturedOutputBytes} bytes (${overflow.bytes} bytes).`,
            ),
          );
          return;
        }
        if (!timedOut && allowedExitCodes.includes(exitCode)) {
          resolveCommand({
            output: outputBuffer,
            stdout: stdout.buffer(),
            stderr: stderr.buffer(),
            outputBytes: output.bytes,
            stdoutBytes: stdout.bytes,
            stderrBytes: stderr.bytes,
            outputTruncated: output.truncated,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
            elapsedMs,
            exitCode,
            signal,
          });
          return;
        }
        const reason = timedOut ? `timed out after ${timeoutMs}ms` : `failed with ${exitCode ?? signal ?? "unknown"}`;
        const captured = outputBuffer.toString("utf8").slice(-capturedOutputBytes);
        rejectCommand(new Error(`${name} ${reason}: ${captured.slice(-500) || "no command output"}`));
      });
    });
  });
}

function createCappedCapture(label) {
  const chunks = [];
  let bytes = 0;
  let storedBytes = 0;
  let truncated = false;
  return {
    label,
    get bytes() {
      return bytes;
    },
    get truncated() {
      return truncated;
    },
    push(buffer) {
      bytes += buffer.length;
      if (storedBytes >= capturedOutputBytes) {
        truncated = true;
        return;
      }
      const remaining = capturedOutputBytes - storedBytes;
      const stored = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;
      chunks.push(stored);
      storedBytes += stored.length;
      if (buffer.length > remaining) truncated = true;
    },
    buffer() {
      return Buffer.concat(chunks, storedBytes);
    },
  };
}

function targetPlatformName(target) {
  if (target.startsWith("darwin")) return "darwin";
  if (target.startsWith("linux")) return "linux";
  if (target.startsWith("win32")) return "win32";
  return target;
}

function sanitizeExtraEnv(extraEnv) {
  if (!extraEnv) return {};
  const allowed = new Set([
    "FONTCONFIG_FILE",
    "FONTCONFIG_PATH",
    "OFFICECLI_LOG",
    "OFFICECLI_TRACE",
  ]);
  const blocked = new Set(["HOME", "USERPROFILE", "PATH", "Path", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "DOTNET_CLI_HOME", "SystemRoot", "WINDIR"]);
  const blockedLower = new Set([...blocked].map((key) => key.toLowerCase()));
  return Object.fromEntries(
    Object.entries(extraEnv)
      .filter(([key, value]) => allowed.has(key) && !blockedLower.has(key.toLowerCase()) && value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required OfficeCLI isolation option: ${name}`);
  }
  return value;
}

async function createLoopbackEndpoint() {
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    socket.end("officecli-isolation-probe\n");
  });
  await new Promise((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", resolveServer);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("OfficeCLI isolation failed to create loopback probe endpoint.");
  }
  return { kind: "loopback", host: "127.0.0.1", port: address.port, server };
}

async function closeServer(server) {
  await new Promise((resolveServer) => server.close(() => resolveServer()));
}

async function runNetworkProbe({ executable, args, env, timeoutMs, isolated, name }) {
  const expectedExitCodes = isolated ? [networkDeniedExitCode] : [networkAllowedExitCode];
  const command = await runRawCommand({
    command: executable,
    args,
    env,
    timeoutMs,
    allowedExitCodes: expectedExitCodes,
    name,
  });
  return {
    command: {
      executable,
      exitCode: command.exitCode,
      signal: command.signal,
      elapsedMs: command.elapsedMs,
      outputBytes: command.outputBytes,
      outputTruncated: command.outputTruncated,
    },
    result: parseProbeOutput(command.output),
  };
}

function parseProbeOutput(output) {
  try {
    const parsed = JSON.parse(output.toString("utf8").trim());
    return {
      denied: parsed.denied === true,
      reason: String(parsed.reason ?? "unknown"),
    };
  } catch (error) {
    throw new Error(`OfficeCLI isolation probe emitted invalid JSON: ${String(error.message ?? error)}`);
  }
}

function buildIsolationFailure({ commandFailure, cleanupFailure, firewallRule }) {
  if (!cleanupFailure) return commandFailure;
  const residual = firewallRule
    ? ` Residual firewall rule may remain: ${firewallRule.name} for ${firewallRule.program}.`
    : "";
  if (!commandFailure) {
    return new Error(`OfficeCLI isolation cleanup failed.${residual} ${String(cleanupFailure.message ?? cleanupFailure)}`);
  }
  return new Error(
    `OfficeCLI isolation command failed and cleanup also failed.${residual} command=${String(commandFailure.message ?? commandFailure)} cleanup=${String(cleanupFailure.message ?? cleanupFailure)}`,
  );
}

function windowsSystemEnvironment() {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  return {
    SystemRoot: systemRoot,
    WINDIR: process.env.WINDIR ?? systemRoot,
  };
}

function windowsNetshPath() {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  return `${systemRoot}\\System32\\netsh.exe`;
}
