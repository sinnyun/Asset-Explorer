param(
    [Parameter(Mandatory = $true)][string]$Destination,
    [ValidateRange(1, 2000000)][int]$FileCount = 100000,
    [ValidateRange(1, 200000)][int]$FolderCount = 10000,
    [ValidateRange(0, 1099511627776)][long]$SparseLargeFileBytes = 0,
    [switch]$AllowNonEmpty
)

$target = [System.IO.Path]::GetFullPath($Destination).TrimEnd('\')
$root = [System.IO.Path]::GetPathRoot($target).TrimEnd('\')
$profile = [System.IO.Path]::GetFullPath([Environment]::GetFolderPath('UserProfile')).TrimEnd('\')

if ($target -eq $root -or $target -eq $profile) {
    throw "Refusing unsafe fixture destination: $target"
}
if (Test-Path -LiteralPath $target) {
    $hasContent = Get-ChildItem -LiteralPath $target -Force | Select-Object -First 1
    if ($hasContent -and -not $AllowNonEmpty) {
        throw "Destination is not empty. Use -AllowNonEmpty only after verifying the exact path: $target"
    }
} else {
    New-Item -ItemType Directory -Path $target | Out-Null
}

Write-Host "Generating $FileCount files across $FolderCount folders in $target"
for ($folderIndex = 0; $folderIndex -lt $FolderCount; $folderIndex++) {
    $folder = Join-Path $target ("folder-{0:D6}" -f $folderIndex)
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
}

for ($fileIndex = 0; $fileIndex -lt $FileCount; $fileIndex++) {
    $folderIndex = $fileIndex % $FolderCount
    $folder = Join-Path $target ("folder-{0:D6}" -f $folderIndex)
    $file = Join-Path $folder ("asset-{0:D8}.txt" -f $fileIndex)
    [System.IO.File]::WriteAllText($file, "fixture $fileIndex")
    if (($fileIndex + 1) % 10000 -eq 0) {
        Write-Progress -Activity 'Generating scale fixture' -Status "$($fileIndex + 1) / $FileCount" -PercentComplete ((($fileIndex + 1) * 100) / $FileCount)
    }
}

if ($SparseLargeFileBytes -gt 0) {
    $largePath = Join-Path $target 'sparse-large-file.bin'
    $stream = [System.IO.File]::Open($largePath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try { $stream.SetLength($SparseLargeFileBytes) } finally { $stream.Dispose() }
}

Write-Progress -Activity 'Generating scale fixture' -Completed
Write-Host "Fixture complete: $target"
