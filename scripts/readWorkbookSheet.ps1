param(
  [Parameter(Mandatory = $true)]
  [string]$WorkbookPath,

  [Parameter(Mandatory = $true)]
  [string]$SheetName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-EntryText {
  param(
    [Parameter(Mandatory = $true)]
    [System.IO.Compression.ZipArchive]$Archive,

    [Parameter(Mandatory = $true)]
    [string]$EntryName
  )

  $entry = $Archive.Entries | Where-Object { $_.FullName -eq $EntryName } | Select-Object -First 1
  if (-not $entry) {
    return $null
  }

  $streamReader = New-Object System.IO.StreamReader($entry.Open())
  try {
    return $streamReader.ReadToEnd()
  } finally {
    $streamReader.Dispose()
  }
}

function Get-CellValue {
  param(
    [Parameter(Mandatory = $true)]
    [System.Xml.XmlElement]$CellNode,

    [Parameter(Mandatory = $true)]
    [System.Collections.Generic.List[string]]$SharedStrings,

    [Parameter(Mandatory = $true)]
    [System.Xml.XmlNamespaceManager]$NamespaceManager
  )

  $cellType = $CellNode.GetAttribute('t')
  $valueNode = $CellNode.SelectSingleNode('./d:v', $NamespaceManager)
  if ($valueNode) {
    $rawValue = $valueNode.InnerText
    if ($cellType -eq 's') {
      $index = [int]$rawValue
      if ($index -ge 0 -and $index -lt $SharedStrings.Count) {
        return $SharedStrings[$index]
      }
      return ''
    }
    return $rawValue
  }

  $inlineNode = $CellNode.SelectSingleNode('./d:is', $NamespaceManager)
  if (-not $inlineNode) {
    return ''
  }

  $textNodes = $inlineNode.SelectNodes('.//d:t', $NamespaceManager)
  if (-not $textNodes) {
    return ''
  }

  return (($textNodes | ForEach-Object { $_.InnerText }) -join '')
}

$fileStream = [System.IO.File]::Open(
  $WorkbookPath,
  [System.IO.FileMode]::Open,
  [System.IO.FileAccess]::Read,
  [System.IO.FileShare]::ReadWrite
)

$zipArchive = New-Object System.IO.Compression.ZipArchive(
  $fileStream,
  [System.IO.Compression.ZipArchiveMode]::Read,
  $false
)

try {
  $workbookXml = Get-EntryText -Archive $zipArchive -EntryName 'xl/workbook.xml'
  $workbookRelationshipsXml = Get-EntryText -Archive $zipArchive -EntryName 'xl/_rels/workbook.xml.rels'
  $sharedStringsXml = Get-EntryText -Archive $zipArchive -EntryName 'xl/sharedStrings.xml'

  if (-not $workbookXml -or -not $workbookRelationshipsXml) {
    throw "Unable to read workbook metadata from '$WorkbookPath'."
  }

  $workbookDocument = New-Object System.Xml.XmlDocument
  $workbookDocument.LoadXml($workbookXml)

  $relationshipDocument = New-Object System.Xml.XmlDocument
  $relationshipDocument.LoadXml($workbookRelationshipsXml)

  $workbookNs = New-Object System.Xml.XmlNamespaceManager($workbookDocument.NameTable)
  $workbookNs.AddNamespace('d', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')

  $relationshipNs = New-Object System.Xml.XmlNamespaceManager($relationshipDocument.NameTable)
  $relationshipNs.AddNamespace('r', 'http://schemas.openxmlformats.org/package/2006/relationships')

  $sharedStrings = New-Object 'System.Collections.Generic.List[string]'
  if ($sharedStringsXml) {
    $sharedStringsDocument = New-Object System.Xml.XmlDocument
    $sharedStringsDocument.LoadXml($sharedStringsXml)

    $sharedNs = New-Object System.Xml.XmlNamespaceManager($sharedStringsDocument.NameTable)
    $sharedNs.AddNamespace('d', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')

    foreach ($sharedStringItem in $sharedStringsDocument.SelectNodes('//d:si', $sharedNs)) {
      $textNodes = $sharedStringItem.SelectNodes('.//d:t', $sharedNs)
      if ($textNodes) {
        $sharedStrings.Add((($textNodes | ForEach-Object { $_.InnerText }) -join ''))
      } else {
        $sharedStrings.Add('')
      }
    }
  }

  $sheetNode = $workbookDocument.SelectSingleNode("//d:sheets/d:sheet[@name=""$SheetName""]", $workbookNs)
  if (-not $sheetNode) {
    throw "Sheet '$SheetName' was not found in '$WorkbookPath'."
  }

  $relationshipId = $sheetNode.GetAttribute('id', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')
  $relationshipNode = $relationshipDocument.SelectSingleNode("//r:Relationship[@Id='$relationshipId']", $relationshipNs)
  if (-not $relationshipNode) {
    throw "Unable to resolve sheet relationship '$relationshipId' for '$SheetName'."
  }

  $sheetTarget = $relationshipNode.GetAttribute('Target')
  $sheetPath = if ($sheetTarget.StartsWith('/')) {
    $sheetTarget.TrimStart('/')
  } else {
    'xl/' + $sheetTarget.TrimStart('/')
  }

  $sheetXml = Get-EntryText -Archive $zipArchive -EntryName $sheetPath
  if (-not $sheetXml) {
    throw "Unable to read sheet XML for '$SheetName'."
  }

  $sheetDocument = New-Object System.Xml.XmlDocument
  $sheetDocument.LoadXml($sheetXml)

  $sheetNs = New-Object System.Xml.XmlNamespaceManager($sheetDocument.NameTable)
  $sheetNs.AddNamespace('d', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')

  $rows = New-Object 'System.Collections.Generic.List[object]'

  foreach ($rowNode in $sheetDocument.SelectNodes('//d:sheetData/d:row', $sheetNs)) {
    $cells = [ordered]@{}

    foreach ($cellNode in $rowNode.SelectNodes('./d:c', $sheetNs)) {
      $cellReference = $cellNode.GetAttribute('r')
      $columnReference = $cellReference -replace '\d', ''
      $cells[$columnReference] = Get-CellValue -CellNode $cellNode -SharedStrings $sharedStrings -NamespaceManager $sheetNs
    }

    $rows.Add([pscustomobject]@{
        rowNumber = [int]$rowNode.GetAttribute('r')
        cells     = [pscustomobject]$cells
      })
  }

  [pscustomobject]@{
    workbookPath = $WorkbookPath
    sheetName    = $SheetName
    rows         = $rows
  } | ConvertTo-Json -Depth 8 -Compress
} finally {
  if ($zipArchive) {
    $zipArchive.Dispose()
  }
  $fileStream.Dispose()
}
