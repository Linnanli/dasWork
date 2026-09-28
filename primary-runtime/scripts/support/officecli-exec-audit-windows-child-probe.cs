using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace Dascowork.OfficeCli
{
    public static class WindowsChildProcessProbe
    {
        private const int ChildProcessRestrictedExitCode = 23;
        private const int UnexpectedExitCode = 24;
        private const int ERROR_CHILD_PROCESS_BLOCKED = 367;
        private const int DETACHED_PROCESS = 0x00000008;
        private const int CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        private const uint WAIT_OBJECT_0 = 0x00000000;
        private const uint WAIT_TIMEOUT = 0x00000102;
        private const int STD_OUTPUT_HANDLE = -11;

        public static int Main(string[] args)
        {
            if (args.Length != 1 || String.IsNullOrWhiteSpace(args[0]))
            {
                return EmitUnexpected("child-unexpected reason=missing-command\n");
            }

            var startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            var processInformation = new PROCESS_INFORMATION();
            var commandLine = new StringBuilder(QuoteArgument(args[0]) + " /d /q /c exit 0");
            var created = CreateProcessW(
                args[0],
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                CREATE_UNICODE_ENVIRONMENT | DETACHED_PROCESS,
                IntPtr.Zero,
                null,
                ref startup,
                out processInformation);

            if (!created)
            {
                var error = Marshal.GetLastWin32Error();
                if (error == ERROR_CHILD_PROCESS_BLOCKED)
                {
                    return EmitStdout("child-blocked win32=367\n") == 0 ? ChildProcessRestrictedExitCode : UnexpectedExitCode;
                }
                return EmitUnexpected("child-unexpected win32=" + error + " message=" + new Win32Exception(error).Message + "\n");
            }

            try
            {
                var waitResult = WaitForSingleObject(processInformation.hProcess, 10000);
                if (waitResult != WAIT_OBJECT_0)
                {
                    if (waitResult == WAIT_TIMEOUT) TerminateProcess(processInformation.hProcess, 124);
                    return EmitUnexpected("child-unexpected wait=" + waitResult + "\n");
                }
                uint exitCode;
                if (!GetExitCodeProcess(processInformation.hProcess, out exitCode))
                {
                    var error = Marshal.GetLastWin32Error();
                    return EmitUnexpected("child-unexpected getexit-win32=" + error + "\n");
                }
                if (exitCode == 0)
                {
                    return EmitStdout("child-started\n");
                }
                return EmitUnexpected("child-unexpected child-exit=" + exitCode + "\n");
            }
            finally
            {
                if (processInformation.hThread != IntPtr.Zero) CloseHandle(processInformation.hThread);
                if (processInformation.hProcess != IntPtr.Zero) CloseHandle(processInformation.hProcess);
            }
        }

        private static int EmitUnexpected(string text)
        {
            EmitStdout(text);
            return UnexpectedExitCode;
        }

        private static int EmitStdout(string text)
        {
            var bytes = Encoding.UTF8.GetBytes(text);
            uint written;
            if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), bytes, (uint)bytes.Length, out written, IntPtr.Zero) || written != bytes.Length)
            {
                return UnexpectedExitCode;
            }
            return 0;
        }

        private static string QuoteArgument(string value)
        {
            if (String.IsNullOrEmpty(value)) return "\"\"";
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

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CreateProcessW(
            string lpApplicationName,
            StringBuilder lpCommandLine,
            IntPtr lpProcessAttributes,
            IntPtr lpThreadAttributes,
            bool bInheritHandles,
            int dwCreationFlags,
            IntPtr lpEnvironment,
            string lpCurrentDirectory,
            ref STARTUPINFO lpStartupInfo,
            out PROCESS_INFORMATION lpProcessInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetStdHandle(int nStdHandle);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool WriteFile(IntPtr hFile, byte[] lpBuffer, uint nNumberOfBytesToWrite, out uint lpNumberOfBytesWritten, IntPtr lpOverlapped);

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

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public int dwProcessId;
            public int dwThreadId;
        }
    }
}
