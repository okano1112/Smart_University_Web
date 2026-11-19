param(
    [string]$ImportFrom,
    [switch]$SkipLoad
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot

function Invoke-Docker {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$DockerArguments)
    & docker @DockerArguments
    if ($LASTEXITCODE -ne 0) { throw "Docker failed. Check the message above." }
}

try {
    if (!(Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'Install Docker Desktop for Windows, enable WSL 2 and start Linux containers first.'
    }
    $engine = & docker version --format '{{.Server.Os}}'
    if ($LASTEXITCODE -ne 0 -or $engine -ne 'linux') {
        throw 'Start Docker Desktop with the Linux container engine, then run this file again.'
    }
    Invoke-Docker @('compose', 'version')
    foreach ($directory in @('seed\web', 'seed\node-red')) {
        New-Item -ItemType Directory -Force -Path $directory | Out-Null
    }

    if ($ImportFrom) {
        $previous = (Resolve-Path -LiteralPath $ImportFrom).Path
        $files = @{
            'data\login-account.json' = 'seed\web\login-account.json'
            'data\ac-schedules.json' = 'seed\web\ac-schedules.json'
            'node-red\runtime\flows.json' = 'seed\node-red\flows.json'
            'node-red\runtime\flows_cred.json' = 'seed\node-red\flows_cred.json'
            'node-red\runtime\.config.runtime.json' = 'seed\node-red\.config.runtime.json'
        }
        foreach ($relative in $files.Keys) {
            $source = Join-Path $previous $relative
            if (Test-Path -LiteralPath $source -PathType Leaf) {
                $destination = $files[$relative]
                if (!(Test-Path -LiteralPath $destination)) { Copy-Item -LiteralPath $source -Destination $destination }
            }
        }
    }

    $archives = @(Get-ChildItem -Path '.\images\*.tar' -File -ErrorAction SilentlyContinue)
    if ($archives.Count) {
        if (!$SkipLoad) {
            $manifestFile = Join-Path $PSScriptRoot 'checksums.json'
            $manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
            foreach ($archive in $archives) {
                $relative = 'images/' + $archive.Name
                $expected = $manifest.PSObject.Properties[$relative].Value
                $actual = (Get-FileHash -LiteralPath $archive.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
                if ($actual -ne $expected) { throw "Checksum mismatch for $relative. Extract the original ZIP again." }
                Invoke-Docker @('image', 'load', '--input', $archive.FullName)
            }
        }
    } else {
        Write-Host 'Building BimClub images and preparing the speech models...'
        Invoke-Docker @('compose', 'build')
    }

    # Recreate both network-sharing containers together. Named volumes persist.
    Invoke-Docker @('compose', 'down', '--remove-orphans')
    Invoke-Docker @('compose', 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '180')

    & docker compose exec -T web node scripts/check-login.js
    $accountStatus = $LASTEXITCODE
    if ($accountStatus -ne 0) {
        throw 'The BimClub login is not ready. Check the web container logs and LOGIN.md, then run again.'
    }
    Invoke-Docker @('compose', 'ps')
    Write-Host 'BimClub is ready at http://127.0.0.1:3000/'
    Write-Host 'Node-RED is ready at http://127.0.0.1:1880/'
    Write-Host 'The existing Cloudflare service can continue using 127.0.0.1:3000.'
} finally {
    Pop-Location
}
