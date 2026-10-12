param([Parameter(Mandatory=$true)][string]$Url, [string]$Destination, [int]$Start = -1, [int]$End = -1)
$ErrorActionPreference = 'Stop'
if ($Start -lt 0) {
  $response = Invoke-WebRequest -Method Head -Uri $Url -TimeoutSec 30
  Write-Output $response.Headers['Content-Length'][0]
} else {
  Invoke-WebRequest -Uri $Url -Headers @{ Range = "bytes=$Start-$End" } -OutFile $Destination -TimeoutSec 90
}
