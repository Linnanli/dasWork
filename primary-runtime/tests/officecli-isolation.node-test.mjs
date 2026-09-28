import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
  buildIsolatedInvocation,
  buildOfficeCliIsolationEnvironment,
  createOfficeCliIsolationContext,
  isolationStrategyForTarget,
  runCappedCommandForTest,
  runOfficeCliIsolated,
} from "../scripts/officecli-isolation.mjs";

test("OfficeCLI isolation creates temp user homes and a runtime-only PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "officecli-isolation-test-"));
  try {
    const officecliPath = join(root, "runtime", "bin", "officecli");
    const env = buildOfficeCliIsolationEnvironment({
      target: "linux-x64",
      officecliPath,
      home: join(root, "home"),
      bin: join(root, "bin"),
      xdgCache: join(root, "xdg-cache"),
      xdgConfig: join(root, "xdg-config"),
      dotnetHome: join(root, "dotnet"),
      extraEnv: {
        PATH: "/usr/local/bin:/usr/bin",
        Path: "C:\\unsafe",
        HOME: "/Users/example",
        USERPROFILE: "C:\\Users\\example",
        FONTCONFIG_PATH: join(root, "fonts"),
        OFFICECLI_TRACE: "1",
      },
    });

    assert.deepEqual(env.PATH.split(delimiter), [
      join(root, "runtime", "bin"),
      join(root, "bin"),
    ]);
    assert.equal(env.HOME, join(root, "home"));
    assert.equal(env.USERPROFILE, join(root, "home"));
    assert.equal(env.XDG_CACHE_HOME, join(root, "xdg-cache"));
    assert.equal(env.XDG_CONFIG_HOME, join(root, "xdg-config"));
    assert.equal(env.DOTNET_CLI_HOME, join(root, "dotnet"));
    assert.equal(env.OFFICECLI_SKIP_UPDATE, "1");
    assert.equal(env.OFFICECLI_NO_AUTO_RESIDENT, "1");
    assert.equal(env.FONTCONFIG_PATH, join(root, "fonts"));
    assert.equal(env.OFFICECLI_TRACE, "1");
    assert.equal(env.Path, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OfficeCLI isolation keeps Windows system environment explicit", async () => {
  const root = await mkdtemp(join(tmpdir(), "officecli-windows-env-test-"));
  try {
    const env = buildOfficeCliIsolationEnvironment({
      target: "win32-x64",
      officecliPath: join(root, "runtime", "officecli.exe"),
      home: join(root, "home"),
      bin: join(root, "bin"),
      xdgCache: join(root, "xdg-cache"),
      xdgConfig: join(root, "xdg-config"),
      dotnetHome: join(root, "dotnet"),
      extraEnv: {
        SystemRoot: "C:\\unsafe",
        WINDIR: "C:\\unsafe",
        Path: "C:\\unsafe",
        FONTCONFIG_FILE: join(root, "fonts.conf"),
      },
    });

    assert.equal(env.SystemRoot, process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows");
    assert.equal(env.WINDIR, process.env.WINDIR ?? env.SystemRoot);
    assert.equal(env.Path, undefined);
    assert.equal(env.FONTCONFIG_FILE, join(root, "fonts.conf"));
    assert.deepEqual(env.PATH.split(delimiter), [
      join(root, "runtime"),
      join(root, "bin"),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OfficeCLI isolation maps each Runtime target to a native network blocker", () => {
  assert.deepEqual(isolationStrategyForTarget("darwin-x64", "darwin"), {
    kind: "macos-sandbox-exec",
    availableOnHost: true,
    executable: "/usr/bin/sandbox-exec",
  });
  assert.deepEqual(isolationStrategyForTarget("linux-x64", "linux"), {
    kind: "linux-network-namespace",
    availableOnHost: true,
    executable: "/usr/bin/sudo",
    helperExecutable: "/usr/bin/unshare",
  });
  assert.deepEqual(isolationStrategyForTarget("win32-x64", "win32"), {
    kind: "windows-defender-firewall",
    availableOnHost: true,
    executable: "netsh.exe",
  });
});

test("OfficeCLI isolation plans kernel-level network denial wrappers", () => {
  const env = { PATH: "/runtime/bin", HOME: "/tmp/home" };
  const mac = buildIsolatedInvocation({
    strategy: isolationStrategyForTarget("darwin-arm64", "darwin"),
    executable: "/runtime/bin/officecli",
    args: ["view", "deck.pptx"],
    env,
  });
  assert.equal(mac.command, "/usr/bin/sandbox-exec");
  assert.match(mac.args[1], /\(deny network\*\)/u);
  assert.deepEqual(mac.args.slice(2), ["/runtime/bin/officecli", "view", "deck.pptx"]);

  const linux = buildIsolatedInvocation({
    strategy: isolationStrategyForTarget("linux-x64", "linux"),
    executable: "/runtime/bin/officecli",
    args: ["get", "book.xlsx", "/"],
    env,
  });
  assert.equal(linux.command, "/usr/bin/sudo");
  assert.deepEqual(linux.args.slice(0, 5), ["-n", "/usr/bin/env", "-i", "PATH=/runtime/bin", "HOME=/tmp/home"]);
  assert.deepEqual(linux.args.slice(-5), ["--", "/runtime/bin/officecli", "get", "book.xlsx", "/"]);
  assert.ok(linux.args.includes("--net"));

  const windows = buildIsolatedInvocation({
    strategy: isolationStrategyForTarget("win32-x64", "win32"),
    executable: "C:\\runtime\\bin\\officecli.exe",
    args: ["validate", "doc.docx"],
    env,
    firewallRuleName: "dascowork-officecli-test",
  });
  assert.equal(windows.command, "C:\\runtime\\bin\\officecli.exe");
  assert.deepEqual(windows.firewallRule.add, [
    "advfirewall",
    "firewall",
    "add",
    "rule",
    "name=dascowork-officecli-test",
    "dir=out",
    "action=block",
    "program=C:\\runtime\\bin\\officecli.exe",
    "enable=yes",
    "profile=any",
  ]);
  assert.equal(windows.firewallRule.program, "C:\\runtime\\bin\\officecli.exe");
  assert.deepEqual(windows.firewallRule.show, [
    "advfirewall",
    "firewall",
    "show",
    "rule",
    "name=dascowork-officecli-test",
    "verbose",
  ]);
  assert.deepEqual(windows.firewallRule.delete, [
    "advfirewall",
    "firewall",
    "delete",
    "rule",
    "name=dascowork-officecli-test",
  ]);
});

test("OfficeCLI isolation refuses cross-target execution before running commands", async () => {
  const impossibleTarget = process.platform === "win32" ? "linux-x64" : "win32-x64";
  await assert.rejects(
    () => runOfficeCliIsolated({
      target: impossibleTarget,
      officecliPath: process.execPath,
      args: ["--version"],
      probeNetwork: false,
    }),
    /requires native host/u,
  );
});

test("OfficeCLI isolation context cleanup removes the temporary user surface", async () => {
  const context = await createOfficeCliIsolationContext({
    target: process.platform === "darwin" ? "darwin-x64" : process.platform === "win32" ? "win32-x64" : "linux-x64",
    officecliPath: process.execPath,
  });
  assert.match(context.root, /primary-runtime-officecli-isolated-/u);
  assert.deepEqual(context.env.PATH.split(delimiter), [
    process.execPath.replace(/[\\/][^\\/]+$/u, ""),
    context.paths.bin,
  ]);
  for (const directory of [
    context.env.HOME,
    context.env.USERPROFILE,
    context.env.XDG_CACHE_HOME,
    context.env.XDG_CONFIG_HOME,
    context.env.DOTNET_CLI_HOME,
    context.env.TMPDIR,
    context.env.TEMP,
  ].filter(Boolean)) {
    assert.equal((await stat(directory)).isDirectory(), true, `${directory} should exist`);
  }
  await context.cleanup();
});

test("OfficeCLI isolation rejects oversized stdout and stderr from real child processes", async () => {
  await assert.rejects(
    () => runCappedCommandForTest({
      command: process.execPath,
      args: [
        "--input-type=module",
        "--eval",
        "process.stdout.write('x'.repeat(20000));",
      ],
      timeoutMs: 10_000,
    }),
    /exceeded stdout output limit 16384 bytes \(20000 bytes\)/u,
  );

  await assert.rejects(
    () => runCappedCommandForTest({
      command: process.execPath,
      args: [
        "--input-type=module",
        "--eval",
        "process.stderr.write('y'.repeat(20000));",
      ],
      timeoutMs: 10_000,
    }),
    /exceeded stderr output limit 16384 bytes \(20000 bytes\)/u,
  );

  await assert.rejects(
    () => runCappedCommandForTest({
      command: process.execPath,
      args: [
        "--input-type=module",
        "--eval",
        "process.stdout.write('x'.repeat(10000)); process.stderr.write('y'.repeat(10000));",
      ],
      timeoutMs: 10_000,
    }),
    /exceeded combined output limit 16384 bytes \(20000 bytes\)/u,
  );
});

test("OfficeCLI isolation preserves separate stdout and stderr below the cap", async () => {
  const result = await runCappedCommandForTest({
    command: process.execPath,
    args: [
      "--input-type=module",
      "--eval",
      "process.stdout.write('office-json'); process.stderr.write('office-warning');",
    ],
    timeoutMs: 10_000,
  });

  assert.equal(result.stdout.toString("utf8"), "office-json");
  assert.equal(result.stderr.toString("utf8"), "office-warning");
  assert.equal(result.outputBytes, "office-jsonoffice-warning".length);
  assert.equal(result.stdoutBytes, "office-json".length);
  assert.equal(result.stderrBytes, "office-warning".length);
  assert.equal(result.outputTruncated, false);
  assert.equal(result.stdoutTruncated, false);
  assert.equal(result.stderrTruncated, false);
});
