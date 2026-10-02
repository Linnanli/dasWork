param(
  [Parameter(Mandatory = $true)]
  [string]$SourcePath,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"
[Console]::Error.WriteLine("[officecli-exec-audit] stage=child-probe-compiler-start")
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path -LiteralPath $SourcePath)) {
  throw "Child probe source file does not exist: $SourcePath"
}

[Console]::Error.WriteLine("[officecli-exec-audit] stage=child-probe-read-source")
$source = Get-Content -LiteralPath $SourcePath -Raw -Encoding UTF8
[Console]::Error.WriteLine("[officecli-exec-audit] stage=child-probe-add-type-start")
Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies @(
  "System.dll"
) -OutputAssembly $OutputPath -OutputType WindowsApplication
[Console]::Error.WriteLine("[officecli-exec-audit] stage=child-probe-add-type-ok")
