import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildWindowsExecAuditInvocation,
  buildWindowsNativeChildProcessProbe,
  officeCliWindowsExecAuditSchemaVersion,
  probeWindowsChildProcessRestriction,
  readWindowsExecAuditHelperSourceForTest,
  runWindowsOfficeCliExecAudit,
  windowsNativeChildProcessProbe,
  windowsExecAuditSupportFiles,
} from "../scripts/officecli-exec-audit-windows.mjs";

test("Windows OfficeCLI exec audit exposes stable support files and invocation", async () => {
  const support = windowsExecAuditSupportFiles();
  assert.equal(support.powershell.endsWith(join("support", "officecli-exec-audit-windows.ps1")), true);
  assert.equal(support.csharp.endsWith(join("support", "officecli-exec-audit-windows.cs")), true);
  await access(support.powershell);
  await access(support.csharp);
  assert.equal(support.childProbe.endsWith(join("support", "officecli-exec-audit-windows-child-probe.cs")), true);
  assert.equal(support.childProbeCompiler.endsWith(join("support", "officecli-exec-audit-windows-build-child-probe.ps1")), true);
  await access(support.childProbe);
  await access(support.childProbeCompiler);

  const invocation = buildWindowsExecAuditInvocation({
    inputJsonPath: "C:\\Temp\\officecli-input.json",
    powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  });
  assert.equal(invocation.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(invocation.args.slice(0, 6), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
  ]);
  assert.equal(invocation.args.at(-2), "-InputJson");
  assert.equal(invocation.args.at(-1), process.platform === "win32" ? "C:\\Temp\\officecli-input.json" : join(process.cwd(), "C:\\Temp\\officecli-input.json"));

  const defaultInvocation = buildWindowsExecAuditInvocation({
    inputJsonPath: "C:\\Temp\\officecli-input.json",
  });
  assert.match(defaultInvocation.command, /^C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/u);
});

test("Windows OfficeCLI child probe uses native Win32 target and exact 367 evidence", async () => {
  const source = await readWindowsExecAuditHelperSourceForTest();
  const moduleText = await import("../scripts/officecli-exec-audit-windows.mjs").then(async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    return await readFile(fileURLToPath(new URL("../scripts/officecli-exec-audit-windows.mjs", import.meta.url)), "utf8");
  });
  const probe = windowsNativeChildProcessProbe("C:\\Temp\\officecli-windows-child-probe.exe", "C:\\Windows");
  assert.equal(probe.executable, process.platform === "win32" ? "C:\\Temp\\officecli-windows-child-probe.exe" : join(process.cwd(), "C:\\Temp\\officecli-windows-child-probe.exe"));
  assert.deepEqual(probe.args, ["C:\\Windows\\System32\\cmd.exe"]);

  assert.match(moduleText, /buildWindowsNativeChildProcessProbe/u);
  assert.match(moduleText, /"-File",[\s\S]*?childProbeCompilerPath/u);
  assert.match(moduleText, /"-SourcePath",[\s\S]*?childProbeSourcePath/u);
  assert.match(moduleText, /"-OutputPath",[\s\S]*?outputPath/u);
  assert.doesNotMatch(moduleText, /"-Command",[\s\S]*?compileCommand/u);
  assert.match(moduleText, /allowedExitCodes: \[childProcessRestrictedExitCode\]/u);
  assert.match(moduleText, /child-blocked win32=367/u);
  assert.doesNotMatch(moduleText, /childProcessProbeScript/u);
  assert.doesNotMatch(moduleText, /spawnSync\(cmd/u);
  assert.doesNotMatch(moduleText, /error\.win32Code === 367/u);
  assert.doesNotMatch(moduleText, /error\.code === "UNKNOWN"/u);
  assert.doesNotMatch(moduleText, /Start-Process/u);

  assert.match(source.childProbe, /ERROR_CHILD_PROCESS_BLOCKED\s*=\s*367/u);
  assert.match(source.childProbe, /Marshal\.GetLastWin32Error\(\)/u);
  assert.match(source.childProbe, /error == ERROR_CHILD_PROCESS_BLOCKED/u);
  assert.match(source.childProbe, /child-blocked win32=367/u);
  assert.match(source.childProbe, /child-unexpected win32=/u);
  assert.match(source.childProbe, /\? ChildProcessRestrictedExitCode : UnexpectedExitCode/u);
  assert.match(source.childProbe, /return UnexpectedExitCode/u);
  assert.match(source.childProbe, /CreateProcessW\(/u);
  assert.match(source.childProbe, /DETACHED_PROCESS/u);
  assert.match(source.childProbe, /private static int EmitStdout/u);
  assert.match(source.childProbe, /WriteFile\(GetStdHandle\(STD_OUTPUT_HANDLE\)/u);
  assert.match(source.childProbe, /written != bytes\.Length/u);
  assert.match(source.childProbeCompiler, /param\(\s*\[Parameter\(Mandatory = \$true\)\]\s*\[string\]\$SourcePath/u);
  assert.match(source.childProbeCompiler, /\[string\]\$OutputPath/u);
  assert.match(source.childProbeCompiler, /Get-Content -LiteralPath \$SourcePath -Raw -Encoding UTF8/u);
  assert.match(source.childProbeCompiler, /-OutputAssembly \$OutputPath -OutputType WindowsApplication/u);
  assert.match(source.powershell, /"System\.dll"/u);
  assert.match(source.powershell, /"System\.Core\.dll"/u);
  assert.match(source.powershell, /"System\.Web\.Extensions\.dll"/u);
});

test("Windows OfficeCLI child probe compiles on native Windows", async (t) => {
  if (platform() !== "win32") {
    t.skip("requires native Windows PowerShell/.NET Framework compiler");
    return;
  }
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "officecli-windows-child-probe-test-"));
  try {
    const probe = await buildWindowsNativeChildProcessProbe({ tempParent: root });
    assert.equal(probe.args.length, 1);
    assert.match(probe.executable, /officecli-windows-child-probe\.exe$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows OfficeCLI exec audit helper has bounded cleanup budget and temp profile", async () => {
  const moduleText = await import("../scripts/officecli-exec-audit-windows.mjs").then(async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    return await readFile(fileURLToPath(new URL("../scripts/officecli-exec-audit-windows.mjs", import.meta.url)), "utf8");
  });
  assert.match(moduleText, /const helperCleanupGraceMs = 30_000/u);
  assert.match(moduleText, /const helperTemp = join\(root, "helper-temp"\)/u);
  assert.match(moduleText, /await mkdir\(helperTemp, \{ recursive: true \}\)/u);
  assert.match(moduleText, /env: windowsSystemEnvironment\(helperTemp\)/u);
  assert.match(moduleText, /timeoutMs: timeoutMs \+ helperCleanupGraceMs/u);
  assert.match(moduleText, /TEMP: tempRoot/u);
  assert.match(moduleText, /TMP: tempRoot/u);
  assert.match(moduleText, /LOCALAPPDATA: tempRoot/u);
});

test("Windows OfficeCLI exec audit passes a valid inherited stdin handle", async () => {
  const source = await readWindowsExecAuditHelperSourceForTest();
  assert.match(source.csharp, /OpenInheritedNullInput/u);
  assert.match(source.csharp, /CreateFileW\("NUL"/u);
  assert.match(source.csharp, /startup\.StartupInfo\.hStdInput = stdinRead/u);
  assert.doesNotMatch(source.csharp, /startup\.StartupInfo\.hStdInput = IntPtr\.Zero/u);
  assert.match(source.csharp, /CloseHandleIfNeeded\(stdinRead\)/u);
});

test("Windows OfficeCLI exec audit helper sets child process policy at process creation", async () => {
  const source = await readWindowsExecAuditHelperSourceForTest();
  assert.match(source.csharp, /PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY\s*=\s*0x0002000E/u);
  assert.match(source.csharp, /PROCESS_CREATION_CHILD_PROCESS_RESTRICTED\s*=\s*0x00000001/u);
  assert.match(source.csharp, /EXTENDED_STARTUPINFO_PRESENT/u);
  assert.match(source.csharp, /startup\.StartupInfo\.cb = restrictChildProcesses\s*\?\s*Marshal\.SizeOf\(typeof\(STARTUPINFOEX\)\)\s*:\s*Marshal\.SizeOf\(typeof\(STARTUPINFO\)\)/u);
  assert.match(source.csharp, /CreateProcessW\(/u);
  assert.match(source.csharp, /CREATE_SUSPENDED/u);
  assert.match(source.csharp, /DETACHED_PROCESS/u);
  assert.doesNotMatch(source.csharp, /CREATE_NO_WINDOW/u);
  assert.match(source.csharp, /AssignProcessToJobObject/u);
  assert.match(source.csharp, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/u);
  assert.match(source.csharp, /ChildProcessPolicyAttributeList/u);
  assert.doesNotMatch(source.csharp, /finally\s*\{\s*Marshal\.FreeHGlobal\(policy\);/u);
  assert.match(source.csharp, /stdoutThread\.Join\(5000\)/u);
  assert.match(source.csharp, /stderrThread\.Join\(5000\)/u);
  assert.match(source.csharp, /TerminateProcess\(pi\.hProcess, 125\)/u);
  assert.match(source.powershell, /Add-Type/u);
  assert.match(source.powershell, /RunJson/u);
});

test("Windows OfficeCLI exec audit preserves UTF-8 and validates argv contract", async () => {
  const source = await readWindowsExecAuditHelperSourceForTest();
  assert.match(source.powershell, /Console\]::InputEncoding = New-Object System\.Text\.UTF8Encoding\(\$false\)/u);
  assert.match(source.powershell, /Console\]::OutputEncoding = New-Object System\.Text\.UTF8Encoding\(\$false\)/u);
  assert.match(source.powershell, /\$OutputEncoding = New-Object System\.Text\.UTF8Encoding\(\$false\)/u);
  assert.match(source.powershell, /Get-Content -LiteralPath \$sourcePath -Raw -Encoding UTF8/u);
  assert.match(source.powershell, /Get-Content -LiteralPath \$InputJson -Raw -Encoding UTF8/u);
  assert.match(source.csharp, /Console\.InputEncoding = new UTF8Encoding\(false\)/u);
  assert.match(source.csharp, /Console\.OutputEncoding = new UTF8Encoding\(false\)/u);
  assert.match(source.csharp, /new StringBuilder\(QuoteCommandLine\(executable, args\)\)/u);
  assert.match(source.csharp, /CreateProcessW\(string lpApplicationName, StringBuilder lpCommandLine/u);
  assert.match(source.csharp, /var items = value as IEnumerable/u);
  assert.match(source.csharp, /throw new ArgumentException\(key \+ " must be an array/u);
  assert.doesNotMatch(source.csharp, /if \(array == null\) return new string\[0\]/u);
});

test("Windows OfficeCLI exec audit timeout cleanup is bounded and diagnostic", async () => {
  const source = await readWindowsExecAuditHelperSourceForTest();
  assert.match(source.powershell, /stage=powershell-start/u);
  assert.match(source.powershell, /stage=compile-helper/u);
  assert.match(source.powershell, /stage=run-helper/u);
  assert.match(source.csharp, /private static void Stage\(string name\)/u);
  assert.match(source.csharp, /Stage\("timeout-terminate-job"\)/u);
  assert.match(source.csharp, /TerminateJobObject\(job, 124\)/u);
  assert.match(source.csharp, /TerminateProcess\(pi\.hProcess, 124\)/u);
  assert.match(source.csharp, /WaitForSingleObject\(pi\.hProcess, 5000\)/u);
  assert.doesNotMatch(source.csharp, /WaitForSingleObject\(pi\.hProcess, INFINITE\)/u);
});

test("Windows OfficeCLI exec audit preserves helper stage diagnostics on target exit failure", async () => {
  const moduleText = await import("../scripts/officecli-exec-audit-windows.mjs").then(async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    return await readFile(fileURLToPath(new URL("../scripts/officecli-exec-audit-windows.mjs", import.meta.url)), "utf8");
  });
  assert.match(moduleText, /helperDiagnosticSuffix\(raw\.stderr\)/u);
  assert.match(moduleText, /^\s*function helperDiagnosticSuffix\(stderr\)/mu);
  assert.match(moduleText, /\^\s*\\\[officecli-exec-audit\\\] stage=/u);
  assert.match(moduleText, /\.slice\(-12\)/u);
});

test("Windows OfficeCLI exec audit refuses non-Windows hosts", async () => {
  if (platform() === "win32") {
    assert.equal(officeCliWindowsExecAuditSchemaVersion, "dascowork-officecli-exec-audit-windows.v1");
    return;
  }
  await assert.rejects(
    () => runWindowsOfficeCliExecAudit({
      executable: process.execPath,
      args: ["--version"],
    }),
    /requires a Windows host/u,
  );
});

test("Windows OfficeCLI child process restriction probe is a real Windows-only regression", async (t) => {
  if (platform() !== "win32") {
    t.skip("requires native Windows host to verify CreateProcessW child process policy");
    return;
  }
  const receipt = await probeWindowsChildProcessRestriction({ timeoutMs: 15_000 });
  assert.equal(receipt.schemaVersion, officeCliWindowsExecAuditSchemaVersion);
  assert.equal(receipt.passed, true);
  assert.equal(receipt.positive.command.exitCode, 0);
  assert.notEqual(receipt.restricted.command.exitCode, 0);
});
