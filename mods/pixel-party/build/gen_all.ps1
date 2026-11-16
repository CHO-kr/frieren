# -GenImage: a script that takes -Prompt <text> -Out <png> -Shape <square|landscape|portrait> [-Ref <reference png>],
# saves one generated image and prints "OK ... (<n>s)" (the original sheets were made with OpenAI image generation
# through Codex).
param([string]$Dir, [int]$Parallel = 4, [string[]]$Only = @(), [string]$GenImage = $env:GEN_IMAGE)
if (-not $GenImage) { throw "Pass -GenImage <script> (or set GEN_IMAGE)" }
$g = $GenImage
$H = "$env:USERPROFILE\.config\herdr-app\mods"
$log = Join-Path $Dir "gen.log"
$roster = @(
 @('frieren','Frieren','an elf great mage','her mage staff','casting an attack spell with the staff thrust forward'),
 @('fern','Fern','a young mage','her long mage staff','casting an attack spell with the staff thrust forward'),
 @('stark','Stark','a young warrior','his big battle axe','swinging the axe forward in a strong attack'),
 @('himmel','Himmel','the hero','his sword','slashing forward with the sword'),
 @('heiter','Heiter','a priest','a priest holy book','casting holy magic with one hand thrust forward, book in the other'),
 @('eisen','Eisen','a dwarf warrior','his big battle axe','swinging the axe forward in a strong attack'),
 @('sein','Sein','a priest','a priest holy book','casting holy magic with one hand thrust forward'),
 @('ubel','Ubel','a first-class mage','nothing (bare hands)','casting cutting magic with one hand thrust forward'),
 @('land','Land','a first-class mage','his mage staff','casting a spell with the staff thrust forward'),
 @('denken','Denken','an old first-class mage','his mage staff','casting a spell with the staff thrust forward'),
 @('methode','Methode','a first-class mage','her mage staff','casting a spell with the staff thrust forward'),
 @('flamme','Flamme','a legendary great mage','her mage staff','casting a spell with the staff thrust forward'),
 @('serie','Serie','an ancient elf great mage','her mage staff','casting a spell with one hand thrust forward'),
 @('kanne','Kanne','a young mage','her mage staff','casting water magic with the staff thrust forward'),
 @('lawine','Lawine','a young mage','her mage staff','casting ice magic with the staff thrust forward'),
 @('wirbel','Wirbel','a first-class mage','his mage staff','casting a spell with the staff thrust forward'))
$places = @(
 @('capital','a grand royal capital city: white stone castle with blue roofs and banners, city walls, under a twilight sky'),
 @('ruins','old overgrown stone ruins: tall broken columns and arches covered in moss and vines, soft light'),
 @('meadow','a gentle hill covered in blooming flowers (blue and white), a single path, open sky with clouds'),
 @('camp','a small forest campsite at night: a crackling campfire, a canvas tent, tall dark pine trees'),
 @('tower','a stone rampart watchtower on a fortress wall with a flag, cliffs below, dusk sky'),
 @('street','a cozy medieval town street at evening: timber houses, warm glowing windows, cobblestones, a hanging shop sign'),
 @('tree','a huge ancient tree alone on a hill under a starry night sky, fireflies'),
 @('moon','a ruined castle silhouette under a huge full moon, deep blue night'))
$tasks = @()
foreach ($r in $roster) {
  $p = "A pixel art sprite sheet of ONE cute chibi character: $($r[1]), $($r[2]), the character in the reference image. Keep their exact look from the reference: hair color and hairstyle, eye color, face, outfit colors. Signature item: $($r[3]). 16-bit SNES-era JRPG battle sprite style, cute chibi proportions about 2.5 heads tall, big head, small body. Eight poses of the SAME character at the SAME size, arranged in a neat grid of 4 columns by 2 rows with generous empty space between poses, every pose facing RIGHT (side or three-quarter view), feet on the same baseline within each row. Top row, left to right: 1 standing idle; 2 walking mid-step; 3 $($r[4]); 4 reading an open book held in both hands. Bottom row, left to right: 5 writing on a small scroll with a feather quill; 6 sitting on the ground asleep with eyes closed and head drooping; 7 cheering in victory with both arms raised; 8 startled, one hand raised, alert. TRUE pixel art: each sprite about 32 art-pixels tall, chunky equal square pixels on a strict grid, clean 1-pixel dark outline, flat colors with 2-3 tone cel shading, no anti-aliasing, no blur, no gradients. Plain solid flat pure magenta background (#ff00ff) everywhere, no ground shadows, no magic effects, no speech bubbles, no text, no letters, no numbers, no labels, no UI, no border."
  $tasks += ,@("sheet_$($r[0])", $p, 'landscape', "$H\journey-party\cards\$($r[0]).png")
}
foreach ($q in $places) {
  $p = "A tiny 16-bit SNES-era pixel art scene tile, designed to be read at 32x32 art-pixels: $($q[1]). Few large clear shapes, strong silhouette, limited palette of about 16 flat colors (deep navy, indigo, teal, warm gold highlights), chunky square pixels on a strict grid of about 32x32 art-pixels across the whole image, every art pixel an equal crisp square block, no anti-aliasing, no blur, no gradients. The scene fills the whole square frame edge to edge. No text, no border, no characters, no UI. The reference image shows the place to depict; follow its subject, not its painting style."
  $tasks += ,@("place_$($q[0])", $p, 'square', "$H\journey-spaces\art\$($q[0]).jpg")
}
if ($Only.Count) { $tasks = @($tasks | Where-Object { $Only -contains $_[0] }) }
"start $($tasks.Count) images, $Parallel at a time  $(Get-Date -f HH:mm:ss)" | Out-File -Append -Encoding utf8 $log
$running = @(); $i = 0; $sw = [Diagnostics.Stopwatch]::StartNew()
while ($i -lt $tasks.Count -or $running.Count) {
  while ($i -lt $tasks.Count -and $running.Count -lt $Parallel) {
    $t = $tasks[$i]; $i++
    "  go $($t[0])" | Out-File -Append -Encoding utf8 $log
    $running += Start-Job -Name $t[0] { param($g,$p,$o,$sh,$r) & $g -Prompt $p -Out $o -Shape $sh -Ref $r } -ArgumentList $g, $t[1], (Join-Path $Dir "$($t[0]).png"), $t[2], $t[3]
  }
  Start-Sleep -Milliseconds 1500
  foreach ($j in @($running | Where-Object { $_.State -ne 'Running' })) {
    $out = (Receive-Job $j 2>&1 | Out-String).Trim()
    $line = if ($out -match '^OK') { "ok $($j.Name).png  " + ($out -replace '(?s).*\((\d+s)\).*', '$1') } else { "FAIL $($j.Name): $out" }
    $line | Out-File -Append -Encoding utf8 $log
    Remove-Job $j; $running = @($running | Where-Object { $_.Id -ne $j.Id })
  }
}
"finished: $([math]::Round($sw.Elapsed.TotalSeconds))s  $(Get-Date -f HH:mm:ss)" | Out-File -Append -Encoding utf8 $log
