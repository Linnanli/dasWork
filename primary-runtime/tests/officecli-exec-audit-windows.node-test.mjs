import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildWindowsExecAuditInvocation,
  officeCliWindowsExecAuditSchemaVersion,
  probeWindowsChildProcessRestriction,
  readWindowsExecAuditHelperSourceForTest,
  runWindowsOfficeCliExecAudit,
  windowsExecAuditSupportFiles,
} from "../scripts/officecli-exec-audit-windows.mjs";

test("Windows OfficeCLI exec audit exposes stable support files and invocation", async () => {
  const support = windowsExecAuditSupportFiles();
  assert.equal(support.powershell.endsWith(join("support", "officecli-exec-audit-windows.ps1")), true);
  assert.equal(support.csharp.endsWith(join("support", "officecli-exec-audit-windows.cs")), true);
  await access(support.powershell);
  await access(support.csharp);

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

test("Windows OfficeCLI child probe uses direct ProcessStartInfo without shell execution", async () => {
  const source = await readWindowsExecAuditHelperSourceForTest();
  const moduleText = await import("../scripts/officecli-exec-audit-windows.mjs").then(async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    return await readFile(fileURLToPath(new URL("../scripts/officecli-exec-audit-windows.mjs", import.meta.url)), "utf8");
  });
  assert.match(moduleText, /New-Object System\.Diagnostics\.ProcessStartInfo/u);
  assert.match(moduleText, /\$info\.FileName = \$cmd/u);
  assert.match(moduleText, /\$info\.UseShellExecute = \$false/u);
  assert.match(moduleText, /\$info\.CreateNoWindow = \$true/u);
  assert.match(moduleText, /\[System\.Diagnostics\.Process\]::Start\(\$info\)/u);
  assert.doesNotMatch(moduleText, /Start-Process/u);
  assert.match(source.powershell, /"System\.dll"/u);
  assert.match(source.powershell, /"System\.Core\.dll"/u);
  assert.match(source.powershell, /"System\.Web\.Extensions\.dll"/u);
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
