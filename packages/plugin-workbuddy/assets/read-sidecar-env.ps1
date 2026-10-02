<#
.SYNOPSIS
    读取指定进程环境块里的单个键值（只读，不修改任何东西）。

.DESCRIPTION
    ★ 为什么需要它：WorkBuddy 桌面端给 sidecar 注入的网关口令
      （CODEBUDDY_GATEWAY_PASSWORD）**只存在于该子进程的内存**，磁盘上任何位置都没有
      （已核对 sessions/*.json、settings.json、keyblob、credentials/、last-launch.json）。
      Node 没有内建 FFI，PEB 走读没有纯 JS 路径，只能借道 PowerShell 的 Add-Type/P/Invoke。

    ★ 安全约束（务必保持）：
      1. **只读**：OpenProcess 只申请 PROCESS_QUERY_INFORMATION | PROCESS_VM_READ。
      2. **只吐目标键**：绝不把整个环境块写进 stdout。别的键（可能含其它密钥）一概不碰。
      3. **口令不经过 argv**：本脚本只接受 -ProcessId，值由被读进程的环境里取。
         （Windows 上 `Get-CimInstance Win32_Process` 让本机任何进程读到完整命令行。）
      4. **不回显**：出错时只报错误类型，不打印任何环境内容。

    退出码：0=读到了；2=拿不到（权限/进程已退出/键不存在）；1=用法错误。

.EXAMPLE
    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File read-sidecar-env.ps1 -ProcessId 22620
#>
[CmdletBinding()]
param(
    # ★ 不能叫 $Pid：PowerShell 有只读自动变量 $PID（当前进程号），同名参数会直接绑定失败。
    [Parameter(Mandatory = $true)]
    [int]$ProcessId
)

$ErrorActionPreference = 'Stop'
$TargetKey = 'CODEBUDDY_GATEWAY_PASSWORD'

if ($ProcessId -le 0) { Write-Error 'ProcessId must be a positive integer.'; exit 1 }

if (-not ('WbPeb.EnvReader' -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace WbPeb {
    public static class EnvReader {
        [StructLayout(LayoutKind.Sequential)]
        struct PROCESS_BASIC_INFORMATION {
            public IntPtr ExitStatus;      // NtQueryInformationProcess 的第 4 个参数
            public IntPtr PebBaseAddress;
            public IntPtr AffinityMask;
            public IntPtr BasePriority;
            public IntPtr UniqueProcessId;
            public IntPtr InheritedFromUniqueProcessId;
        }

        [DllImport("ntdll.dll")]
        static extern int NtQueryInformationProcess(
            IntPtr h, int cls, ref PROCESS_BASIC_INFORMATION info, int len, out int ret);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern IntPtr OpenProcess(int access, bool inherit, int pid);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool ReadProcessMemory(
            IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);

        [DllImport("kernel32.dll")]
        static extern bool CloseHandle(IntPtr h);

        const int PROCESS_QUERY_INFORMATION = 0x0400;
        const int PROCESS_VM_READ = 0x0010;
        // x64 上 ProcessParameters 里的 Environment / EnvironmentSize
        const int PP_ENVIRONMENT_PTR = 0x80;
        const int PP_ENVIRONMENT_SIZE = 0x3F0;

        /// <summary>返回该进程环境块的 UTF-16 文本；失败返回 null。</summary>
        public static string Read(int pid) {
            IntPtr h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
            if (h == IntPtr.Zero) return null;
            try {
                var info = new PROCESS_BASIC_INFORMATION();
                int ret;
                // 曾经三次 0xC0000004：结构体长度/字段顺序给错过。这里用 sizeof 传，不要写死。
                int st = NtQueryInformationProcess(h, 0, ref info,
                    Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)), out ret);
                if (st != 0) return null;
                if (info.PebBaseAddress == IntPtr.Zero) return null;

                // ProcessParameters 在 PEB 内的偏移是 0x20（x64）。
                IntPtr pp = ReadPtr(h, info.PebBaseAddress + 0x20, 8);
                if (pp == IntPtr.Zero) return null;
                IntPtr envPtr = ReadPtr(h, pp + PP_ENVIRONMENT_PTR, 8);
                int envSize = (int)ReadPtr(h, pp + PP_ENVIRONMENT_SIZE, 8);
                if (envPtr == IntPtr.Zero || envSize <= 0 || envSize > 4 * 1024 * 1024) return null;

                var buf = new byte[envSize];
                IntPtr got;
                if (!ReadProcessMemory(h, envPtr, buf, envSize, out got)) return null;
                return System.Text.Encoding.Unicode.GetString(buf);
            } finally { CloseHandle(h); }
        }

        static IntPtr ReadPtr(IntPtr h, IntPtr addr, int size) {
            var b = new byte[size];
            IntPtr got;
            if (!ReadProcessMemory(h, addr, b, size, out got)) return IntPtr.Zero;
            return new IntPtr(BitConverter.ToInt64(b, 0));
        }
    }
}
"@
}

try {
    $block = [WbPeb.EnvReader]::Read($ProcessId)
} catch {
    # 只报错误类型，不带任何环境内容
    [Console]::Error.WriteLine("read-sidecar-env: " + $_.Exception.GetType().Name)
    exit 2
}

if ([string]::IsNullOrEmpty($block)) {
    [Console]::Error.WriteLine('read-sidecar-env: environment block unavailable (process gone, or access denied)')
    exit 2
}

# 环境块是 \0 分隔的。只找目标键，精确匹配，避免 MY_<KEY> 这类含子串的键被误取。
foreach ($entry in $block.Split([char]0)) {
    if ([string]::IsNullOrEmpty($entry) -or $entry.StartsWith('=')) { continue }
    $eq = $entry.IndexOf('=')
    if ($eq -le 0) { continue }
    if ($entry.Substring(0, $eq) -cne $TargetKey) { continue }
    $value = $entry.Substring($eq + 1)
    if ($value.Length -gt 0) {
        [Console]::Out.Write($value)   # 无换行：调用方原样取
        exit 0
    }
}

[Console]::Error.WriteLine("read-sidecar-env: $TargetKey is not set in pid $ProcessId (it is injected by the desktop's sidecar-manager)")
exit 2
