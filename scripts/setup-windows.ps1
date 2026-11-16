# One-time setup for the BimClub web server and local Engi voice on Windows x64.
[CmdletBinding()]
param([switch]$SetupOnly)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Invoke-RequiredCommand($Program, [string[]]$Arguments, $Description) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Description failed (exit code $LASTEXITCODE)." }
}

function Test-CommandExit($Program, [string[]]$Arguments) {
    try {
        & $Program @Arguments *> $null
        return ($LASTEXITCODE -eq 0)
    } catch { return $false }
}

function Receive-Installer($Url, $Name, $Sha256) {
    $file = Join-Path $downloadDirectory $Name
    Invoke-WebRequest -Uri $Url -UseBasicParsing -OutFile $file
    if ($Sha256 -and (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $Sha256) {
        throw "Download checksum does not match for $Name."
    }
    return $file
}

function Invoke-Installer($Program, [string[]]$Arguments, $Description, [switch]$Elevated) {
    $options = @{ FilePath = $Program; ArgumentList = $Arguments; Wait = $true; PassThru = $true }
    if ($Elevated) { $options.Verb = 'RunAs' }
    $process = Start-Process @options
    if ($process.ExitCode -in 1641, 3010) { throw "$Description needs a Windows restart. Restart Windows and run this script again." }
    if ($process.ExitCode -ne 0) { throw "$Description failed (exit code $($process.ExitCode))." }
}

function Find-Node {
    $candidates = @((Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue).Source)
    $candidates += Join-Path $env:ProgramFiles 'nodejs\node.exe'
    foreach ($candidate in $candidates) {
        if (!$candidate -or !(Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $npmPath = Join-Path (Split-Path -Parent $candidate) 'npm.cmd'
        if ((Test-Path -LiteralPath $npmPath -PathType Leaf) -and
            (Test-CommandExit $candidate @('-e', 'process.exit(typeof AbortSignal.any === ''function'' ? 0 : 1)'))) {
            return $candidate
        }
    }
}

function Test-Python312($Program) {
    return ($Program -and (Test-Path -LiteralPath $Program -PathType Leaf) -and
        (Test-CommandExit $Program @('-c', 'import sys, sysconfig; sys.exit(sys.version_info[:2] != (3, 12) or sysconfig.get_platform() != ''win-amd64'')')))
}

function Find-Python312 {
    $candidates = @()
    foreach ($key in @('HKCU:\Software\Python\PythonCore\3.12\InstallPath', 'HKLM:\Software\Python\PythonCore\3.12\InstallPath')) {
        $candidates += (Get-ItemProperty -LiteralPath $key -Name ExecutablePath -ErrorAction SilentlyContinue).ExecutablePath
    }
    $candidates += Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'
    $candidates += Join-Path $env:ProgramFiles 'Python312\python.exe'
    $candidates += (Get-Command python.exe -CommandType Application -ErrorAction SilentlyContinue).Source
    foreach ($candidate in $candidates) {
        # Avoid the Microsoft Store python.exe alias while probing installed runtimes.
        if ($candidate -like '*\WindowsApps\python.exe') { continue }
        if (Test-Python312 $candidate) { return $candidate }
    }
}

if ($env:OS -ne 'Windows_NT' -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
    throw 'Run this script using 64-bit PowerShell on Windows x64.'
}

$project = Split-Path -Parent $PSScriptRoot
$downloadDirectory = Join-Path ([IO.Path]::GetTempPath()) ('bimclub-setup-' + [Guid]::NewGuid())
$step = 'Check project files'
Push-Location -LiteralPath $project
try {
    foreach ($path in @('package.json', 'package-lock.json', 'server.js', 'offline-voice\asr_worker.py', 'scripts\download-local-asr.py', 'scripts\setup-login.js')) {
        if (!(Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing $path. Copy or extract the complete BimClub project first." }
    }
    [void](New-Item -Path $downloadDirectory -ItemType Directory)
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $step = 'Node.js and npm'
    $node = Find-Node
    if ($node) { Write-Host '[skip] Node.js and npm are available.' }
    else {
        Write-Host '[install] Node.js LTS x64 from nodejs.org'
        $releases = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
        $release = $releases | Where-Object { $_.lts -and $_.files -contains 'win-x64-msi' } | Select-Object -First 1
        if (!$release -or $release.version -notmatch '^v\d+\.\d+\.\d+$') { throw 'No Windows x64 LTS installer was found.' }
        $baseUrl = "https://nodejs.org/dist/$($release.version)"
        $name = "node-$($release.version)-x64.msi"
        $checksums = (Invoke-WebRequest -Uri "$baseUrl/SHASUMS256.txt" -UseBasicParsing).Content
        $checksumLine = $checksums -split '\r?\n' | Where-Object { $_ -match "^[a-fA-F0-9]{64}\s+$([regex]::Escape($name))$" } | Select-Object -First 1
        if (!$checksumLine) { throw 'The official Node.js installer checksum was not found.' }
        $installer = Receive-Installer "$baseUrl/$name" $name ($checksumLine -split '\s+')[0]
        Invoke-Installer (Join-Path $env:SystemRoot 'System32\msiexec.exe') @('/i', ('"' + $installer + '"'), '/qn', '/norestart') 'Node.js installer' -Elevated
        $node = Find-Node
        if (!$node) { throw 'Node.js installed but node.exe and npm.cmd were not found. Open a new PowerShell and run the script again.' }
    }
    $nodeDirectory = Split-Path -Parent $node
    $env:Path = "$nodeDirectory;$env:Path"
    $npm = Join-Path $nodeDirectory 'npm.cmd'

    $step = 'Microsoft Visual C++ Redistributable x64'
    $vc = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64' -ErrorAction SilentlyContinue
    if ($vc.Installed -eq 1) { Write-Host '[skip] Visual C++ x64 runtime is installed.' }
    else {
        Write-Host '[install] Microsoft Visual C++ x64 runtime'
        $installer = Receive-Installer 'https://aka.ms/vc14/vc_redist.x64.exe' 'vc_redist.x64.exe'
        $signature = Get-AuthenticodeSignature -FilePath $installer
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '\bMicrosoft Corporation\b') {
            throw 'The Visual C++ installer signature could not be verified.'
        }
        Invoke-Installer $installer @('/install', '/quiet', '/norestart') 'Visual C++ installer' -Elevated
    }

    $step = 'Python 3.12 x64 environment'
    $venv = Join-Path $project '.venv-voice'
    $python = Join-Path $venv 'Scripts\python.exe'
    if (Test-Python312 $python) { Write-Host '[skip] The project Python 3.12 x64 environment is ready.' }
    else {
        $basePython = Find-Python312
        if (!$basePython) {
            Write-Host '[install] Python 3.12.10 x64 from python.org'
            $installer = Receive-Installer 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe' 'python-3.12.10-amd64.exe' '67B5635E80EA51072B87941312D00EC8927C4DB9BA18938F7AD2D27B328B95FB'
            Invoke-Installer $installer @('/quiet', 'InstallAllUsers=0', 'Include_launcher=0', 'PrependPath=0') 'Python installer'
            $basePython = Find-Python312
            if (!$basePython) { throw 'Python 3.12 x64 was not found after installation.' }
        }
        if (Test-Path -LiteralPath $venv) {
            $backups = Join-Path $project '.venv-voice-backups'
            [void](New-Item -Path $backups -ItemType Directory -Force)
            $backup = Join-Path $backups ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
            Move-Item -LiteralPath $venv -Destination $backup
            Write-Host "[backup] Previous Python environment moved to $backup"
        }
        Write-Host '[install] Project Python environment'
        Invoke-RequiredCommand $basePython @('-m', 'venv', $venv) 'Create Python environment'
        if (!(Test-Python312 $python)) { throw 'The new environment could not start Python 3.12 x64.' }
    }
    $env:VOICE_PYTHON = $python

    $step = 'Project npm packages and web assets'
    $npmCheck = @'
const fs = require('node:fs');
const locked = require('./package-lock.json').packages;
const packages = require('./package.json').dependencies;
const matching = Object.keys(packages).every(name =>
    require('./node_modules/' + name + '/package.json').version === locked['node_modules/' + name].version);
const assets = [
    'mqtt/dist/mqtt.min.js',
    '@ricky0123/vad-web/dist/bundle.min.js',
    '@ricky0123/vad-web/dist/vad.worklet.bundle.min.js',
    '@ricky0123/vad-web/dist/silero_vad.onnx',
    'onnxruntime-web/dist/ort.wasm.min.js',
    'onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
    'onnxruntime-web/dist/ort-wasm-simd-threaded.wasm'
];
process.exit(matching && assets.every(name => fs.statSync('node_modules/' + name).size > 0) ? 0 : 1);
'@
    if ((Test-CommandExit $node @('-e', $npmCheck)) -and (Test-CommandExit $npm @('ls', '--all', '--omit=dev', '--silent'))) {
        Write-Host '[skip] npm packages, MQTT.js and voice browser assets are present.'
    } else {
        Write-Host '[install] Project npm packages from package-lock.json'
        Invoke-RequiredCommand $npm @('ci') 'Install npm packages'
        Invoke-RequiredCommand $node @('-e', $npmCheck) 'Verify npm packages and browser assets'
    }

    $step = 'faster-whisper and its Python libraries'
    $pythonCheck = 'from importlib.metadata import version; import faster_whisper, ctranslate2; assert version(''faster-whisper'') == ''1.2.1'''
    if (Test-CommandExit $python @('-c', $pythonCheck)) { Write-Host '[skip] faster-whisper 1.2.1 imports successfully.' }
    else {
        Write-Host '[install] faster-whisper 1.2.1 in the project environment'
        Invoke-RequiredCommand $python @('-m', 'pip', 'install', 'faster-whisper==1.2.1') 'Install faster-whisper'
        Invoke-RequiredCommand $python @('-c', $pythonCheck) 'Import faster-whisper and CTranslate2'
    }

    $step = 'Local Engi model'
    $modelDir = Join-Path $project 'models\whisper-th-small'
    $missingModelFiles = @('model.bin', 'config.json', 'tokenizer.json' | Where-Object {
        $file = Get-Item -LiteralPath (Join-Path $modelDir $_) -ErrorAction SilentlyContinue
        !$file -or $file.PSIsContainer -or $file.Length -eq 0
    })
    $weights = Get-Item -LiteralPath (Join-Path $modelDir 'model.bin') -ErrorAction SilentlyContinue
    $hasVocabulary = (Test-Path -LiteralPath (Join-Path $modelDir 'vocabulary.json') -PathType Leaf) -or
        (Test-Path -LiteralPath (Join-Path $modelDir 'vocabulary.txt') -PathType Leaf)
    if ($missingModelFiles.Count -or $weights.Length -lt 1MB -or !$hasVocabulary) {
        Write-Host '[download] Thai Whisper model (about 0.5 GB)'
        Invoke-RequiredCommand $python @('.\scripts\download-local-asr.py') 'Download the local Whisper model'
    } else { Write-Host '[skip] Local model files are present.' }
    Write-Host '[check] Loading the local Whisper model on CPU'
    $modelCheck = 'import sys; sys.path.insert(0, ''offline-voice''); from asr_worker import Recognizer; Recognizer(); print(''Engi model ready'')'
    Invoke-RequiredCommand $python @('-c', $modelCheck) 'Load Whisper model (check the Python error above if this fails)'

    $step = 'BimClub login'
    # Keep Thai characters in Windows paths intact across the PowerShell 5.1 console code page.
    $configCode = 'require(''dotenv'').config({quiet:true}); const config = { account: require(''node:path'').resolve(process.env.BIMCLUB_LOGIN_ACCOUNT_FILE || ''data/login-account.json''), port:process.env.PORT || ''3000'' }; process.stdout.write(Buffer.from(JSON.stringify(config)).toString(''base64''))'
    $configText = & $node -e $configCode
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the server settings.' }
    $config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($configText)) | ConvertFrom-Json
    if (Test-Path -LiteralPath $config.account -PathType Leaf) { Write-Host '[skip] A BimClub login already exists.' }
    else {
        Write-Host '[setup] Create the first BimClub login. The password is typed in the terminal.'
        $env:BIMCLUB_LOGIN_ACCOUNT_FILE = $config.account
        Invoke-RequiredCommand $npm @('run', 'auth:setup') 'Create BimClub login'
    }

    if (!$SetupOnly) {
        $step = 'Start BimClub'
        $listeners = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
        if ($listeners.Port -contains ([int]$config.port)) { throw "Port $($config.port) is already in use. Stop the earlier server and run this script again, or use -SetupOnly." }
        $env:VOICE_DEBUG = '1'
        Write-Host "[start] Open http://127.0.0.1:$($config.port)/ after the server starts. Ctrl+C stops it."
        Invoke-RequiredCommand $npm @('start') 'Start BimClub'
    } else { Write-Host '[done] BimClub dependencies, Engi and login are ready.' }
} catch {
    throw "$step -- $($_.Exception.Message)"
} finally {
    if (Test-Path -LiteralPath $downloadDirectory) { Remove-Item -LiteralPath $downloadDirectory -Recurse -Force -ErrorAction SilentlyContinue }
    Pop-Location
}
