using Microsoft.Win32.SafeHandles;
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace Dascowork.OfficeCli
{
    public static class WindowsExecAudit
    {
        private const int STARTF_USESTDHANDLES = 0x00000100;
        private const int EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        private const int CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        private const int CREATE_NO_WINDOW = 0x08000000;
        private const int CREATE_SUSPENDED = 0x00000004;
        private const int PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY = 0x0002000E;
        private const int PROCESS_CREATION_CHILD_PROCESS_RESTRICTED = 0x00000001;
        private const int HANDLE_FLAG_INHERIT = 0x00000001;
        private const int STARTUPINFOEX_ATTRIBUTE_COUNT = 1;
        private const uint WAIT_OBJECT_0 = 0x00000000;
        private const uint WAIT_TIMEOUT = 0x00000102;
        private const uint INFINITE = 0xFFFFFFFF;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        private const int JobObjectExtendedLimitInformation = 9;

        public static void RunJson(string inputJson)
        {
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);
            var serializer = new JavaScriptSerializer();
            Dictionary<string, object> input = null;
            try
            {
                input = serializer.Deserialize<Dictionary<string, object>>(inputJson);
                var result = Run(input);
                Console.Out.WriteLine(serializer.Serialize(result));
                Environment.Exit(Convert.ToInt32(result["helperExitCode"]));
            }
            catch (Exception ex)
            {
                var failed = new Dictionary<string, object>
                {
                    { "schemaVersion", "dascowork-officecli-exec-audit-windows.v1" },
                    { "helperExitCode", 98 },
                    { "error", ex.GetType().FullName + ": " + ex.Message }
                };
                Console.Out.WriteLine(serializer.Serialize(failed));
                Environment.Exit(98);
            }
        }

        private static Dictionary<string, object> Run(Dictionary<string, object> input)
        {
            var executable = RequiredString(input, "executable");
            var args = StringArray(input, "args");
            var cwd = OptionalString(input, "cwd");
            var env = StringMap(input, "env");
            var timeoutMs = OptionalInt(input, "timeoutMs", 45000);
            var restrictChildProcesses = OptionalBool(input, "restrictChildProcesses", true);
            var name = OptionalString(input, "name");
            if (String.IsNullOrWhiteSpace(name)) name = "officecli-windows-exec-audit";

            var stdoutRead = IntPtr.Zero;
            var stdoutWrite = IntPtr.Zero;
            var stderrRead = IntPtr.Zero;
            var stderrWrite = IntPtr.Zero;
            var childProcessPolicy = ChildProcessPolicyAttributeList.Empty;
            var environmentBlock = IntPtr.Zero;
            var job = IntPtr.Zero;
            var pi = new PROCESS_INFORMATION();
            var processCreated = false;
            var processResumed = false;
            var stdoutThreadResult = new CaptureResult();
            var stderrThreadResult = new CaptureResult();
            var startedAt = Stopwatch.StartNew();

            try
            {
                CreatePipePair(out stdoutRead, out stdoutWrite);
                CreatePipePair(out stderrRead, out stderrWrite);

                var startup = new STARTUPINFOEX();
                startup.StartupInfo.cb = restrictChildProcesses
                    ? Marshal.SizeOf(typeof(STARTUPINFOEX))
                    : Marshal.SizeOf(typeof(STARTUPINFO));
                startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
                startup.StartupInfo.hStdOutput = stdoutWrite;
                startup.StartupInfo.hStdError = stderrWrite;
                startup.StartupInfo.hStdInput = IntPtr.Zero;

                var creationFlags = CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW | CREATE_SUSPENDED;
                if (restrictChildProcesses)
                {
                    childProcessPolicy = CreateChildProcessPolicyAttributeList();
                    startup.lpAttributeList = childProcessPolicy.AttributeList;
                    creationFlags |= EXTENDED_STARTUPINFO_PRESENT;
                }

                var commandLine = new StringBuilder(QuoteCommandLine(executable, args));
                environmentBlock = BuildEnvironmentBlock(env);

                var created = CreateProcessW(
                    executable,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    creationFlags,
                    environmentBlock,
                    String.IsNullOrWhiteSpace(cwd) ? null : cwd,
                    ref startup,
                    out pi);
                if (!created)
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessW failed");
                }
                processCreated = true;

                CloseHandleIfNeeded(stdoutWrite);
                stdoutWrite = IntPtr.Zero;
                CloseHandleIfNeeded(stderrWrite);
                stderrWrite = IntPtr.Zero;

                job = CreateKillOnCloseJob();
                if (job == IntPtr.Zero)
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObjectW failed");
                }
                if (!AssignProcessToJobObject(job, pi.hProcess))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject failed");
                }

                var stdoutThread = StartCaptureThread(stdoutRead, stdoutThreadResult);
                var stderrThread = StartCaptureThread(stderrRead, stderrThreadResult);
                stdoutRead = IntPtr.Zero;
                stderrRead = IntPtr.Zero;

                if (ResumeThread(pi.hThread) == 0xFFFFFFFF)
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread failed");
                }
                processResumed = true;

                var waitResult = WaitForSingleObject(pi.hProcess, (uint)Math.Max(1, timeoutMs));
                var timedOut = waitResult == WAIT_TIMEOUT;
                if (timedOut)
                {
                    TerminateJobObject(job, 124);
                    WaitForSingleObject(pi.hProcess, INFINITE);
                }
                else if (waitResult != WAIT_OBJECT_0)
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject failed");
                }

                uint exitCode;
                if (!GetExitCodeProcess(pi.hProcess, out exitCode))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "GetExitCodeProcess failed");
                }

                if (!stdoutThread.Join(5000))
                {
                    throw new TimeoutException("stdout capture thread did not finish after process exit");
                }
                if (!stderrThread.Join(5000))
                {
                    throw new TimeoutException("stderr capture thread did not finish after process exit");
                }
                if (stdoutThreadResult.Error != null) throw stdoutThreadResult.Error;
                if (stderrThreadResult.Error != null) throw stderrThreadResult.Error;

                startedAt.Stop();
                return new Dictionary<string, object>
                {
                    { "schemaVersion", "dascowork-officecli-exec-audit-windows.v1" },
                    { "helperExitCode", 0 },
                    { "name", name },
                    { "policy", new Dictionary<string, object>
                        {
                            { "childProcessRestricted", restrictChildProcesses },
                            { "attribute", "PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY" },
                            { "value", "PROCESS_CREATION_CHILD_PROCESS_RESTRICTED" }
                        }
                    },
                    { "command", new Dictionary<string, object>
                        {
                            { "executable", executable },
                            { "args", args },
                            { "cwd", cwd },
                            { "exitCode", unchecked((int)exitCode) },
                            { "timedOut", timedOut },
                            { "elapsedMs", startedAt.ElapsedMilliseconds },
                            { "stdout", stdoutThreadResult.Text },
                            { "stderr", stderrThreadResult.Text },
                            { "stdoutBytes", stdoutThreadResult.Bytes },
                            { "stderrBytes", stderrThreadResult.Bytes }
                        }
                    }
                };
            }
            finally
            {
                if (processCreated && !processResumed && pi.hProcess != IntPtr.Zero)
                {
                    TerminateProcess(pi.hProcess, 125);
                }
                if (job != IntPtr.Zero) CloseHandle(job);
                if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
                if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
                if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
                childProcessPolicy.Dispose();
                CloseHandleIfNeeded(stdoutRead);
                CloseHandleIfNeeded(stdoutWrite);
                CloseHandleIfNeeded(stderrRead);
                CloseHandleIfNeeded(stderrWrite);
            }
        }

        private static ChildProcessPolicyAttributeList CreateChildProcessPolicyAttributeList()
        {
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, STARTUPINFOEX_ATTRIBUTE_COUNT, 0, ref size);
            var attributeList = Marshal.AllocHGlobal(size);
            var policy = IntPtr.Zero;
            if (!InitializeProcThreadAttributeList(attributeList, STARTUPINFOEX_ATTRIBUTE_COUNT, 0, ref size))
            {
                var error = Marshal.GetLastWin32Error();
                Marshal.FreeHGlobal(attributeList);
                throw new Win32Exception(error, "InitializeProcThreadAttributeList failed");
            }
            try
            {
                policy = Marshal.AllocHGlobal(sizeof(int));
                Marshal.WriteInt32(policy, PROCESS_CREATION_CHILD_PROCESS_RESTRICTED);
                if (!UpdateProcThreadAttribute(attributeList, 0, (IntPtr)PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY, policy, (IntPtr)sizeof(int), IntPtr.Zero, IntPtr.Zero))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "UpdateProcThreadAttribute child process policy failed");
                }
                return new ChildProcessPolicyAttributeList(attributeList, policy);
            }
            catch
            {
                if (policy != IntPtr.Zero) Marshal.FreeHGlobal(policy);
                DeleteProcThreadAttributeList(attributeList);
                Marshal.FreeHGlobal(attributeList);
                throw;
            }
        }

        private static IntPtr CreateKillOnCloseJob()
        {
            var job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero) return IntPtr.Zero;
            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            var length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            var pointer = Marshal.AllocHGlobal(length);
            try
            {
                Marshal.StructureToPtr(info, pointer, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, pointer, (uint)length))
                {
                    var error = Marshal.GetLastWin32Error();
                    CloseHandle(job);
                    throw new Win32Exception(error, "SetInformationJobObject failed");
                }
            }
            finally
            {
                Marshal.FreeHGlobal(pointer);
            }
            return job;
        }

        private static Thread StartCaptureThread(IntPtr readHandle, CaptureResult result)
        {
            var safeHandle = new SafeFileHandle(readHandle, true);
            var thread = new Thread(() =>
            {
                try
                {
                    using (var stream = new FileStream(safeHandle, FileAccess.Read, 4096, false))
                    using (var memory = new MemoryStream())
                    {
                        var buffer = new byte[4096];
                        int read;
                        while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
                        {
                            result.Bytes += read;
                            if (result.Bytes > 16384)
                            {
                                throw new InvalidOperationException("captured output exceeded 16384 bytes");
                            }
                            memory.Write(buffer, 0, read);
                        }
                        result.Text = Encoding.UTF8.GetString(memory.ToArray());
                    }
                }
                catch (Exception ex)
                {
                    result.Error = ex;
                }
            });
            thread.IsBackground = true;
            thread.Start();
            return thread;
        }

        private static void CreatePipePair(out IntPtr readPipe, out IntPtr writePipe)
        {
            var security = new SECURITY_ATTRIBUTES();
            security.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            security.bInheritHandle = true;
            security.lpSecurityDescriptor = IntPtr.Zero;
            if (!CreatePipe(out readPipe, out writePipe, ref security, 0))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreatePipe failed");
            }
            if (!SetHandleInformation(readPipe, HANDLE_FLAG_INHERIT, 0))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SetHandleInformation failed");
            }
        }

        private static IntPtr BuildEnvironmentBlock(Dictionary<string, string> env)
        {
            var keys = new List<string>(env.Keys);
            keys.Sort(StringComparer.OrdinalIgnoreCase);
            var builder = new StringBuilder();
            foreach (var key in keys)
            {
                if (String.IsNullOrEmpty(key) || key.IndexOf('=') >= 0) continue;
                builder.Append(key).Append('=').Append(env[key] ?? String.Empty).Append('\0');
            }
            builder.Append('\0');
            var bytes = Encoding.Unicode.GetBytes(builder.ToString());
            var pointer = Marshal.AllocHGlobal(bytes.Length);
            Marshal.Copy(bytes, 0, pointer, bytes.Length);
            return pointer;
        }

        private static string QuoteCommandLine(string executable, string[] args)
        {
            var builder = new StringBuilder();
            builder.Append(QuoteArgument(executable));
            foreach (var arg in args)
            {
                builder.Append(' ').Append(QuoteArgument(arg));
            }
            return builder.ToString();
        }

        private static string QuoteArgument(string value)
        {
            if (value == null) return "\"\"";
            if (value.Length == 0) return "\"\"";
            var needsQuotes = value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) >= 0;
            if (!needsQuotes) return value;
            var builder = new StringBuilder();
            builder.Append('"');
            var backslashes = 0;
            foreach (var ch in value)
            {
                if (ch == '\\')
                {
                    backslashes++;
                    continue;
                }
                if (ch == '"')
                {
                    builder.Append('\\', backslashes * 2 + 1);
                    builder.Append('"');
                    backslashes = 0;
                    continue;
                }
                builder.Append('\\', backslashes);
                backslashes = 0;
                builder.Append(ch);
            }
            builder.Append('\\', backslashes * 2);
            builder.Append('"');
            return builder.ToString();
        }

        private static string RequiredString(Dictionary<string, object> input, string key)
        {
            var value = OptionalString(input, key);
            if (String.IsNullOrWhiteSpace(value)) throw new ArgumentException("missing " + key);
            return value;
        }

        private static string OptionalString(Dictionary<string, object> input, string key)
        {
            object value;
            return input.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : null;
        }

        private static int OptionalInt(Dictionary<string, object> input, string key, int defaultValue)
        {
            object value;
            return input.TryGetValue(key, out value) && value != null ? Convert.ToInt32(value) : defaultValue;
        }

        private static bool OptionalBool(Dictionary<string, object> input, string key, bool defaultValue)
        {
            object value;
            return input.TryGetValue(key, out value) && value != null ? Convert.ToBoolean(value) : defaultValue;
        }

        private static string[] StringArray(Dictionary<string, object> input, string key)
        {
            object value;
            if (!input.TryGetValue(key, out value) || value == null) return new string[0];
            if (value is string)
            {
                throw new ArgumentException(key + " must be an array, not a string");
            }
            var items = value as IEnumerable;
            if (items == null)
            {
                throw new ArgumentException(key + " must be an array");
            }
            var result = new List<string>();
            foreach (var item in items)
            {
                if (item == null)
                {
                    throw new ArgumentException(key + " contains null item");
                }
                if (item is Dictionary<string, object> || item is ArrayList)
                {
                    throw new ArgumentException(key + " must contain only scalar values");
                }
                result.Add(Convert.ToString(item));
            }
            return result.ToArray();
        }

        private static Dictionary<string, string> StringMap(Dictionary<string, object> input, string key)
        {
            var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            object value;
            if (!input.TryGetValue(key, out value) || value == null) return result;
            var map = value as Dictionary<string, object>;
            if (map == null) return result;
            foreach (var entry in map)
            {
                if (entry.Value != null) result[entry.Key] = Convert.ToString(entry.Value);
            }
            return result;
        }

        private static void CloseHandleIfNeeded(IntPtr handle)
        {
            if (handle != IntPtr.Zero) CloseHandle(handle);
        }

        private sealed class CaptureResult
        {
            public string Text = "";
            public int Bytes = 0;
            public Exception Error = null;
        }

        private struct ChildProcessPolicyAttributeList
        {
            public static readonly ChildProcessPolicyAttributeList Empty = new ChildProcessPolicyAttributeList(IntPtr.Zero, IntPtr.Zero);
            public readonly IntPtr AttributeList;
            private readonly IntPtr policyValue;

            public ChildProcessPolicyAttributeList(IntPtr attributeList, IntPtr policyValue)
            {
                this.AttributeList = attributeList;
                this.policyValue = policyValue;
            }

            public void Dispose()
            {
                if (AttributeList != IntPtr.Zero)
                {
                    DeleteProcThreadAttributeList(AttributeList);
                    Marshal.FreeHGlobal(AttributeList);
                }
                if (policyValue != IntPtr.Zero)
                {
                    Marshal.FreeHGlobal(policyValue);
                }
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SECURITY_ATTRIBUTES
        {
            public int nLength;
            public IntPtr lpSecurityDescriptor;
            [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFO
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public int dwX;
            public int dwY;
            public int dwXSize;
            public int dwYSize;
            public int dwXCountChars;
            public int dwYCountChars;
            public int dwFillAttribute;
            public int dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFOEX
        {
            public STARTUPINFO StartupInfo;
            public IntPtr lpAttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public int dwProcessId;
            public int dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe, ref SECURITY_ATTRIBUTES lpPipeAttributes, int nSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetHandleInformation(IntPtr hObject, int dwMask, int dwFlags);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CreateProcessW(string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, int dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFOEX lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr attribute, IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);

        [DllImport("kernel32.dll", SetLastError = false)]
        private static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr hThread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr hJob, int jobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);
    }
}
