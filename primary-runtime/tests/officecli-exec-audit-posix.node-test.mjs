import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLinuxIsolatedStraceExecAuditInvocation,
  buildLinuxStraceExecAuditInvocation,
  buildMacOfficeCliExecAuditProfile,
  buildMacSandboxExecAuditInvocation,
  parseLinuxExecTraceLine,
  probePosixOfficeCliExecAudit,
  runMacExecDenyProbeForTest,
  validateLinuxExecTrace,
} from "../scripts/officecli-exec-audit-posix.mjs";

test("macOS exec audit profile allows only the starting OfficeCLI executable", () => {
  const profile = buildMacOfficeCliExecAuditProfile({
    officecliPath: "/runtime/dependencies/native/officecli/officecli",
  });

  assert.match(profile, /\(deny network\*\)/u);
  assert.match(profile, /\(deny process-exec\)/u);
  assert.match(
    profile,
    /\(allow process-exec \(literal "\/runtime\/dependencies\/native\/officecli\/officecli"\)\)/u,
  );

  const invocation = buildMacSandboxExecAuditInvocation({
    officecliPath: "/runtime/dependencies/native/officecli/officecli",
    args: ["--version"],
    env: { PATH: "/runtime/dependencies/native/officecli" },
  });
  assert.equal(invocation.command, "/usr/bin/sandbox-exec");
  assert.deepEqual(invocation.args.slice(2), [
    "/runtime/dependencies/native/officecli/officecli",
    "--version",
  ]);
  assert.deepEqual(invocation.allowedExecPaths, [
    "/runtime/dependencies/native/officecli/officecli",
  ]);
});

test("Linux exec audit wraps OfficeCLI with strace execve capture", () => {
  const invocation = buildLinuxStraceExecAuditInvocation({
    officecliPath: "/runtime/dependencies/native/officecli/officecli",
    tracePath: "/tmp/officecli-exec.log",
    args: ["create", "/tmp/a.docx"],
    additionalAllowedExecPaths: ["/runtime/dependencies/native/officecli/officecli-helper"],
  });

  assert.equal(invocation.command, "/usr/bin/strace");
  assert.deepEqual(invocation.args.slice(0, 8), [
    "-f",
    "-qq",
    "-e",
    "trace=execve,execveat",
    "-s",
    "4096",
    "-o",
    "/tmp/officecli-exec.log",
  ]);
  assert.deepEqual(invocation.args.slice(8), [
    "/runtime/dependencies/native/officecli/officecli",
    "create",
    "/tmp/a.docx",
  ]);
  assert.deepEqual(invocation.allowedExecPaths, [
    "/runtime/dependencies/native/officecli/officecli",
    "/runtime/dependencies/native/officecli/officecli-helper",
  ]);
});

test("Linux exec audit inserts strace inside the existing unshare wrapper", () => {
  const invocation = buildLinuxIsolatedStraceExecAuditInvocation({
    officecliPath: "/runtime/dependencies/native/officecli/officecli",
    tracePath: "/tmp/officecli-exec.log",
    args: ["--version"],
    isolationInvocation: {
      command: "/usr/bin/sudo",
      args: [
        "-n",
        "/usr/bin/env",
        "-i",
        "PATH=/runtime/dependencies/native/officecli",
        "/usr/bin/unshare",
        "--net",
        "--",
        "/runtime/dependencies/native/officecli/officecli",
        "--version",
      ],
      env: {},
    },
  });

  assert.equal(invocation.command, "/usr/bin/sudo");
  assert.deepEqual(invocation.args.slice(0, 7), [
    "-n",
    "/usr/bin/env",
    "-i",
    "PATH=/runtime/dependencies/native/officecli",
    "/usr/bin/unshare",
    "--net",
    "--",
  ]);
  assert.deepEqual(invocation.args.slice(7), [
    "/usr/bin/strace",
    "-f",
    "-qq",
    "-e",
    "trace=execve,execveat",
    "-s",
    "4096",
    "-o",
    "/tmp/officecli-exec.log",
    "/runtime/dependencies/native/officecli/officecli",
    "--version",
  ]);
  assert.deepEqual(invocation.allowedExecPaths, [
    "/runtime/dependencies/native/officecli/officecli",
  ]);
});

test("Linux exec audit parser accepts only explicit executable allowlist entries", () => {
  const trace = [
    '123 execve("/runtime/dependencies/native/officecli/officecli", ["officecli"], 0xabc) = 0',
    '124 execveat(AT_FDCWD, "/runtime/dependencies/native/officecli/officecli-helper", ["helper"], 0xabc, 0) = 0',
  ].join("\n");

  const result = validateLinuxExecTrace({
    traceText: trace,
    allowedExecPaths: [
      "/runtime/dependencies/native/officecli/officecli",
      "/runtime/dependencies/native/officecli/officecli-helper",
    ],
  });

  assert.deepEqual(result.entries, [
    { syscall: "execve", path: "/runtime/dependencies/native/officecli/officecli" },
    { syscall: "execveat", path: "/runtime/dependencies/native/officecli/officecli-helper" },
  ]);
});

test("Linux exec audit parser rejects external programs and incomplete traces", () => {
  assert.throws(
    () => validateLinuxExecTrace({
      traceText: '123 execve("/usr/bin/python3", ["python3"], 0xabc) = 0\n',
      allowedExecPaths: ["/runtime/dependencies/native/officecli/officecli"],
    }),
    /blocked external executable \/usr\/bin\/python3/u,
  );

  assert.throws(
    () => validateLinuxExecTrace({
      traceText: '123 execve("/runtime/dependencies/native/officecli/officecli", ["officecli"], 0xabc <unfinished ...>\n',
      allowedExecPaths: ["/runtime/dependencies/native/officecli/officecli"],
    }),
    /trace is incomplete/u,
  );

  assert.throws(
    () => validateLinuxExecTrace({
      traceText: "+++ exited with 0 +++\n",
      allowedExecPaths: ["/runtime/dependencies/native/officecli/officecli"],
    }),
    /did not record execve/u,
  );

  assert.throws(
    () => validateLinuxExecTrace({
      traceText: '123 execve(0x1234, ["officecli"], 0xabc) = 0\n',
      allowedExecPaths: ["/runtime/dependencies/native/officecli/officecli"],
    }),
    /unparseable exec syscall line/u,
  );
});

test("Linux exec audit parser handles escaped strace path strings", () => {
  assert.deepEqual(
    parseLinuxExecTraceLine('123 execve("/tmp/officecli\\\"quoted", ["officecli"], 0xabc) = 0'),
    { syscall: "execve", path: "/tmp/officecli\"quoted" },
  );
});

test("macOS exec audit rejects absolute system child programs", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS sandbox-exec is only available on darwin hosts.");
    return;
  }
  try {
    const receipt = await runMacExecDenyProbeForTest({ timeoutMs: 15_000 });
    assert.equal(receipt.passed, true);
    assert.equal(receipt.unrestricted.exitCode, 0);
    assert.equal(receipt.positive.strategy, "macos-sandbox-exec-process-allowlist");
    assert.equal(receipt.negative.command.exitCode, 73);
    assert.match(receipt.negative.command.stderr, /EPERM|EACCES/u);
    assert.equal(receipt.deniedExecutable, "/bin/sh");
  } catch (error) {
    if (/sandbox_apply: Operation not permitted/u.test(String(error.message ?? error))) {
      t.skip("current outer sandbox does not permit applying a nested sandbox-exec profile.");
      return;
    }
    throw error;
  }
});

test("Linux exec audit runs real strace probes and rejects external execs", async (t) => {
  if (process.platform !== "linux") {
    t.skip("Linux strace exec audit probe is only available on linux hosts.");
    return;
  }
  const receipt = await probePosixOfficeCliExecAudit({
    target: "linux-x64",
    timeoutMs: 15_000,
  });
  assert.equal(receipt.passed, true);
  assert.equal(receipt.positive.strategy, "linux-strace-execve-allowlist");
  assert.ok(receipt.positive.trace.entries.length >= 1);
  assert.match(receipt.externalSpawnRejection, /\/bin\/true/u);
  assert.match(receipt.execReplacementRejection, /\/bin\/true/u);
});
