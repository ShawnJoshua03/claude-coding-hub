# One-time login for the Grok worker. Grok runs in a hub-owned home (.local\grok-home), not your real one,
# so it does not inherit your Claude Code permission rules, skills, hooks or plugins. Your real Grok
# login is NOT copied; you sign in here, in the browser, as a separate session.
$ErrorActionPreference='Stop'
$hubRoot=Split-Path -Parent $PSScriptRoot
$home2=if($env:HUB_GROK_HOME){$env:HUB_GROK_HOME}else{Join-Path $hubRoot '.local\grok-home'}
New-Item -ItemType Directory -Path $home2 -Force | Out-Null
$grok=(Get-Command grok -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$env:HOME=$home2; $env:USERPROFILE=$home2; $env:APPDATA=Join-Path $home2 'Roaming'; $env:LOCALAPPDATA=Join-Path $home2 'Local'
Write-Host "Signing in to Grok inside $home2"
& $grok login
if($LASTEXITCODE -ne 0){throw 'grok login failed.'}
Write-Host 'Done. Do not install plugins, hooks or skills into this home: the hub refuses to start Grok if it finds them.'
