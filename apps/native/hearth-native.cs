using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class HearthNative
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint INFINITE = 0xFFFFFFFF;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009;
    private const uint PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016;
    private const uint FILE_GENERIC_READ = 0x00120089;
    private const uint FILE_GENERIC_WRITE = 0x00120116;
    private const uint FILE_GENERIC_EXECUTE = 0x001200A0;

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
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_CAPABILITIES
    {
        public IntPtr AppContainerSid;
        public IntPtr Capabilities;
        public uint CapabilityCount;
        public uint Reserved;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct COORD
    {
        public short X;
        public short Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
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

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr hThread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int nStdHandle);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcess(
        string lpApplicationName, string lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes,
        bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory,
        ref STARTUPINFOEX lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr attribute, IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe, ref SECURITY_ATTRIBUTES lpPipeAttributes, uint nSize);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadFile(IntPtr hFile, byte[] lpBuffer, uint nNumberOfBytesToRead, out uint lpNumberOfBytesRead, IntPtr lpOverlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteFile(IntPtr hFile, byte[] lpBuffer, uint nNumberOfBytesToWrite, out uint lpNumberOfBytesWritten, IntPtr lpOverlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int CreatePseudoConsole(COORD size, IntPtr hInput, IntPtr hOutput, uint flags, out IntPtr phPC);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int ResizePseudoConsole(IntPtr hPC, COORD size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern void ClosePseudoConsole(IntPtr hPC);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int CreateAppContainerProfile(string pszAppContainerName, string pszDisplayName, string pszDescription, IntPtr pCapabilities, uint dwCapabilityCount, out IntPtr ppSidAppContainerSid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int DeriveAppContainerSidFromAppContainerName(string pszAppContainerName, out IntPtr ppSidAppContainerSid);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool ConvertSidToStringSid(IntPtr Sid, out string StringSid);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool ConvertStringSidToSid(string StringSid, out IntPtr Sid);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr hMem);

    private static int Main(string[] args)
    {
        if (args.Length == 0) return Usage();
        switch (args[0])
        {
            case "lease": return Lease(args);
            case "process-info": return ProcessInfo(args);
            case "sandbox": return Sandbox(args);
            case "pty": return Pty(args);
            case "version": Console.WriteLine("hearth-native 0.4.0"); return 0;
            default: return Usage();
        }
    }

    private static int Usage()
    {
        Console.Error.WriteLine("hearth-native lease|process-info|sandbox|pty|version");
        return 2;
    }

    private static int Lease(string[] args)
    {
        string name = Arg(args, "--name");
        if (string.IsNullOrWhiteSpace(name)) return Usage();
        Mutex mutex;
        bool acquired;
        try
        {
            mutex = new Mutex(false, "Global\\Hearth.Host." + name);
            try { acquired = mutex.WaitOne(0); }
            catch (AbandonedMutexException) { acquired = true; }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("lease-error: " + error.Message);
            return 127;
        }
        if (!acquired)
        {
            Console.Error.WriteLine("lease-busy");
            return 2;
        }
        Console.Out.WriteLine("ACQUIRED");
        Console.Out.Flush();
        try
        {
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                if (line == "release") break;
            }
        }
        finally
        {
            try { mutex.ReleaseMutex(); } catch { }
            mutex.Dispose();
        }
        return 0;
    }

    private static int ProcessInfo(string[] args)
    {
        int pid;
        if (!int.TryParse(Arg(args, "--pid"), out pid)) return Usage();
        try
        {
            var process = Process.GetProcessById(pid);
            Console.WriteLine("{\"pid\":" + pid + ",\"startedAt\":\"" + process.StartTime.ToUniversalTime().ToString("o") + "\"}");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("process-info-error: " + error.Message);
            return 1;
        }
    }

    private static int Sandbox(string[] args)
    {
        return RunSandbox(args, false);
    }

    private static int Pty(string[] args)
    {
        return RunSandbox(args, true);
    }

    private static int RunSandbox(string[] args, bool usePty)
    {
        if (usePty)
        {
            try { Console.InputEncoding = Encoding.UTF8; } catch { }
        }
        string workspace = Arg(args, "--workspace");
        string temp = Arg(args, "--temp");
        string mode = Arg(args, "--mode");
        string network = Arg(args, "--network") ?? "deny";
        string parentPidText = Arg(args, "--parent-pid");
        string command = Arg(args, "--");
        if (string.IsNullOrWhiteSpace(workspace) || string.IsNullOrWhiteSpace(temp) || string.IsNullOrWhiteSpace(command))
        {
            Console.Error.WriteLine("sandbox-error: missing --workspace, --temp or command");
            return 127;
        }
        if (mode != "read-only" && mode != "workspace-write")
        {
            Console.Error.WriteLine("sandbox-error: invalid mode " + mode);
            return 127;
        }
        if (network != "deny" && network != "allow")
        {
            Console.Error.WriteLine("sandbox-error: invalid network " + network);
            return 127;
        }
        int parentPid = 0;
        int.TryParse(parentPidText, out parentPid);

        IntPtr packageSid = IntPtr.Zero;
        string packageName = "hearth.sandbox." + StableName(workspace);
        try
        {
            packageSid = EnsureAppContainer(packageName);
            string sidText = SidString(packageSid);
            GrantFresh(workspace, sidText, mode == "workspace-write" ? "M" : "RX");
            GrantFresh(temp, sidText, "M");
            if (mode == "workspace-write")
            {
                foreach (string extra in Args(args, "--write")) GrantFresh(extra, sidText, "M");
            }
            foreach (string extra in Args(args, "--read"))
            {
                GrantFresh(extra, sidText, "RX");
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("sandbox-error: " + error.Message);
            return 127;
        }

        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            Console.Error.WriteLine("sandbox-error: CreateJobObject failed " + Marshal.GetLastWin32Error());
            return 127;
        }
        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int limitSize = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr limitPtr = Marshal.AllocHGlobal(limitSize);
        Marshal.StructureToPtr(limits, limitPtr, false);
        if (!SetInformationJobObject(job, 9, limitPtr, (uint)limitSize))
        {
            Console.Error.WriteLine("sandbox-error: SetInformationJobObject failed " + Marshal.GetLastWin32Error());
            Marshal.FreeHGlobal(limitPtr);
            CloseHandle(job);
            return 127;
        }
        Marshal.FreeHGlobal(limitPtr);

        if (parentPid > 0) StartParentWatchdog(parentPid, job);

        IntPtr attrList = IntPtr.Zero;
        IntPtr pseudoConsole = IntPtr.Zero;
        IntPtr ptyInput = IntPtr.Zero;
        IntPtr ptyOutput = IntPtr.Zero;
        IntPtr ptyInputRead = IntPtr.Zero;
        int attributeCount = usePty ? 2 : 1;
        var startup = new STARTUPINFOEX();
        startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        if (usePty)
        {
            int cols = 120;
            int rows = 30;
            int.TryParse(Arg(args, "--cols"), out cols);
            int.TryParse(Arg(args, "--rows"), out rows);
            var attributes = new SECURITY_ATTRIBUTES();
            attributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            attributes.bInheritHandle = false;
            IntPtr inputRead, inputWrite, outputRead, outputWrite;
            if (!CreatePipe(out inputRead, out inputWrite, ref attributes, 0) ||
                !CreatePipe(out outputRead, out outputWrite, ref attributes, 0))
            {
                Console.Error.WriteLine("sandbox-error: CreatePipe failed " + Marshal.GetLastWin32Error());
                CloseHandle(job);
                return 127;
            }
            var consoleSize = new COORD { X = (short)Math.Max(20, cols), Y = (short)Math.Max(5, rows) };
            int hr = CreatePseudoConsole(consoleSize, inputRead, outputWrite, 0, out pseudoConsole);
            CloseHandle(outputWrite);
            if (hr < 0)
            {
                Console.Error.WriteLine("sandbox-error: CreatePseudoConsole failed 0x" + hr.ToString("X8"));
                CloseHandle(inputWrite);
                CloseHandle(outputRead);
                CloseHandle(job);
                return 127;
            }
            ptyInputRead = inputRead;
            ptyInput = inputWrite;
            ptyOutput = outputRead;
            startup.StartupInfo.dwFlags = (int)STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = new IntPtr(-1);
            startup.StartupInfo.hStdOutput = new IntPtr(-1);
            startup.StartupInfo.hStdError = new IntPtr(-1);
        }
        else
        {
            startup.StartupInfo.dwFlags = (int)STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = GetStdHandle(-10);
            startup.StartupInfo.hStdOutput = GetStdHandle(-11);
            startup.StartupInfo.hStdError = GetStdHandle(-12);
        }

        var capabilities = new SECURITY_CAPABILITIES();
        capabilities.AppContainerSid = packageSid;
        capabilities.CapabilityCount = 0;
        capabilities.Capabilities = IntPtr.Zero;
        IntPtr capPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)));
        Marshal.StructureToPtr(capabilities, capPtr, false);

        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, attributeCount, 0, ref size);
        attrList = Marshal.AllocHGlobal(size);
        if (!InitializeProcThreadAttributeList(attrList, attributeCount, 0, ref size))
        {
            Console.Error.WriteLine("sandbox-error: InitializeProcThreadAttributeList failed " + Marshal.GetLastWin32Error());
            Marshal.FreeHGlobal(capPtr);
            if (pseudoConsole != IntPtr.Zero) ClosePseudoConsole(pseudoConsole);
            CloseHandle(job);
            return 127;
        }
        if (!UpdateProcThreadAttribute(attrList, 0, (IntPtr)PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, capPtr, (IntPtr)Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)), IntPtr.Zero, IntPtr.Zero))
        {
            Console.Error.WriteLine("sandbox-error: UpdateProcThreadAttribute failed " + Marshal.GetLastWin32Error());
            DeleteProcThreadAttributeList(attrList);
            Marshal.FreeHGlobal(attrList);
            Marshal.FreeHGlobal(capPtr);
            if (pseudoConsole != IntPtr.Zero) ClosePseudoConsole(pseudoConsole);
            CloseHandle(job);
            return 127;
        }
        if (usePty && !UpdateProcThreadAttribute(attrList, 0, (IntPtr)PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, pseudoConsole, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
        {
            Console.Error.WriteLine("sandbox-error: UpdateProcThreadAttribute(pty) failed " + Marshal.GetLastWin32Error());
            DeleteProcThreadAttributeList(attrList);
            Marshal.FreeHGlobal(attrList);
            Marshal.FreeHGlobal(capPtr);
            ClosePseudoConsole(pseudoConsole);
            CloseHandle(job);
            return 127;
        }
        startup.lpAttributeList = attrList;

        IntPtr environment = BuildEnvironment(temp);
        var info = new PROCESS_INFORMATION();
        bool created = CreateProcess(
            null, command, IntPtr.Zero, IntPtr.Zero, !usePty,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
            environment, workspace, ref startup, out info);
        int createError = Marshal.GetLastWin32Error();
        Marshal.FreeHGlobal(environment);
        if (ptyInputRead != IntPtr.Zero)
        {
            CloseHandle(ptyInputRead);
            ptyInputRead = IntPtr.Zero;
        }
        DeleteProcThreadAttributeList(attrList);
        Marshal.FreeHGlobal(attrList);
        Marshal.FreeHGlobal(capPtr);
        if (!created)
        {
            Console.Error.WriteLine("sandbox-error: CreateProcess failed " + createError);
            if (pseudoConsole != IntPtr.Zero) ClosePseudoConsole(pseudoConsole);
            if (ptyInput != IntPtr.Zero) CloseHandle(ptyInput);
            if (ptyOutput != IntPtr.Zero) CloseHandle(ptyOutput);
            CloseHandle(job);
            return 127;
        }
        if (!AssignProcessToJobObject(job, info.hProcess))
        {
            Console.Error.WriteLine("sandbox-error: AssignProcessToJobObject failed " + Marshal.GetLastWin32Error());
            TerminateJobObject(job, 127);
            CloseHandle(info.hThread);
            CloseHandle(info.hProcess);
            if (pseudoConsole != IntPtr.Zero) ClosePseudoConsole(pseudoConsole);
            if (ptyInput != IntPtr.Zero) CloseHandle(ptyInput);
            if (ptyOutput != IntPtr.Zero) CloseHandle(ptyOutput);
            CloseHandle(job);
            return 127;
        }
        ResumeThread(info.hThread);
        CloseHandle(info.hThread);

        if (usePty)
        {
            StartPtyOutput(ptyOutput);
            StartPtyInput(ptyInput, pseudoConsole);
        }

        WaitForSingleObject(info.hProcess, INFINITE);
        uint exitCode = 1;
        GetExitCodeProcess(info.hProcess, out exitCode);
        CloseHandle(info.hProcess);
        if (pseudoConsole != IntPtr.Zero)
        {
            ClosePseudoConsole(pseudoConsole);
            CloseHandle(ptyInput);
            CloseHandle(ptyOutput);
        }
        CloseHandle(job);
        return unchecked((int)exitCode);
    }

    private static void StartPtyOutput(IntPtr outputRead)
    {
        var thread = new Thread(() =>
        {
            byte[] buffer = new byte[8192];
            var stdout = Console.OpenStandardOutput();
            while (true)
            {
                uint read;
                if (!ReadFile(outputRead, buffer, (uint)buffer.Length, out read, IntPtr.Zero) || read == 0) break;
                try { stdout.Write(buffer, 0, (int)read); }
                catch { break; }
            }
        });
        thread.IsBackground = true;
        thread.Start();
    }

    private static void StartPtyInput(IntPtr inputWrite, IntPtr pseudoConsole)
    {
        var thread = new Thread(() =>
        {
            byte[] buffer = new byte[4096];
            var stdin = Console.OpenStandardInput();
            while (true)
            {
                int read;
                try { read = stdin.Read(buffer, 0, buffer.Length); }
                catch { break; }
                if (read <= 0) break;
                if (TryResizeBytes(buffer, read, pseudoConsole)) continue;
                uint written;
                if (!WriteFile(inputWrite, buffer, (uint)read, out written, IntPtr.Zero)) break;
            }
            CloseHandle(inputWrite);
        });
        thread.IsBackground = true;
        thread.Start();
    }

    private static bool TryResizeBytes(byte[] buffer, int length, IntPtr pseudoConsole)
    {
        const string prefix = "\u001bHEARTH_RESIZE:";
        if (length < prefix.Length) return false;
        for (int i = 0; i < prefix.Length; i++)
        {
            if (buffer[i] != (byte)prefix[i]) return false;
        }
        int end = Array.IndexOf(buffer, (byte)'\n', prefix.Length, length - prefix.Length);
        if (end < 0) return false;
        string payload = Encoding.ASCII.GetString(buffer, prefix.Length, end - prefix.Length);
        string[] parts = payload.Split(',');
        int cols, rows;
        if (parts.Length == 2 && int.TryParse(parts[0], out cols) && int.TryParse(parts[1], out rows))
        {
            var size = new COORD { X = (short)Math.Max(20, cols), Y = (short)Math.Max(5, rows) };
            ResizePseudoConsole(pseudoConsole, size);
        }
        return true;
    }

    private static IntPtr EnsureAppContainer(string name)
    {
        IntPtr sid = IntPtr.Zero;
        int hr = CreateAppContainerProfile(name, name, "Hearth sandbox", IntPtr.Zero, 0, out sid);
        if (hr >= 0) return sid;
        if (hr == unchecked((int)0x800700B7))
        {
            if (DeriveAppContainerSidFromAppContainerName(name, out sid) >= 0) return sid;
        }
        throw new Exception("CreateAppContainerProfile failed 0x" + hr.ToString("X8"));
    }

    private static string SidString(IntPtr sid)
    {
        string text;
        if (!ConvertSidToStringSid(sid, out text)) throw new Exception("ConvertSidToStringSid failed " + Marshal.GetLastWin32Error());
        return text;
    }

    private static void GrantFresh(string path, string sid, string rights)
    {
        if (string.IsNullOrWhiteSpace(path)) return;
        RunIcacls(new[] { path, "/remove", "*" + sid, "/C", "/Q" });
        string ace = Directory.Exists(path) ? "(OI)(CI)" + rights : (rights == "M" ? "M" : "R");
        RunIcacls(new[] { path, "/grant", "*" + sid + ":" + ace, "/C", "/Q" });
    }

    private static void RunIcacls(string[] args)
    {
        var start = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "icacls.exe"));
        start.Arguments = JoinQuoted(args);
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        using (var process = Process.Start(start))
        {
            string output = process.StandardOutput.ReadToEnd();
            string error = process.StandardError.ReadToEnd();
            process.WaitForExit();
            if (process.ExitCode != 0) throw new Exception("icacls failed: " + error.Trim() + " " + output.Trim());
        }
    }

    private static string JoinQuoted(IEnumerable<string> values)
    {
        var builder = new StringBuilder();
        foreach (string value in values)
        {
            if (builder.Length > 0) builder.Append(' ');
            builder.Append(Quote(value));
        }
        return builder.ToString();
    }

    private static string Quote(string value)
    {
        if (value.Length > 0 && !value.Contains(" ") && !value.Contains("\t") && !value.Contains("\""))
            return value;
        var builder = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { backslashes++; continue; }
            if (c == '"')
            {
                builder.Append('\\', backslashes * 2 + 1);
                builder.Append('"');
                backslashes = 0;
                continue;
            }
            builder.Append('\\', backslashes);
            backslashes = 0;
            builder.Append(c);
        }
        builder.Append('\\', backslashes * 2);
        builder.Append('"');
        return builder.ToString();
    }

    private static IntPtr BuildEnvironment(string temp)
    {
        var values = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            string key = Convert.ToString(entry.Key);
            string value = Convert.ToString(entry.Value);
            if (string.IsNullOrEmpty(key)) continue;
            if (IsSecret(key)) continue;
            values[key] = value;
        }
        values["TMP"] = temp;
        values["TEMP"] = temp;
        var builder = new StringBuilder();
        foreach (var pair in values)
        {
            builder.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
        }
        builder.Append('\0');
        byte[] bytes = Encoding.Unicode.GetBytes(builder.ToString());
        IntPtr pointer = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes, 0, pointer, bytes.Length);
        return pointer;
    }

    private static bool IsSecret(string key)
    {
        string upper = key.ToUpperInvariant();
        if (upper.EndsWith("_API_KEY") || upper.EndsWith("_TOKEN") || upper.EndsWith("_SECRET")) return true;
        if (upper.StartsWith("OPENAI_") || upper.StartsWith("ANTHROPIC_") || upper.StartsWith("CODEX_")) return true;
        if (upper.StartsWith("HEARTH_") && upper != "HEARTH_DESKTOP") return true;
        return false;
    }

    private static void StartParentWatchdog(int parentPid, IntPtr job)
    {
        var thread = new Thread(() =>
        {
            while (true)
            {
                Thread.Sleep(500);
                try
                {
                    Process.GetProcessById(parentPid);
                }
                catch
                {
                    TerminateJobObject(job, 127);
                    return;
                }
            }
        });
        thread.IsBackground = true;
        thread.Start();
    }

    private static string Arg(string[] args, string name)
    {
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (name == "--" && args[i] == "--")
            {
                var command = new List<string>();
                for (int j = i + 1; j < args.Length; j++) command.Add(args[j]);
                return JoinQuoted(command);
            }
            if (args[i] == name) return args[i + 1];
        }
        return null;
    }

    private static IEnumerable<string> Args(string[] args, string name)
    {
        var result = new List<string>();
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == name && args[i + 1] != "--") result.Add(args[i + 1]);
        }
        return result;
    }

    private static string StableName(string value)
    {
        uint hash = 0;
        foreach (char c in value.ToLowerInvariant()) hash = hash * 31 + c;
        return Math.Abs((long)hash).ToString("x8");
    }
}
