# Lists the Claude desktop app's Code sessions as JSON for the claude-sessions mod.
# Session files are large (~400 KB), so their few fields are cached by size and time.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.Web.Extensions
$ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$ser.MaxJsonLength = [int]::MaxValue

$roots = @(Get-ChildItem "$env:LOCALAPPDATA\Claude-Data\claude_*\claude-code-sessions" -Directory -ErrorAction SilentlyContinue | ForEach-Object FullName)
$cacheDir = Join-Path $env:LOCALAPPDATA 'herdr-claude-sessions'
$cacheFile = Join-Path $cacheDir 'cache.json'

$cache = @{}
if (Test-Path $cacheFile) {
  try {
    $old = $ser.DeserializeObject([IO.File]::ReadAllText($cacheFile))
    foreach ($k in $old.Keys) { $cache[$k] = $old[$k] }
  } catch {}
}

$fresh = @{}
$dirty = $false
foreach ($root in $roots) {
  foreach ($f in Get-ChildItem "$root\*\*\local_*.json" -File) {
    $stamp = '{0}-{1}' -f $f.LastWriteTimeUtc.Ticks, $f.Length
    $hit = $cache[$f.FullName]
    if ($hit -and $hit['stamp'] -eq $stamp) { $fresh[$f.FullName] = $hit; continue }
    try { $o = $ser.DeserializeObject([IO.File]::ReadAllText($f.FullName)) } catch { continue }
    $fresh[$f.FullName] = @{
      stamp    = $stamp
      id       = $o['sessionId']
      cli      = $o['cliSessionId']
      title    = $o['title']
      cwd      = $o['cwd']
      last     = $o['lastActivityAt']
      created  = $o['createdAt']
      archived = [bool]$o['isArchived']
      turns    = $o['completedTurns']
      model    = $o['model']
      effort   = $o['effort']
      perm     = $o['permissionMode']
    }
    $dirty = $true
  }
}
if ($dirty -or $fresh.Count -ne $cache.Count) {
  New-Item -ItemType Directory -Force $cacheDir | Out-Null
  [IO.File]::WriteAllText($cacheFile, $ser.Serialize($fresh))
}

# Transcripts the CLI can resume (another account resumes one by its path), and sessions the
# desktop app has a process for now.
$jsonl = New-Object 'System.Collections.Generic.Dictionary[string,string]'
foreach ($p in Get-ChildItem "$env:USERPROFILE\.claude\projects\*\*.jsonl" -File -ErrorAction SilentlyContinue) { $jsonl[$p.BaseName] = $p.FullName }
$desktop = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($p in Get-CimInstance Win32_Process -Filter "Name='claude.exe'") {
  $cmd = [string]$p.CommandLine
  if ($cmd -notlike '*Claude-Data*') { continue }
  if ($cmd -match '--resume[= ]"?([0-9a-fA-F-]{36})') { [void]$desktop.Add($Matches[1]) }
}

# Plain .NET collections only: the serializer can't follow PowerShell's wrapped objects.
$list = New-Object 'System.Collections.Generic.List[object]'
foreach ($s in $fresh.Values) {
  if (-not $s['cli']) { continue }
  $d = New-Object 'System.Collections.Generic.Dictionary[string,object]'
  foreach ($k in 'id', 'cli', 'title', 'cwd', 'last', 'created', 'archived', 'turns', 'model', 'effort', 'perm') { $d[$k] = $s[$k] }
  $d['path'] = $null
  if ($jsonl.ContainsKey([string]$s['cli'])) { $d['path'] = $jsonl[[string]$s['cli']] }
  $d['resumable'] = $null -ne $d['path']
  $d['folder'] = [bool]($s['cwd'] -and (Test-Path -LiteralPath $s['cwd']))
  $d['desktop'] = $desktop.Contains([string]$s['cli'])
  $d['origin'] = 'desktop'
  $list.Add($d)
}

# Pairs with Codex threads (session-menu\bridge.py). A Claude session a move from Codex made
# isn't the desktop app's, so it joins the list from here once its transcript exists.
$known = @{}
foreach ($d in $list) { $known[[string]$d['cli']] = $d }
$linksFile = Join-Path $env:LOCALAPPDATA 'herdr-sessions\links.json'
$links = @()
if (Test-Path $linksFile) { try { $links = @($ser.DeserializeObject([IO.File]::ReadAllText($linksFile))['links']) } catch {} }
foreach ($l in $links) {
  $c = $l['claude']
  if (-not $c -or -not $c['session']) { continue }
  $sid = [string]$c['session']
  $pair = New-Object 'System.Collections.Generic.Dictionary[string,object]'
  $pair['thread'] = [string]$l['codex']['thread']; $pair['title'] = [string]$l['title']
  if ($known.ContainsKey($sid)) { $known[$sid]['link'] = $pair; continue }
  $path = $null
  if ($c['path'] -and (Test-Path -LiteralPath ([string]$c['path']))) { $path = [string]$c['path'] }
  elseif ($jsonl.ContainsKey($sid)) { $path = $jsonl[$sid] }
  elseif ($c['config']) {
    $hit = Get-ChildItem "$([string]$c['config'])\projects\*\$sid.jsonl" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { $path = [string]$hit.FullName }
  }
  if (-not $path) { continue }
  $d = New-Object 'System.Collections.Generic.Dictionary[string,object]'
  $d['id'] = $null; $d['cli'] = $sid; $d['title'] = [string]$l['title']; $d['cwd'] = [string]$l['cwd']
  $d['last'] = [double]([DateTimeOffset](Get-Item -LiteralPath $path).LastWriteTimeUtc).ToUnixTimeMilliseconds()
  $d['created'] = $l['created']; $d['archived'] = $false; $d['turns'] = $null
  $d['model'] = $null; $d['effort'] = $null; $d['perm'] = $null
  $d['path'] = $path; $d['resumable'] = $true
  $d['folder'] = [bool]($d['cwd'] -and (Test-Path -LiteralPath $d['cwd']))
  $d['desktop'] = $false; $d['origin'] = 'herdr'; $d['link'] = $pair
  $list.Add($d)
}
$list.Sort([Comparison[object]] { param($a, $b) ([double]$b['last']).CompareTo([double]$a['last']) })

# Accounts: this one, and each ~/.local/bin/claudeN.cmd that points CLAUDE_CONFIG_DIR elsewhere.
function Email($file) {
  if (-not (Test-Path $file)) { return $null }
  $m = [regex]::Match([IO.File]::ReadAllText($file), '"emailAddress"\s*:\s*"([^"]+)"')
  if ($m.Success) { $m.Groups[1].Value } else { $null }
}
$accounts = New-Object 'System.Collections.Generic.List[object]'
$main = New-Object 'System.Collections.Generic.Dictionary[string,object]'
$main['name'] = 'claude'; $main['cmd'] = 'claude'; $main['main'] = $true; $main['email'] = [string](Email "$env:USERPROFILE\.claude.json")
$main['config'] = "$env:USERPROFILE\.claude"
# Each account's default model (settings.json), for the pane headers.
function Model($folder) {
  $file = Join-Path $folder 'settings.json'
  if (-not (Test-Path $file)) { return '' }
  try { [string]($ser.DeserializeObject([IO.File]::ReadAllText($file))['model']) } catch { '' }
}
$main['model'] = Model $main['config']
$accounts.Add($main)
foreach ($w in Get-ChildItem "$env:USERPROFILE\.local\bin\claude*.cmd" -ErrorAction SilentlyContinue | Sort-Object Name) {
  $m = [regex]::Match([IO.File]::ReadAllText($w.FullName), 'CLAUDE_CONFIG_DIR=([^"\r\n]+)')
  if (-not $m.Success) { continue }
  $a = New-Object 'System.Collections.Generic.Dictionary[string,object]'
  $a['name'] = [string]$w.BaseName; $a['cmd'] = [string]$w.BaseName; $a['main'] = $false
  $a['config'] = [string][Environment]::ExpandEnvironmentVariables($m.Groups[1].Value)
  $a['email'] = [string](Email (Join-Path $a['config'] '.claude.json'))
  $a['model'] = Model $a['config']
  $accounts.Add($a)
}

$out = New-Object 'System.Collections.Generic.Dictionary[string,object]'
$out['roots'] = [string[]]$roots
$out['accounts'] = $accounts.ToArray()
$out['sessions'] = $list.ToArray()
$json = $ser.Serialize($out)
# The session-search mod reads the last list from here.
$store = Join-Path $env:LOCALAPPDATA 'herdr-sessions'
New-Item -ItemType Directory -Force $store | Out-Null
[IO.File]::WriteAllText((Join-Path $store 'claude-list.json'), $json, (New-Object System.Text.UTF8Encoding $false))
[Console]::Out.Write($json)
