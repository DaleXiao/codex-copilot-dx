param([string]$Version, [switch]$Publish)
$ErrorActionPreference = 'Stop'

$feed = 'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/releases'
$release = Invoke-RestMethod -Uri $feed -TimeoutSec 20 -MaximumRedirection 0
$release = @($release | Where-Object { !$Version -or $_.version -eq $Version })[0]
if ($release.version -cnotmatch '^\d{1,4}\.\d{1,4}\.\d{1,4}$' -or $release.execution_id -cnotmatch '^\d{12,20}$') {
    throw 'The official Antigravity release index did not return a stable Windows build.'
}

$branch = 'antigravity-compat'
$manifestFile = 'windows-antigravity.json'
$releases = @()
$manifestSha = $null
if ($Publish) {
    if ($env:GITHUB_REF -ne 'refs/heads/main' -or $env:GITHUB_REPOSITORY -cne 'DaleXiao/codex-copilot-dx') {
        throw 'Publish compatibility metadata from the canonical main branch only.'
    }
    $api = "repos/$env:GITHUB_REPOSITORY"
    $reference = gh api "$api/git/ref/heads/$branch" --jq '.object.sha' 2>&1
    if ($LASTEXITCODE -ne 0) {
        if (($reference -join "`n") -notmatch 'HTTP 404') { throw 'Could not read the compatibility branch.' }
        gh api --method POST "$api/git/refs" -f "ref=refs/heads/$branch" -f "sha=$env:GITHUB_SHA" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the compatibility branch.' }
    }
    $content = gh api "$api/contents/$($manifestFile)?ref=$branch" 2>&1
    if ($LASTEXITCODE -eq 0) {
        $file = ($content -join "`n") | ConvertFrom-Json
        $manifestSha = $file.sha
        $manifest = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($file.content)) | ConvertFrom-Json
        if ($manifest.schema -ne 1 -or $manifest.releases.Count -gt 12) { throw 'Invalid existing compatibility metadata.' }
        $releases = @($manifest.releases)
    } elseif (($content -join "`n") -notmatch 'HTTP 404') { throw 'Could not read the compatibility manifest.' }
    if ($releases.version -contains $release.version) {
        Write-Output "Windows Antigravity $($release.version) is already verified."
        return
    }
}

$work = Join-Path ([IO.Path]::GetTempPath()) ('ccdx-agy-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($work) | Out-Null
try {
    $sevenZip = Join-Path $env:ProgramFiles '7-Zip/7z.exe'
    if (!(Test-Path -LiteralPath $sevenZip -PathType Leaf)) { throw 'The Windows verifier requires 7-Zip.' }
    $base = "https://storage.googleapis.com/antigravity-public/antigravity-hub/$($release.version)-$($release.execution_id)"
    $verified = @{ version = $release.version }
    foreach ($arch in @('x64', 'arm64')) {
        $platform = if ($arch -eq 'x64') { 'windows-x64' } else { 'windows-arm' }
        $folder = Join-Path $work $arch
        [IO.Directory]::CreateDirectory($folder) | Out-Null
        $installer = Join-Path $folder 'official.exe'
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$platform/Antigravity-$arch.exe" -TimeoutSec 180 -MaximumRedirection 0 -OutFile $installer
        $signature = Get-AuthenticodeSignature -LiteralPath $installer
        if ($signature.Status -ne 'Valid' -or !$signature.SignerCertificate -or
            $signature.SignerCertificate.GetNameInfo('SimpleName', $false) -cne 'Google LLC' -or
            $signature.SignerCertificate.Subject -cnotmatch '(?:^|,\s*)O=Google LLC(?:,|$)') {
            throw "The official $arch installer failed Google Authenticode verification."
        }
        $listing = & $sevenZip l -slt $installer
        if ($LASTEXITCODE -ne 0) { throw 'Could not list the signed installer payload.' }
        $archives = @($listing | ForEach-Object {
            if ($_ -cmatch '^Path = (\$PLUGINSDIR[\\/]app-(?:64|arm64)\.7z)$') { $Matches[1] }
        })
        if ($archives.Count -ne 1) { throw 'The signed installer has an unrecognized architecture payload.' }
        & $sevenZip x -y "-o$folder" $installer $archives[0] | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not extract the signed installer payload.' }
        $archive = Join-Path $folder $archives[0]
        $files = @('Antigravity.exe', 'resources/app.asar', 'resources/bin/language_server.exe')
        & $sevenZip x -y "-o$folder" $archive @files | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not extract the Antigravity App files.' }
        $versionInfo = (Get-Item -LiteralPath (Join-Path $folder $files[0])).VersionInfo
        if ($versionInfo.ProductName -ne 'Antigravity' -or $versionInfo.CompanyName -notin @('Google', 'Google LLC') -or
            $versionInfo.ProductVersion -notin @($release.version, "$($release.version).0")) {
            throw 'The signed installer payload does not match the advertised Antigravity App release.'
        }
        $verified[$arch] = @($files | ForEach-Object { (Get-FileHash -LiteralPath (Join-Path $folder $_) -Algorithm SHA256).Hash.ToLowerInvariant() })
    }
    $updated = [ordered]@{ schema = 1; releases = @(@($verified) + $releases | Select-Object -First 12) }
    $json = $updated | ConvertTo-Json -Depth 6
    if (!$Publish) { Write-Output $json; return }
    $body = @{ message = "Verify Windows Antigravity $($release.version)"; branch = $branch
        content = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$json`n")) }
    if ($manifestSha) { $body.sha = $manifestSha }
    $body | ConvertTo-Json -Compress | gh api --method PUT "$api/contents/$manifestFile" --input - --jq '.commit.sha'
    if ($LASTEXITCODE -ne 0) { throw 'Could not publish verified Antigravity compatibility metadata.' }
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force
}
