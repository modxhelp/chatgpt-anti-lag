[CmdletBinding()]
param(
    [string]$RepositoryUrl = 'https://github.com/modxhelp/chatgpt-anti-lag.git',
    [string]$RepositoryPath = (Join-Path $HOME 'Documents\GitHub\chatgpt-anti-lag'),
    [string]$ReleaseBranch = 'release/v3.0.0',
    [string]$GitUserName = '',
    [string]$GitUserEmail = '',
    [switch]$SkipDependencyInstall,
    [switch]$SkipBrowserInstall,
    [switch]$SkipRelease
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$MainBranch = 'main'
$Version = '3.0.0'
$RepositoryName = 'modxhelp/chatgpt-anti-lag'
$RawInstallUrl = 'https://raw.githubusercontent.com/modxhelp/chatgpt-anti-lag/main/chatgpt-anti-lag.user.js'
$CompareUrl = 'https://github.com/modxhelp/chatgpt-anti-lag/compare/main...release/v3.0.0?expand=1'

function Write-Step {
    param([Parameter(Mandatory)][string]$Message)
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Write-Ok {
    param([Parameter(Mandatory)][string]$Message)
    Write-Host "[OK] $Message" -ForegroundColor Green
}

function Invoke-Native {
    param(
        [Parameter(Mandatory, Position = 0)][string]$FilePath,
        [Parameter(Position = 1, ValueFromRemainingArguments = $true)][string[]]$Arguments
    )

    $exitCode = -1
    $previousErrorActionPreference = $ErrorActionPreference
    $nativePreference = Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue

    try {
        $ErrorActionPreference = 'Continue'
        if ($nativePreference) {
            Set-Variable -Name PSNativeCommandUseErrorActionPreference -Value $false -Scope Local
        }

        & $FilePath @Arguments
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        if ($nativePreference) {
            Set-Variable -Name PSNativeCommandUseErrorActionPreference -Value $nativePreference.Value -Scope Local
        }
    }

    if ($exitCode -ne 0) {
        $commandText = "$FilePath $($Arguments -join ' ')".Trim()
        throw "Command failed with exit code ${exitCode}: $commandText"
    }
}

function Invoke-NativeProbe {
    param(
        [Parameter(Mandatory, Position = 0)][string]$FilePath,
        [Parameter(Position = 1, ValueFromRemainingArguments = $true)][string[]]$Arguments
    )

    $exitCode = -1
    $output = @()
    $previousErrorActionPreference = $ErrorActionPreference
    $nativePreference = Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue

    try {
        $ErrorActionPreference = 'Continue'
        if ($nativePreference) {
            Set-Variable -Name PSNativeCommandUseErrorActionPreference -Value $false -Scope Local
        }

        $output = & $FilePath @Arguments 2>$null
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        if ($nativePreference) {
            Set-Variable -Name PSNativeCommandUseErrorActionPreference -Value $nativePreference.Value -Scope Local
        }
    }

    [pscustomobject]@{
        ExitCode = $exitCode
        Output = (($output | Out-String).Trim())
    }
}

function Refresh-ToolPath {
    $paths = @(
        "$env:ProgramFiles\Git\cmd",
        "$env:ProgramFiles\GitHub CLI",
        "$env:ProgramFiles\nodejs",
        "$env:LOCALAPPDATA\Programs\Git\cmd",
        "$env:LOCALAPPDATA\Programs\GitHub CLI",
        "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin"
    ) | Where-Object { $_ -and (Test-Path $_) }

    foreach ($path in $paths) {
        if (($env:Path -split ';') -notcontains $path) {
            $env:Path = "$path;$env:Path"
        }
    }
}

function Ensure-WingetPackage {
    param(
        [Parameter(Mandatory)][string]$Command,
        [Parameter(Mandatory)][string]$PackageId,
        [Parameter(Mandatory)][string]$Title
    )

    if (Get-Command $Command -ErrorAction SilentlyContinue) {
        Write-Ok "$Title is already installed."
        return
    }

    if ($SkipDependencyInstall) {
        throw "$Title was not found. Run without -SkipDependencyInstall or install package manually: $PackageId"
    }

    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw 'winget was not found. Install App Installer from Microsoft Store and run this script again.'
    }

    Write-Step "Installing $Title"
    Invoke-Native winget install --id $PackageId --exact --accept-package-agreements --accept-source-agreements --silent
    Refresh-ToolPath

    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        throw "$Title was installed, but command '$Command' is not available yet. Restart PowerShell and run this script again."
    }

    Write-Ok "$Title was installed."
}

function Copy-ProjectPayload {
    param([Parameter(Mandatory)][string]$Destination)

    $items = @(
        '.github',
        'scripts',
        'tools',
        '.editorconfig',
        '.gitattributes',
        '.gitignore',
        'chatgpt-anti-lag.user.js',
        'README.md',
        'CHANGELOG.md',
        'TEST-REPORT.md',
        'SECURITY.md',
        'LICENSE',
        'package.json'
    )

    foreach ($item in $items) {
        $source = Join-Path $ProjectRoot $item
        if (-not (Test-Path $source)) {
            throw "Required package item is missing: $source"
        }

        $target = Join-Path $Destination $item
        if (Test-Path $target) {
            Remove-Item -Path $target -Recurse -Force
        }
        Copy-Item -Path $source -Destination $target -Recurse -Force
    }
}

function Get-GitHubUserValue {
    param([Parameter(Mandatory)][string]$JqExpression)

    $result = Invoke-NativeProbe gh api user --jq $JqExpression
    if ($result.ExitCode -ne 0) {
        return ''
    }
    return $result.Output
}

function Ensure-GitIdentity {
    $name = $GitUserName
    if (-not $name) {
        $nameResult = Invoke-NativeProbe git config --global --get user.name
        $name = $nameResult.Output
    }

    $login = Get-GitHubUserValue -JqExpression '.login // empty'
    if (-not $name) {
        $name = Get-GitHubUserValue -JqExpression '.name // empty'
    }
    if (-not $name) {
        $name = $login
    }
    if (-not $name) {
        throw 'Unable to determine the Git commit author name. Pass -GitUserName explicitly.'
    }

    $email = $GitUserEmail
    if (-not $email) {
        $emailResult = Invoke-NativeProbe git config --global --get user.email
        $email = $emailResult.Output
    }
    if (-not $email) {
        $email = Get-GitHubUserValue -JqExpression '.email // empty'
    }
    if (-not $email) {
        $userId = Get-GitHubUserValue -JqExpression '.id // empty'
        if ($userId -and $login) {
            $email = "${userId}+${login}@users.noreply.github.com"
        }
        elseif ($login) {
            $email = "${login}@users.noreply.github.com"
        }
    }
    if (-not $email -or $email -notmatch '@') {
        throw 'Unable to determine a valid Git commit email. Pass -GitUserEmail explicitly.'
    }

    Invoke-Native git config --global user.name $name
    Invoke-Native git config --global user.email $email
    Write-Ok ('Git identity: {0} <{1}>' -f $name, $email)
}

function Ensure-GitHubLogin {
    Write-Step 'Checking GitHub CLI authentication'
    $authStatus = Invoke-NativeProbe gh auth status --hostname github.com
    if ($authStatus.ExitCode -ne 0) {
        Write-Host 'GitHub will open a secure browser login. Do not paste a token into this script.' -ForegroundColor Yellow
        Invoke-Native gh auth login --hostname github.com --web --git-protocol https
    }

    $authStatus = Invoke-NativeProbe gh auth status --hostname github.com
    if ($authStatus.ExitCode -ne 0) {
        throw 'GitHub authentication was not completed. Run gh auth login --hostname github.com --web --git-protocol https and try again.'
    }

    Invoke-Native gh auth setup-git
    Write-Ok 'GitHub CLI is authenticated and connected to Git.'
}

function Save-LocalChangesIfNeeded {
    $status = (& git status --porcelain)
    if ($status) {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $stashName = "pre-v3-$stamp"
        Write-Host "Local changes detected. Saving them to Git stash '$stashName'." -ForegroundColor Yellow
        Invoke-Native git stash push --include-untracked --message $stashName
    }
}

function Invoke-Validation {
    Write-Step 'Validating the userscript and repository package'
    Invoke-Native node --check chatgpt-anti-lag.user.js
    Invoke-Native node scripts/validate-userscript.mjs
    Invoke-Native git diff --check
    Write-Ok 'All local checks passed.'
}

function Publish-GitHubRelease {
    if ($SkipRelease) {
        return
    }

    $releaseStatus = Invoke-NativeProbe gh release view "v$Version" --repo $RepositoryName
    if ($releaseStatus.ExitCode -eq 0) {
        Write-Host "GitHub Release v$Version already exists. Release creation was skipped." -ForegroundColor Yellow
        return
    }

    $notesPath = Join-Path $env:TEMP "chatgpt-anti-lag-v$Version-notes.md"
    @'
# ChatGPT Anti-Lag Archive 3.0.0

A major rewrite of the local archive for long ChatGPT conversations:

- one IndexedDB record per archived message;
- archive restoration after page reload without duplicates;
- batched archiving and restoration;
- no DOM removal when a database write fails;
- scroll position preservation;
- storage limits and old archive cleanup;
- synchronization between browser tabs;
- automatic userscript updates through the GitHub raw file.

See CHANGELOG.md and TEST-REPORT.md for details.
'@ | Set-Content -Path $notesPath -Encoding UTF8

    Invoke-Native gh release create "v$Version" chatgpt-anti-lag.user.js --repo $RepositoryName --title "ChatGPT Anti-Lag Archive $Version" --notes-file $notesPath
    Write-Ok "GitHub Release v$Version was created."
}

try {
    Write-Step 'Checking required applications'
    Refresh-ToolPath
    Ensure-WingetPackage -Command git -PackageId Git.Git -Title 'Git for Windows'
    Ensure-WingetPackage -Command gh -PackageId GitHub.cli -Title 'GitHub CLI'
    Ensure-WingetPackage -Command node -PackageId OpenJS.NodeJS.LTS -Title 'Node.js LTS'
    Ensure-GitHubLogin
    Ensure-GitIdentity

    Write-Step 'Preparing the local repository'
    $parent = Split-Path -Parent $RepositoryPath
    New-Item -ItemType Directory -Path $parent -Force | Out-Null

    if (Test-Path (Join-Path $RepositoryPath '.git')) {
        Set-Location $RepositoryPath
        $origin = (& git remote get-url origin).Trim()
        if ($origin -ne $RepositoryUrl -and $origin -ne 'git@github.com:modxhelp/chatgpt-anti-lag.git') {
            throw "A different Git origin is configured in '$RepositoryPath': $origin"
        }

        Save-LocalChangesIfNeeded
        Invoke-Native git fetch origin --prune
        Invoke-Native git checkout $MainBranch
        Invoke-Native git pull --ff-only origin $MainBranch
    }
    elseif (Test-Path $RepositoryPath) {
        if ((Get-ChildItem -Force $RepositoryPath | Measure-Object).Count -gt 0) {
            throw "The directory '$RepositoryPath' exists and is not a Git repository. Use a different -RepositoryPath value."
        }

        Invoke-Native git clone $RepositoryUrl $RepositoryPath
        Set-Location $RepositoryPath
    }
    else {
        Invoke-Native git clone $RepositoryUrl $RepositoryPath
        Set-Location $RepositoryPath
    }

    $backupBranch = "backup/pre-v$Version-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Invoke-Native git branch $backupBranch
    Write-Ok "Created local backup branch: $backupBranch"

    $releaseBranchStatus = Invoke-NativeProbe git show-ref --verify --quiet "refs/heads/$ReleaseBranch"
    if ($releaseBranchStatus.ExitCode -eq 0) {
        Invoke-Native git branch -D $ReleaseBranch
    }
    Invoke-Native git checkout -b $ReleaseBranch

    Write-Step 'Copying version 3.0.0 files'
    Copy-ProjectPayload -Destination $RepositoryPath
    Invoke-Validation

    Invoke-Native git add --all
    $cachedDiffStatus = Invoke-NativeProbe git diff --cached --quiet
    if ($cachedDiffStatus.ExitCode -eq 0) {
        Write-Host 'There are no changes to commit. The repository already contains this package.' -ForegroundColor Yellow
    }
    else {
        Invoke-Native git commit -m 'feat: release ChatGPT Anti-Lag Archive 3.0.0'
    }

    Write-Step 'Publishing the release branch'
    Invoke-Native git push --force-with-lease --set-upstream origin $ReleaseBranch

    Write-Step 'Updating main'
    Invoke-Native git checkout $MainBranch
    Invoke-Native git merge --ff-only $ReleaseBranch

    $mainPublished = $true
    try {
        Invoke-Native git push origin $MainBranch
    }
    catch {
        $mainPublished = $false
        Write-Host 'Direct push to main was rejected. The release branch is published; creating a pull request.' -ForegroundColor Yellow
        Invoke-Native git reset --hard "origin/$MainBranch"

        $pullRequestStatus = Invoke-NativeProbe gh pr view $ReleaseBranch --repo $RepositoryName
        if ($pullRequestStatus.ExitCode -ne 0) {
            Invoke-Native gh pr create --repo $RepositoryName --base $MainBranch --head $ReleaseBranch --title 'Release ChatGPT Anti-Lag Archive 3.0.0' --body 'Major IndexedDB archive rewrite with batched restoration, storage controls, safe disable behavior, documentation, and CI.'
        }
        Start-Process $CompareUrl
    }

    if ($mainPublished) {
        Write-Ok 'The main branch was updated.'

        $localTagStatus = Invoke-NativeProbe git show-ref --verify --quiet "refs/tags/v$Version"
        if ($localTagStatus.ExitCode -ne 0) {
            Invoke-Native git tag -a "v$Version" -m "ChatGPT Anti-Lag Archive $Version"
        }

        $remoteTagStatus = Invoke-NativeProbe git ls-remote --exit-code --tags origin "refs/tags/v$Version"
        if ($remoteTagStatus.ExitCode -ne 0) {
            Invoke-Native git push origin "v$Version"
        }
        else {
            Write-Host "Remote tag v$Version already exists. Tag push was skipped." -ForegroundColor Yellow
        }

        Publish-GitHubRelease
    }

    Write-Step 'Final status'
    Invoke-Native git status --short --branch

    if (-not $SkipBrowserInstall -and $mainPublished) {
        Write-Host 'Opening the raw userscript. Tampermonkey or Violentmonkey should display an install/update prompt.' -ForegroundColor Yellow
        Start-Process $RawInstallUrl
        Start-Process "https://github.com/$RepositoryName/actions"
    }

    Write-Ok 'Repository preparation, commit, and publication completed.'
    Write-Host "Local repository: $RepositoryPath"
    if (-not $mainPublished) {
        Write-Host "Complete the pull request merge here: $CompareUrl" -ForegroundColor Yellow
    }
}
catch {
    Write-Host ''
    Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host ('Location: ' + $_.InvocationInfo.PositionMessage) -ForegroundColor DarkGray
    exit 1
}
