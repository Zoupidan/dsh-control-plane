# 列出指定 pid 的 可执行文件名 + 完整命令行，每行 `pid<TAB>name<TAB>commandLine`。
#
# 只查、不改、不杀；只回命令行本身，不回环境变量（环境块里可能含别的密钥）。
#
# ★ 必须带 UTF-8 BOM：PowerShell 5.1 按 ANSI 解码无 BOM 的 .ps1，
#   脚本里的中文注释会变成野 token，直接 `Unexpected token '}'` 解析失败（实测）。
param(
    [Parameter(Mandatory = $true)][string]$ProcessIds
)

$ErrorActionPreference = 'SilentlyContinue'

# 一次 WMI 查询拿完所有 pid，不要逐个 Get-Process（后者在多目标上慢一个数量级）。
$targets = @()
foreach ($piece in ($ProcessIds -split ',')) {
    $p = 0
    if ([int]::TryParse($piece.Trim(), [ref]$p) -and $p -gt 0) { $targets += $p }
}
if ($targets.Count -eq 0) { return }

Get-CimInstance -ClassName Win32_Process |
    Where-Object { $targets -contains $_.ProcessId } |
    ForEach-Object {
        # 命令行里可能有 tab，只切前两个 tab，其余整段保留。
        "$($_.ProcessId)`t$($_.Name)`t$($_.CommandLine)"
    }
