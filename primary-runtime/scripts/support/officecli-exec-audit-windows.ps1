param(
  [Parameter(Mandatory = $true)]
  [string]$InputJson
)

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourcePath = Join-Path $scriptRoot "officecli-exec-audit-windows.cs"

if (-not (Test-Path -LiteralPath $InputJson)) {
  throw "Input JSON file does not exist: $InputJson"
}
if (-not (Test-Path -LiteralPath $sourcePath)) {
  throw "C# helper source does not exist: $sourcePath"
}

$source = Get-Content -LiteralPath $sourcePath -Raw -Encoding UTF8
Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies @(
  "System.dll",
  "System.Core.dll",
  "System.Web.Extensions.dll"
)

$inputText = Get-Content -LiteralPath $InputJson -Raw -Encoding UTF8
[Dascowork.OfficeCli.WindowsExecAudit]::RunJson($inputText)
