param([switch]$NoRemote,[string]$Repo,[int]$MaxWorkers=3)
$ErrorActionPreference='Stop'
$taskHubRoot=Split-Path -Parent $PSScriptRoot
$taskFixture=Join-Path $taskHubRoot 'fixtures\pilot'
$taskServer=Join-Path $taskHubRoot 'dist\server.js'
if(-not(Test-Path -LiteralPath $taskServer)){throw 'Build first with npm.cmd run build.'}
$taskNode=(Get-Command node -CommandType Application).Source
# The Codex app and winget do not always put codex/opencode on PATH; fall back to their install folders.
$taskCodex=(Get-Command codex -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if(-not $taskCodex){$taskCodex=(Get-ChildItem "$env:LOCALAPPDATA\OpenAI\Codex\bin\*\codex.exe" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName}
if(-not $taskCodex){throw 'codex not found on PATH or in the Codex app folder.'}
$taskOpenCode=(Get-Command opencode -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if(-not $taskOpenCode){$taskOpenCode=(Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\SST.opencode_*\opencode.exe" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName}
# Gemini CLI is an npm .cmd shim and the hub does not launch shims through a shell, so run its real entry point with node.
$taskGemini=Join-Path $env:APPDATA 'npm
ode_modules@googlegemini-cliundlegemini.js'
$taskGrok=(Get-Command grok -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
$taskLocal=Join-Path $taskHubRoot '.local'
New-Item -ItemType Directory -Path $taskLocal -Force | Out-Null
$taskConfig=Join-Path $taskLocal 'mcp.json'
$taskEnv=@{HUB_FIXTURE_ROOT=$taskFixture;HUB_CODEX_COMMAND=$taskCodex;HUB_CODEX_PREFIX_JSON='[]';HUB_DB_PATH=(Join-Path $taskLocal 'hub.sqlite')}
if($taskOpenCode){$taskEnv.HUB_OPENCODE_COMMAND=$taskOpenCode; $taskEnv.HUB_OPENCODE_PREFIX_JSON='[]'}
if(Test-Path -LiteralPath $taskGemini){$taskEnv.HUB_GEMINI_COMMAND=$taskNode; $taskEnv.HUB_GEMINI_PREFIX_JSON=(ConvertTo-Json -InputObject @($taskGemini) -Compress)}
if($taskGrok){$taskEnv.HUB_GROK_COMMAND=$taskGrok; $taskEnv.HUB_GROK_PREFIX_JSON='[]'}
# Repo mode: each worker gets its own worktree under .local\worktrees and a hub/* branch; the lead runs in the repo.
$taskWorkDir=$taskFixture
if($Repo){
 $taskWorkDir=(Resolve-Path -LiteralPath $Repo).Path
 $taskEnv.HUB_REPO_ROOT=$taskWorkDir; $taskEnv.HUB_WORKTREE_ROOT=(Join-Path $taskLocal 'worktrees'); $taskEnv.HUB_MAX_WORKERS=[string]$MaxWorkers
}
@{mcpServers=@{coding_hub=@{command=$taskNode;args=@($taskServer);env=$taskEnv}}} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $taskConfig -Encoding UTF8
Push-Location -LiteralPath $taskWorkDir
try{
 $taskClaudeArgs=@('--strict-mcp-config','--mcp-config',$taskConfig,'--setting-sources','project,local','--permission-mode','manual','--no-chrome')
 if(-not $NoRemote){$taskClaudeArgs+=@('--remote-control','Claude coding hub pilot')}
 Write-Host 'Starting the Claude lead. Review native trust and Remote Control prompts yourself.'
 & claude @taskClaudeArgs
 if($LASTEXITCODE -ne 0){throw 'Claude exited with an error.'}
}finally{Pop-Location}
